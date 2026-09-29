// The dispatcher: walk the listed commands and hand each one that really runs to its judge.
//
// The lister (../shell.mjs) says WHAT is written and WHERE; the judges (./judges.mjs) say whether
// a given command destroys work git cannot give back. This file is the bridge. For every command
// the lister found, it works out the program that actually runs (past the wrappers ../commands.mjs
// knows; through `sh -c`, `eval`, `trap`, a heredoc or a pipe fed to a shell, a function call; and,
// for `xargs` and `find -exec`, from where the arguments come), then calls that program's judge.
// Every command is walked and every loss is kept, so one reason names all of them. Nothing here
// judges a path or asks git; it only decides who to ask, and where. For the where, it reads the
// disk twice: whether a `cd` target is there, and where a `cd -P` lands.
//
// Two things it tracks as it walks, because they change what a later command touches:
//   * the directory. `cd wip && rm -rf deep` is judged in wip. A `cd` the shell may not take (the
//     right side of `&&`/`||`, an `if` or loop body, a target that is not on disk) leaves BOTH
//     places in play, and a later delete is judged in each, because the union never misses. A
//     `cd` in a child shell (`( … )`, a pipeline stage, an `&` job) moves nothing outside it.
//     `cd -`, a bare `cd`, `pushd` and `popd` are followed. The place is kept as the shell
//     keeps it, by name: after `cd link`, `cd ..` is the directory holding the link, and `cd -P`
//     is the one the link points to. `set -P` makes every `cd` of that shell go there, until
//     `set +P`, in the shells that inherit it: a subshell does, a `bash -c` does not.
//   * variables. `S=wip; rm -rf $S` is judged against wip. A loop variable takes each of its
//     values; `find … -exec sh -c 'rm "$1"' _ {} \;` hands the payload each file the find matches.
//     A value this guard cannot know (`read`, `$(git diff)`) is left for the judge, which judges
//     where the command runs rather than guessing it names nothing.

import { statSync } from "node:fs";
import { basename, relative as relativePath, resolve as resolvePath } from "node:path";

import { CD, FIND_EXEC, MAX_PEEL, RM_LIKE, SHELLS, peel } from "../commands.mjs";
import { guards } from "../shell.mjs";
import { absolute, realOrSelf } from "./paths.mjs";

const MAX_DEPTH = 16; // payloads within payloads; past this the payload is judged where it runs
const MAX_PLACES = 8; // directories a command may be running in, after uncertain `cd`s
const UNKNOWN = Symbol("unknown"); // a variable whose value is set at run time
const EXPANDED = { glob: false, split: false, brace: false, quoted: true }; // a word the shell has already expanded
const MANY = Symbol("many"); // a program word with more readings than MAX_PLACES: judged where it runs

const XARGS_VALUED = new Set([
  "-a", "--arg-file", "-n", "--max-args", "-P", "--max-procs", "-L", "-s", "--max-chars",
  "-d", "--delimiter", "-E", "-I",
]); // prettier-ignore

/**
 * @typedef {string | string[] | typeof UNKNOWN} Value a variable's value, or each value it may hold
 * @typedef {{ chain: import("../shell.mjs").ListLink[], to: string[] }} Pending a `cd` to a directory
 *   that is not there now: commands it guards with `&&` run only if it succeeded, so only there
 * @typedef {boolean | "maybe"} Physical whether the shell's `cd` goes where a link points (`set -P`)
 * @typedef {{ places?: string[], prev?: string[], stack?: string[][], vars?: Map<string, Value>, pending?: Pending, physical?: Physical }} ScopeState
 */

/**
 * @param {import("../shell.mjs").Listing} listing  from listCommands(command)
 * @param {object} ctx
 * @param {string} ctx.cwd        the session's working directory
 * @param {string} ctx.agentId    "" on the main thread
 * @param {AbortSignal} [ctx.signal]
 * @param {typeof import("../shell.mjs")} ctx.shell   { listCommands, resolveWord, expandWord }
 * @param {typeof import("./judges.mjs")} ctx.judges
 * @returns {Promise<import("../runner.mjs").Verdict | null>}
 */
export async function dispatch(listing, ctx) {
  const call = {
    agentId: ctx.agentId,
    signal: ctx.signal,
    shell: ctx.shell,
    judges: ctx.judges,
    verdicts: [],
    singles: [], // one-file deletes, each exempt alone and judged together once there are two
    functions: new Map(),
    before: [],
    made: new Set(), // directories an earlier `mkdir` in this call creates
  };
  await walk(listing.events, { places: [ctx.cwd], vars: new Map(), depth: 0, physical: false, uncertain: false }, call, null);
  if (call.singles.length > 1) {
    call.verdicts.push(await call.judges.oneFileDeletes(call.singles, contextFor(ctx.cwd, call, {})));
  }
  return call.judges.merged(call.verdicts.filter(Boolean), call.agentId);
}

/**
 * Walk one command list in source order, from `seed`. Returns where the list leaves its top level,
 * which `eval`, `source` and a function call hand back to their caller.
 *
 * @param {Array<import("../shell.mjs").Command | import("../shell.mjs").Assignment | import("../shell.mjs").LoopVar | import("../shell.mjs").FunctionDef>} events
 * @param {{ places: string[], vars: Map<string, Value>, depth: number, physical: Physical }} seed
 * @param {object} call  the state of the whole Bash call
 * @param {number | null} fn  walk the body of this function, or the top level when null
 * @param {number[]} [top] the scope the list's own statements sit in (a function body's)
 * @returns {Promise<{ places: string[], vars: Map<string, Value>, physical: Physical }>}
 */
async function walk(events, seed, call, fn, top = []) {
  /** @type {Map<string, ScopeState>} */ const scopes = new Map();
  const keyOf = (scope) => scope.join("\u0000");
  const own = (scope) => {
    const k = keyOf(scope);
    if (!scopes.has(k)) scopes.set(k, {});
    return scopes.get(k);
  };
  // The nearest scope, innermost first, that set `field`; else the seed's.
  const nearest = (scope, field, fallback) => {
    for (let i = scope.length; i >= 0; i -= 1) {
      const state = scopes.get(keyOf(scope.slice(0, i)));
      if (state?.[field] !== undefined) return state[field];
    }
    return fallback;
  };
  // Where a command in `scope` runs. After a `cd` to a directory that is not there now, a command
  // it guards (`cd dir && rm …`) runs only if the cd succeeded, so only in dir; any other runs in
  // either place.
  const placesAt = (scope, event = null) => {
    const pending = nearest(scope, "pending", null);
    if (pending && event && guards(pending.chain, event.chain ?? [])) return pending.to;
    return nearest(scope, "places", seed.places);
  };
  const varsAt = (scope) => {
    const merged = new Map(seed.vars);
    for (let i = 0; i <= scope.length; i += 1) {
      for (const [name, value] of scopes.get(keyOf(scope.slice(0, i)))?.vars ?? []) merged.set(name, value);
    }
    return merged;
  };
  const setVar = (scope, name, value, conditional) => {
    const state = own(scope);
    state.vars ??= new Map();
    // A conditional assignment may not happen: the variable holds either value. One never set
    // before expands to nothing.
    if (conditional) value = union(varsAt(scope).get(name) ?? "", value);
    state.vars.set(name, value);
  };
  const physicalAt = (scope) => nearest(scope, "physical", seed.physical);
  // A setting that may not have been made (`if …; then set -P; fi`) leaves both readings in play.
  const setPhysical = (scope, mode, conditional) => {
    own(scope).physical = conditional && mode !== physicalAt(scope) ? "maybe" : mode;
  };
  // What an `eval` or a function call left behind, applied to the caller's scope.
  const carry = (scope, after, places, vars, conditional) => {
    if (after.physical !== physicalAt(scope)) setPhysical(scope, after.physical, conditional);
    if (after.places !== places) moveTo(scope, after.places, conditional);
    for (const [name, value] of after.vars) if (vars.get(name) !== value) setVar(scope, name, value, conditional);
  };
  const moveTo = (scope, places, conditional, chain = null) => {
    const state = own(scope);
    const current = placesAt(scope);
    state.prev = current;
    state.places = dedupe(conditional ? [...current, ...places] : places, MAX_PLACES);
    state.pending = conditional && chain ? { chain, to: places } : undefined;
  };

  for (const event of events) {
    if ((event.fn ?? null) !== fn) continue; // a function body runs where it is called
    if (event.kind === "function") {
      call.functions.set(event.name, { id: event.id, events, scope: [...event.scope, event.id] });
      continue;
    }
    const scope = event.scope;
    const places = placesAt(scope, event);
    const vars = varsAt(scope);

    if (event.kind === "assignment") {
      setVar(scope, event.name, textOf(call, event.value, places[0], vars), event.conditional);
      continue;
    }
    if (event.kind === "loopvar") {
      setVar(scope, event.name, loopValues(call, event, places[0], vars), false);
      continue;
    }

    const peeled = peel(event.argv);
    // A program word holding a variable is what the variable holds, once for each value it may hold.
    const readings = peeled ? programReadings(peeled, event, vars, places[0], call) : [];
    // What ran earlier in this call, as text, for judges whose answer depends on it (a stash
    // dropped after a stash, a delete after a `git add`). An unreadable word is kept as written.
    // A save that may not run (after `&&`, `||`, in an `if`, a function called that way, a trap) saves
    // nothing a later delete can rely on; one that ran in a known place is read from that place.
    const ran = readings[0]?.peeled.argv ?? event.argv;
    call.before.push({
      argv: ran.map((w) => {
        const t = textOf(call, w, places[0], vars);
        return typeof t === "string" ? t : w;
      }),
      certain: !event.conditional && !seed.uncertain,
      base: places.length === 1 ? places[0] : null,
    });
    // No reading: a lookup, or a wrapper with nothing after it. Nothing runs.
    for (const { peeled, command } of readings) {
      const argv = peeled.argv;
      const program = basename(argv[0] ?? "");
      const prefix = [...command.prefix, ...peeled.prefix];

      if (peeled.capped || peeled.many) {
        const what = peeled.capped ? "a command behind more wrappers than this guard follows" : "a program named by a variable with more values than this guard follows";
        for (const place of places) call.verdicts.push(await call.judges.whereItRuns(what, contextFor(place, call, { vars })));
        continue;
      }
      if (call.functions.has(program)) {
        const body = call.functions.get(program);
        if (seed.depth < MAX_DEPTH) {
          const inside = { places, vars, depth: seed.depth + 1, physical: physicalAt(scope), uncertain: seed.uncertain || command.conditional };
          const after = await walk(body.events, inside, call, body.id, body.scope);
          carry(scope, after, places, vars, command.conditional);
        }
        continue;
      }
      if (CD.has(program)) {
        const target = cdTarget(argv, own(scope), places, (w) => textOf(call, w, places[0], vars), call.made, physicalAt(scope));
        if (target) moveTo(scope, target.places, command.conditional || target.uncertain, command.chain);
        continue;
      }
      if (program === "set") {
        const mode = physicalSetting(argv);
        if (mode !== null) setPhysical(scope, mode, command.conditional);
        continue;
      }
      if (program === "mkdir") {
        for (const word of argv.slice(1).filter((w) => !w.startsWith("-"))) {
          const t = textOf(call, word, places[0], vars);
          if (typeof t === "string") for (const place of places) call.made.add(resolvePath(place, t));
        }
      }
      if (program === "unset" || program === "read" || program === "mapfile" || program === "readarray" || (program === "printf" && argv.includes("-v"))) {
        for (const [name, value] of setsAtRunTime(program, argv)) setVar(scope, name, value, command.conditional);
        continue;
      }

      const bases = places.flatMap((place) => {
        let dir = place;
        for (const d of peeled.chdir) {
          const t = textOf(call, d, dir, vars);
          if (typeof t !== "string") return [];
          dir = resolvePath(dir, t);
        }
        return [dir];
      });
      for (const base of bases) {
        const ctx = contextFor(base, call, { vars, prefix, shapes: shapesOf(command) });
        const s = { call, vars, depth: seed.depth, prefix, physical: physicalAt(scope), uncertain: seed.uncertain || command.conditional };
        const verdict = await dispatchCommand(command, argv, ctx, s);
        if (verdict?.propagate) carry(scope, verdict.propagate, places, vars, command.conditional);
        else if (verdict) call.verdicts.push(verdict);
      }
    }
  }
  return { places: placesAt(top), vars: varsAt(top), physical: physicalAt(top) };
}

/**
 * The command as it runs when its program word names variables this guard knows: `R=rm; $R -rf wip`
 * runs rm. The word is expanded and what it becomes is peeled again, so a wrapper held in a variable
 * is still a wrapper (`W=sudo; $W rm …`), and `R='rm -rf'; $R wip` splits as the shell splits it. A
 * variable that may hold several values (set in a branch, a loop variable) gives one reading for
 * each, at most MAX_PLACES. A word that depends on a value set at run time (`read`, `$(…)`) stays as
 * written, and no judge claims it: a program name the text does not spell is a documented floor.
 *
 * @param {import("../commands.mjs").Peeled} peeled
 * @returns {Array<{ peeled: import("../commands.mjs").Peeled, command: object }>}
 */
function programReadings(peeled, event, vars, cwd, call) {
  let readings = [{ peeled, command: event }];
  for (let round = 0; round < MAX_PEEL; round += 1) {
    const next = [];
    let expanded = false;
    for (const reading of readings) {
      const word = reading.peeled.argv[0];
      const values = word?.includes("$") ? programWords(word, reading.command, vars, cwd, call) : null;
      if (values === null) {
        next.push(reading);
        continue;
      }
      if (values === MANY) return [{ peeled: { ...peeled, many: true }, command: event }];
      expanded = true;
      for (const words of values) {
        const again = peel([...words, ...reading.peeled.argv.slice(1)]);
        if (!again) continue; // `R=command; $R -v rm` looks something up and runs nothing
        const command = {
          ...reading.command,
          argv: [...reading.command.argv, ...words],
          shapes: [...(reading.command.shapes ?? []), ...words.map(() => EXPANDED)],
        };
        const merged = {
          argv: again.argv,
          prefix: [...reading.peeled.prefix, ...again.prefix],
          chdir: [...reading.peeled.chdir, ...again.chdir],
          capped: reading.peeled.capped || again.capped,
        };
        next.push({ peeled: merged, command });
      }
    }
    if (next.length > MAX_PLACES) return [{ peeled: { ...peeled, many: true }, command: event }];
    readings = next;
    if (!expanded) break;
  }
  return readings;
}

/**
 * The words a program word becomes, once for each value its variables may hold, MANY when that is more
 * readings than this guard follows, or null when the word cannot be read (a value set at run time
 * reaches `expandWord` as unreadable, and so does `$(…)`).
 */
function programWords(word, command, vars, cwd, call) {
  const names = [...new Set([...word.matchAll(/\$\{?([A-Za-z_]\w*)/g)].map((m) => m[1]))];
  const base = plainVars(vars);
  // `$@` and `$*` hold every word, all at once: not one reading per word.
  for (const all of ["@", "*"]) if (Array.isArray(vars.get(all))) base.set(all, vars.get(all));
  let bindings = [base];
  for (const name of names) {
    const value = vars.get(name);
    if (name === "@" || name === "*" || !Array.isArray(value)) continue;
    bindings = bindings.flatMap((b) => value.map((v) => new Map(b).set(name, v)));
    if (bindings.length > MAX_PLACES) return MANY;
  }
  const shape = command.shapes?.[command.argv.indexOf(word)];
  const out = [];
  for (const binding of bindings) {
    const { fields, unknown } = call.shell.expandWord(word, shape, { cwd, vars: binding });
    if (unknown) return null;
    out.push(fields.map((f) => f.text));
  }
  return out;
}

/**
 * The judge's view of one place: how to read a word there, and what came before.
 *
 * @returns {import("./judges.mjs").Context}
 */
function contextFor(base, call, { vars = new Map(), prefix = [], shapes = new Map() }) {
  const plain = plainVars(vars);
  return {
    base,
    agentId: call.agentId,
    signal: call.signal,
    before: call.before,
    prefix,
    singles: call.singles,
    resolve: (word) => call.shell.resolveWord(word, { cwd: base, vars: plain }),
    expand: (word) => call.shell.expandWord(word, shapes.get(word), { cwd: base, vars: multiVars(vars) }),
  };
}

/**
 * One command, already peeled of wrapper words: call its program's judge, or walk a payload it
 * runs. Returns a verdict, `{ propagate }` when the command changes the caller's shell (`eval`,
 * `source`), or null.
 */
async function dispatchCommand(event, argv, ctx, s) {
  const program = basename(argv[0] ?? "");

  if (SHELLS.has(program)) {
    const payload = shellPayload(argv, event, s.call);
    if (payload === null) return null;
    // A child shell gets the variables the command exports to it (its prefix), and its own
    // positional parameters: `sh -c 'rm "$1"' _ file`.
    const vars = new Map([...s.vars, ...ctxPrefixVars(ctx, s)]);
    for (const [name, value] of payload.positional) vars.set(name, value);
    return recurse(payload.text, ctx, { ...s, vars, physical: false }); // a new shell: `set -P` is not inherited
  }
  if (program === "eval") {
    if (argv.length < 2) return null;
    // eval joins its arguments with spaces and runs the result in THIS shell, as bash does. A
    // single argument is the script verbatim, so a part the grammar cannot parse is a real
    // unknown; several arguments rejoined here may lose quoting bash kept, and a malformed eval
    // string errors and runs nothing, so that is not asked about.
    return recurse(argv.slice(1).join(" "), ctx, s, { askOnUnparsed: argv.length === 2, propagate: true });
  }
  if (program === "trap") {
    // `trap 'rm -rf wip' EXIT` runs its string when the shell exits.
    const i = argv[1] === "--" ? 2 : 1;
    if (argv[i] === undefined || argv[i] === "-" || argv[i].startsWith("-") || argv.length <= i + 1) return null;
    return recurse(argv[i], ctx, { ...s, uncertain: true }); // it runs at the end: nothing after it relies on it
  }
  if (program === "xargs") return xargsDispatch(argv, event, ctx, s);
  if (RM_LIKE.has(program)) return s.call.judges.rm(argv, ctx);
  if (program === "find") return findDispatch(argv, ctx, s);
  if (program === "git") return s.call.judges.git(argv, ctx);
  return null;
}

/** The prefix a command exports to what it runs, as variables. */
function ctxPrefixVars(ctx, s) {
  return (ctx.prefix ?? []).map(([name, value]) => [name, textOf(s.call, value, ctx.base, s.vars)]);
}

/**
 * List and walk a payload (`sh -c …`, `eval …`, a heredoc), from this command's place and
 * variables. `askOnUnparsed` judges where it runs when part of it cannot be parsed (a command
 * bash may still run). `propagate` hands the payload's final directory and variables back.
 */
async function recurse(text, ctx, s, { askOnUnparsed = true, propagate = false } = {}) {
  if (s.depth + 1 >= MAX_DEPTH) {
    return s.call.judges.whereItRuns("a command nested deeper than this guard follows", ctx);
  }
  const listing = await s.call.shell.listCommands(text);
  const inside = { places: [ctx.base], vars: new Map(s.vars), depth: s.depth + 1, physical: s.physical ?? false, uncertain: s.uncertain ?? false };
  const after = await walk(listing.events, inside, s.call, null);
  if (askOnUnparsed && listing.hasError) {
    s.call.verdicts.push(await s.call.judges.whereItRuns("a command this guard cannot fully parse", ctx));
  }
  return propagate ? { propagate: after } : null;
}

/**
 * A `find`. An `-exec` that runs a shell has its script walked with `{}` (and `$0`, `$1`, `$@`)
 * standing for each file the find matches; an `-exec git …` is handed to the git judge with those
 * files as its pathspecs; anything else, a plain `-exec rm` or `-delete` included, goes to the find
 * judge, which dry-runs it.
 */
async function findDispatch(argv, ctx, s) {
  const clauses = execClauses(argv);
  const special = clauses.filter((c) => SHELLS.has(basename(c.argv[0] ?? "")) || basename(c.argv[0] ?? "") === "git");
  if (special.length === 0) return s.call.judges.find(unwrapExec(argv), ctx);
  const matches = await s.call.judges.findMatches(withoutExec(argv), ctx);
  for (const clause of special) {
    const program = basename(clause.argv[0]);
    if (program === "git") {
      const args = matches === null ? [...clause.argv.filter((w) => w !== "{}"), ...UNKNOWN_PATHSPEC] : clause.argv.flatMap((w) => (w === "{}" ? matches : [w]));
      s.call.verdicts.push(await s.call.judges.git(args, ctx));
      continue;
    }
    const payload = shellPayload(clause.argv, {}, s.call, { "{}": matches ?? UNKNOWN });
    if (payload === null) continue;
    const vars = new Map(s.vars);
    for (const [name, value] of payload.positional) vars.set(name, value);
    // find substitutes `{}` inside the script too (GNU find, when it is not its own word as well).
    // It stands for each match; when the matches cannot be listed, for a word this guard cannot read.
    vars.set("__find_match", matches ?? UNKNOWN);
    await recurse(payload.text.replaceAll("{}", '"${__find_match}"'), ctx, { ...s, vars, physical: false });
  }
  // Clauses that are neither (a plain `-exec rm`, `-delete`) are still the find judge's.
  const rest = clauses.some((c) => !special.includes(c)) || argv.includes("-delete");
  return rest ? s.call.judges.find(unwrapExec(withoutClauses(argv, special)), ctx) : null;
}

// A pathspec this guard cannot read: the git judge treats it as naming the whole tree, with the
// mode the command's flags imply.
const UNKNOWN_PATHSPEC = ["--", "${__unreadable_pathspec}"];

/**
 * An `xargs`: work out where its arguments come from, then judge the command it runs with them.
 */
async function xargsDispatch(argv, event, ctx, s) {
  let i = 1;
  let file = null;
  let replacement = null;
  let nul = false;
  while (i < argv.length && argv[i].startsWith("-")) {
    const a = argv[i];
    if (a === "-a" || a === "--arg-file") { file = argv[i + 1]; i += 2; continue; }
    if (a.startsWith("--arg-file=")) { file = a.slice("--arg-file=".length); i += 1; continue; }
    if (a === "-I") { replacement = argv[i + 1]; i += 2; continue; } // -I R (a value follows)
    if (a.startsWith("-I")) { replacement = a.slice(2); i += 1; continue; } // -I{}
    if (a.startsWith("--replace=")) { replacement = a.slice("--replace=".length) || "{}"; i += 1; continue; }
    if (a === "-i" || a === "--replace") { replacement = "{}"; i += 1; continue; } // optional value only
    if (a === "-0" || a === "--null") nul = true;
    i += XARGS_VALUED.has(a) ? 2 : 1;
  } // prettier-ignore

  const peeled = peel(argv.slice(i));
  if (!peeled) return null;
  const command = peeled.argv;
  const program = basename(command[0] ?? "");
  const feed = feedOf(event, file, s.call);
  const perLine = replacement !== null;

  if (RM_LIKE.has(program)) {
    // The replacement token stands for the piped-in argument, not an operand of its own. Inside a
    // longer word (`wip/{}`) it still does, so that word is one this guard cannot read.
    const operands = command.map((w) => (replacement !== null && w !== replacement && w.includes(replacement) ? "${__xargs_item}" : w));
    const fixed = operands.filter((w) => w !== replacement);
    return s.call.judges.pipeFedRm(fixed, feed, ctx, { perLine, nul });
  }
  const items = await s.call.judges.feedItems(feed, ctx, { perLine, nul });
  if (SHELLS.has(program)) {
    const payload = shellPayload(command, {}, s.call, replacement !== null ? { [replacement]: items ?? UNKNOWN } : {});
    if (payload === null) return null;
    const vars = new Map(s.vars);
    for (const [name, value] of payload.positional) vars.set(name, value);
    // Without -I, xargs appends its items after the command's own words: they are `$1`, `$@`.
    if (replacement === null) {
      const at = payload.positional.length === 0 ? 1 : payload.positional.length;
      vars.set(String(at), items ?? UNKNOWN);
      vars.set("@", items ?? UNKNOWN);
      vars.set("*", items ?? UNKNOWN);
    }
    let text = payload.text;
    if (replacement !== null && text.includes(replacement)) {
      text = text.replaceAll(replacement, '"${__xargs_item}"');
      vars.set("__xargs_item", items ?? UNKNOWN);
    }
    return recurse(text, ctx, { ...s, vars, physical: false });
  }
  if (program === "git") {
    const args = items === null ? [...command.filter((w) => w !== replacement), ...UNKNOWN_PATHSPEC] : [...command.filter((w) => w !== replacement), ...items];
    return s.call.judges.git(args, ctx);
  }
  return null;
}

/**
 * Where an `xargs` reads its arguments from.
 *
 * @returns {import("./judges.mjs").Feed}
 */
function feedOf(event, file, call) {
  if (file) return { kind: "file", path: file };
  if (event.stdinFile && !event.stdinFile.startsWith("<(")) return { kind: "file", path: event.stdinFile };
  if (event.heredoc !== null && event.heredoc !== undefined) return { kind: "text", text: event.heredoc };
  const feeder = event.feederCommand;
  if (!feeder) return { kind: "unknown" };
  const tool = basename(feeder.argv[0] ?? "");
  if (tool === "find") return { kind: "find", argv: feeder.argv };
  const printed = printedBy(feeder, call);
  if (printed !== null) return { kind: "text", text: printed };
  if (tool === "cat" && feeder.argv.length === 2 && !feeder.argv[1].startsWith("-")) return { kind: "file", path: feeder.argv[1] };
  return { kind: "unknown" };
}

/**
 * The text a command prints when that can be read from the command itself: `echo`'s arguments,
 * `printf`'s format when it has no `%` and no escapes, `cat` of a heredoc, and what `tee` passes
 * through from its own feeder. Null otherwise.
 */
function printedBy(command, call, depth = 0) {
  if (!command || depth > 8) return null;
  const tool = basename(command.argv[0] ?? "");
  if (tool === "echo") {
    const args = command.argv.slice(1);
    let escapes = false;
    while (args.length > 0 && /^-[neE]+$/.test(args[0])) {
      if (args[0].includes("e")) escapes = true;
      args.shift();
    }
    const text = args.join(" ");
    return escapes ? decodeEcho(text) : text;
  }
  if (tool === "printf") {
    const format = command.argv[1];
    if (command.argv.length === 2 && format !== undefined && !/[%\\]/.test(format)) return format;
    return null;
  }
  if (tool === "cat" && command.argv.length === 1) {
    if (command.heredoc !== null && command.heredoc !== undefined) return command.heredoc;
    return printedBy(command.feederCommand, call, depth + 1);
  }
  if (tool === "tee") return printedBy(command.feederCommand, call, depth + 1);
  return null;
}

/** `echo -e`'s backslash escapes, the ones that change what a shell reads. */
function decodeEcho(text) {
  return text.replace(/\\([ntr\\0]|x[0-9a-fA-F]{1,2}|0[0-7]{1,3})/g, (_, esc) => {
    if (esc === "n") return "\n";
    if (esc === "t") return "\t";
    if (esc === "r") return "\r";
    if (esc === "\\") return "\\";
    if (esc[0] === "x") return String.fromCharCode(Number.parseInt(esc.slice(1), 16));
    if (esc[0] === "0") return String.fromCharCode(Number.parseInt(esc.slice(1) || "0", 8));
    return esc;
  });
}

/**
 * The script a shell runs and its positional parameters: the argument after `-c` (which may be
 * one flag of a cluster, `-ce`), else a heredoc or here-string fed to it, else what its feeder
 * prints (`echo`, `cat <<EOF`, through `tee`). A shell handed a script FILE is not read: its path
 * is not the script text. `-s` makes the operands arguments, not a file.
 *
 * @param {string[]} argv  the shell command, wrappers already peeled
 * @param {import("../shell.mjs").Command | {}} event
 * @param {object} call
 * @param {Record<string, Value>} [tokens] words that stand for fed-in values (`{}`)
 * @returns {{ text: string, positional: Array<[string, Value]> } | null}
 */
function shellPayload(argv, event, call, tokens = {}) {
  let i = 1;
  let dashC = false;
  let dashS = false;
  for (; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--") { i += 1; break; }
    // `-o pipefail`, `-O extglob` and `--rcfile FILE` take a value; skip it so it is not the script.
    if (/^[-+][oO]$/.test(a) || a === "--rcfile" || a === "--init-file") { i += 1; continue; }
    if (a.startsWith("--")) continue;
    if (/^-[a-zA-Z]*c/.test(a)) { dashC = true; i += 1; break; }
    if (/^-[a-zA-Z]*s/.test(a)) dashS = true;
    if (a.startsWith("-") || a.startsWith("+")) continue;
    break; // the first operand: a script file, unless -s
  } // prettier-ignore
  const valueOf = (w) => (Object.hasOwn(tokens, w) ? tokens[w] : w);
  if (dashC) {
    if (argv[i] === undefined) return null;
    // `sh -c SCRIPT NAME ARG…`: NAME is $0, the rest are $1…, and together "$@".
    const rest = argv.slice(i + 1).map(valueOf);
    return { text: argv[i], positional: positional(rest) };
  }
  const operands = argv.slice(i);
  if (operands.length > 0 && !dashS && operands[0] !== "/dev/stdin" && operands[0] !== "-") return null; // a script file
  const params = positional(["sh", ...(dashS ? operands : operands.slice(1)).map(valueOf)]);
  if (event.heredoc !== null && event.heredoc !== undefined) return { text: event.heredoc, positional: params };
  const printed = printedBy(event.feederCommand, call);
  return printed === null ? null : { text: printed, positional: params };
}

/** `[$0, $1, …]` as variables, with `@` and `*` for `$1…`. */
function positional(words) {
  const out = words.map((w, n) => [String(n), w]);
  const rest = words.slice(1).flatMap((w) => (w === UNKNOWN ? [] : [w].flat()));
  const unknown = words.slice(1).includes(UNKNOWN);
  if (words.length > 1) {
    out.push(["@", unknown ? UNKNOWN : rest], ["*", unknown ? UNKNOWN : rest]);
  }
  return out;
}

/**
 * Where a `cd`/`pushd`/`popd` goes: `{ places, uncertain }`, or null when it stays put (an
 * unreadable target, a `cd -` with nowhere to go back to).
 */
function cdTarget(argv, state, places, textAt, made, mode = false) {
  const program = basename(argv[0]);
  let i = 1;
  let physical = mode; // the shell's setting, unless the cd says: the last of -L and -P wins
  for (; i < argv.length && /^-[LPe@]+$/.test(argv[i]); i += 1) {
    for (const flag of argv[i]) if (flag === "L" || flag === "P") physical = flag === "P";
  }
  if (argv[i] === "--") i += 1;
  const target = argv[i];
  if (program === "popd") {
    const back = state.stack?.pop();
    return back ? { places: back, uncertain: false } : null;
  }
  if (program === "pushd") {
    if (target === undefined || /^[+-]\d+$/.test(target)) return null; // a stack rotation: not followed
    state.stack ??= [];
    state.stack.push(places);
  }
  if (target === undefined) {
    const home = process.env.HOME;
    return home ? { places: [home], uncertain: false } : null;
  }
  if (target === "-") return state.prev ? { places: state.prev, uncertain: false } : null;
  const text = textAt(target);
  if (typeof text !== "string") return null; // unreadable: the tracked directory stays
  // The shell's own `cd` goes by name: after `cd link`, `cd ..` is the directory that holds the
  // link. (A program's operand is resolved by the kernel, through the link: paths.mjs does that.)
  // `cd -P` goes where the link points, so every later step starts from the real directory.
  const byName = places.map((p) => resolvePath(p, text));
  const onDisk = places.map((p) => realOrSelf(absolute(p, text, false)[0]));
  const next = physical === true ? onDisk : physical === "maybe" ? [...new Set([...byName, ...onDisk])] : byName;
  // A `cd` to a directory that is not there fails, and the shell stays where it was. A `$(mktemp -d)`
  // target is made at run time, so it is followed.
  const certain = next.every((p) => isDirectoryNow(p) || made.has(p) || p.includes("mktemp-not-yet-created"));
  return { places: next, uncertain: !certain };
}

/**
 * What a `set` says about physical mode: true for `-P` or `-o physical`, false for `+P` or
 * `+o physical`, null when it says nothing about it.
 */
function physicalSetting(argv) {
  let mode = null;
  for (let i = 1; i < argv.length; i += 1) {
    const word = argv[i];
    if (word === "--" || !/^[-+]/.test(word)) break; // what follows are positional parameters
    if (word === "-o" || word === "+o") {
      if (argv[i + 1] === "physical") mode = word === "-o";
      i += 1;
    } else if (/^[-+][a-zA-Z]*P/.test(word)) mode = word.startsWith("-");
  }
  return mode;
}

function isDirectoryNow(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** The variables `unset`, `read`, `mapfile` / `readarray` and `printf -v` set when they run. */
function setsAtRunTime(program, argv) {
  const names = [];
  if (program === "unset") {
    if (argv.includes("-f")) return [];
    for (const w of argv.slice(1)) if (/^[A-Za-z_]\w*$/.test(w)) names.push([w, ""]);
    return names;
  }
  if (program === "printf") {
    const at = argv.indexOf("-v");
    return argv[at + 1] ? [[argv[at + 1], UNKNOWN]] : [];
  }
  if (program === "read") {
    const valued = new Set(["-a", "-d", "-i", "-n", "-N", "-p", "-t", "-u"]);
    let i = 1;
    for (; i < argv.length && argv[i].startsWith("-"); i += 1) {
      if (argv[i] === "-a" && argv[i + 1]) names.push([argv[i + 1], UNKNOWN]);
      if (valued.has(argv[i])) i += 1;
    }
    const rest = argv.slice(i).filter((w) => /^[A-Za-z_]\w*$/.test(w));
    for (const w of rest.length ? rest : ["REPLY"]) names.push([w, UNKNOWN]);
    return names;
  }
  // mapfile / readarray: the array is the last operand, MAPFILE by default.
  const last = argv.at(-1);
  return [[argv.length > 1 && /^[A-Za-z_]\w*$/.test(last) ? last : "MAPFILE", UNKNOWN]];
}

// ── values ──────────────────────────────────────────────────────────────────────────────────

/** A word's single value here, or UNKNOWN when it depends on run time or holds several values. */
function textOf(call, word, cwd, vars) {
  const r = call.shell.resolveWord(word, { cwd, vars: plainVars(vars) });
  return r.unknown ? UNKNOWN : r.text;
}

/** What a loop variable takes: every field its words expand to, or UNKNOWN. */
function loopValues(call, event, cwd, vars) {
  if (event.values === null) return UNKNOWN;
  const out = [];
  for (let i = 0; i < event.values.length; i += 1) {
    const { fields, unknown } = call.shell.expandWord(event.values[i], event.shapes[i], { cwd, vars: multiVars(vars) });
    if (unknown) return UNKNOWN;
    // As the shell prints them: a relative pattern's matches are relative names.
    for (const field of fields) {
      const matches = field.glob && /[*?[]/.test(field.text) ? call.judges.globbed(cwd, field) : [field.text];
      for (const item of matches.map((m) => (field.text.startsWith("/") || m === field.text ? m : relativePath(cwd, m)))) out.push(item);
    }
  }
  return out;
}

/** Variables for resolveWord: several values or an unknown one become unreadable. */
function plainVars(vars) {
  const out = new Map();
  for (const [name, value] of vars) out.set(name, typeof value === "string" ? value : `\${${name}}`);
  return out;
}

/** Variables for expandWord: a list stands for each of its values; unknown stays unreadable. */
function multiVars(vars) {
  const out = new Map();
  for (const [name, value] of vars) out.set(name, value === UNKNOWN ? `\${${name}}` : value);
  return out;
}

function union(old, value) {
  if (old === UNKNOWN || value === UNKNOWN) return UNKNOWN;
  return dedupe([old, value].flat());
}

/** `list` without repeats; past `cap`, the first `cap` are kept. */
function dedupe(list, cap = Infinity) {
  return [...new Set(list)].slice(0, cap);
}

/** A word's quoting, from the listing: several spellings of one word merge toward expanding more. */
function shapesOf(event) {
  const shapes = new Map();
  (event.argv ?? []).forEach((word, i) => {
    const shape = event.shapes?.[i];
    if (!shape) return;
    const had = shapes.get(word);
    shapes.set(word, had ? { glob: had.glob || shape.glob, split: had.split || shape.split, brace: had.brace || shape.brace, quoted: had.quoted || shape.quoted } : shape);
  });
  return shapes;
}

// ── find ────────────────────────────────────────────────────────────────────────────────────

/** Each `-exec` clause of a `find`, wrapper words peeled, with where it sits. */
function execClauses(argv) {
  const clauses = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (!FIND_EXEC.has(argv[i])) continue;
    let end = i + 1;
    while (end < argv.length && argv[end] !== ";" && argv[end] !== "+") end += 1;
    clauses.push({ start: i, end, argv: peelClause(argv.slice(i + 1, end)) });
    i = end;
  }
  return clauses;
}

/** A `find` with every `-exec` clause removed: what it would match. */
function withoutExec(argv) {
  return withoutClauses(argv, execClauses(argv)).filter((w) => w !== "-delete");
}

function withoutClauses(argv, clauses) {
  const drop = new Set();
  for (const c of clauses) for (let j = c.start; j <= Math.min(c.end, argv.length - 1); j += 1) drop.add(j);
  return argv.filter((_, j) => !drop.has(j));
}

/**
 * A `find` argv with every `-exec` clause's own wrapper words removed, so the clause starts with
 * the program it really runs: `-exec sudo rm {}` becomes `-exec rm {}` and `-exec xargs rm {}`
 * becomes `-exec rm {}`, which is what the find judge reads to see the delete.
 */
function unwrapExec(argv) {
  const out = [];
  for (let i = 0; i < argv.length; i += 1) {
    out.push(argv[i]);
    if (!FIND_EXEC.has(argv[i])) continue;
    let end = i + 1;
    while (end < argv.length && argv[end] !== ";" && argv[end] !== "+") end += 1;
    for (const item of peelClause(argv.slice(i + 1, end))) out.push(item);
    if (end < argv.length) out.push(argv[end]);
    i = end;
  }
  return out;
}

/** Wrapper words removed from a `find -exec` clause, `xargs` (which runs its command) included. */
function peelClause(clause) {
  let words = peel(clause)?.argv ?? clause;
  if (words.length > 0 && basename(words[0]) === "xargs") {
    let i = 1;
    while (i < words.length && words[i].startsWith("-")) i += XARGS_VALUED.has(words[i]) ? 2 : 1;
    words = peel(words.slice(i))?.argv ?? words.slice(i);
  }
  return words;
}
