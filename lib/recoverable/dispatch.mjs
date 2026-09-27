// The dispatcher: walk the listed commands and hand each one that really runs to its judge.
//
// The lister (../shell.mjs) says WHAT is written and WHERE; the judges (./judges.mjs) say whether
// a given command destroys work git cannot give back. This file is the bridge. For every command
// the lister found, it works out the program that actually runs (past `env`, `sudo`, `busybox`,
// `nice`, `timeout`; through `sh -c`, `eval`, and a heredoc fed to a shell; and, for `xargs`, from
// where its arguments come), then calls the judge for that program. The first verdict any judge
// returns is the answer. Nothing here inspects a path or asks git; it only decides who to ask.
//
// Two things it tracks as it walks, because they change what a later command touches:
//   * `cd`, so `cd wip && rm -rf deep` is judged in wip. A `cd` inside `( … )` runs in a subshell
//     and does not leak out, so the tracking is scoped: the lister gives each subshell and
//     command substitution its own scope id, and a `cd` is visible only to commands in the same
//     scope or one nested inside it.
//   * `NAME=value`, so `S=wip; rm -rf $S` is judged against wip and `S=build; … $S` is not. Same
//     scoping. Anything still unresolved at run time (a loop variable, `$(git diff)`) is left for
//     the judge, which asks where the command runs rather than guessing it names nothing.

import { basename, resolve as resolvePath } from "node:path";

const RM_LIKE = new Set(["rm", "unlink", "shred"]);
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "ash"]);
const FIND_EXEC = new Set(["-exec", "-execdir", "-ok", "-okdir"]);
const CD = new Set(["cd", "pushd"]);
const MAX_DEPTH = 5; // `eval "eval '…'"`; past this a payload is left unread and the tree is judged
const MAX_PEEL = 12; // wrappers stacked before the command; a real chain rarely passes a handful

// Words that run the word after them as a command, with the options of theirs that take a value.
// `command`, `exec` and `builtin` are handled apart (a `command -v` lookup runs nothing), and so
// are the ones with a positional operand of their own and `xargs` (its arguments come elsewhere).
const WRAPPERS = new Map([
  ["env", new Set(["-u", "--unset", "-C", "--chdir", "-S", "--split-string"])],
  ["sudo", new Set(["-u", "-g", "-C", "-D", "-h", "-p", "-r", "-t", "-U", "--user", "--group", "--prompt"])],
  ["doas", new Set(["-u", "-C"])],
  ["nice", new Set(["-n", "--adjustment"])],
  ["ionice", new Set(["-c", "-n", "-p"])],
  ["stdbuf", new Set(["-i", "-o", "-e"])],
  ["nohup", new Set()],
  ["setsid", new Set()],
  ["busybox", new Set()],
  ["taskset", new Set(["-c", "--cpu-list", "-p"])],
]); // prettier-ignore

// Wrappers that take one positional operand of their own (a duration, a lock file) before the
// command: `timeout 5 rm`, `flock lock rm`.
const POSITIONAL_WRAPPERS = new Map([
  ["timeout", new Set(["-s", "--signal", "-k", "--kill-after"])],
  ["flock", new Set(["-w", "--timeout", "-E", "--conflict-exit-code"])],
]); // prettier-ignore

const XARGS_VALUED = new Set([
  "-a", "--arg-file", "-n", "--max-args", "-P", "--max-procs", "-L", "-s", "--max-chars",
  "-d", "--delimiter", "-E", "-I",
]); // prettier-ignore

/**
 * @param {import("../shell.mjs").Listing} listing  from listCommands(command)
 * @param {object} ctx
 * @param {string} ctx.cwd        the session's working directory
 * @param {string} ctx.agentId    "" on the main thread
 * @param {AbortSignal} [ctx.signal]
 * @param {typeof import("../shell.mjs")} ctx.shell   { listCommands, resolveWord }
 * @param {typeof import("./judges.mjs")} ctx.judges  { rm, pipeFedRm, find, git, whereItRuns }
 * @returns {Promise<import("../runner.mjs").Verdict | null>}
 */
export async function dispatch(listing, ctx) {
  return walk(listing.events, {
    cwd: ctx.cwd,
    vars: new Map(),
    agentId: ctx.agentId,
    signal: ctx.signal,
    shell: ctx.shell,
    judges: ctx.judges,
    before: [],
    depth: 0,
  });
}

/**
 * Walk one command list in source order. `s.cwd` and `s.vars` seed it (the session's, or a parent
 * payload's when this is a recursion). Returns the first verdict, or null.
 *
 * @param {Array<import("../shell.mjs").Command | import("../shell.mjs").Assignment>} events
 * @param {object} s
 */
async function walk(events, s) {
  /** @type {Map<string, string>} */ const cdByScope = new Map();
  /** @type {Map<string, Map<string, string>>} */ const varsByScope = new Map();
  const keyOf = (scope) => scope.join("\u0000");

  // The directory in effect for a scope: its own `cd`, else its nearest enclosing scope's, else
  // the seed cwd. Walked innermost-first so a nested `cd` wins over an outer one.
  const cwdAt = (scope) => {
    for (let i = scope.length; i >= 0; i -= 1) {
      const k = keyOf(scope.slice(0, i));
      if (cdByScope.has(k)) return cdByScope.get(k);
    }
    return s.cwd;
  };
  // Every variable visible at a scope: the seed vars, then each enclosing scope outermost-first so
  // an inner assignment overrides an outer one.
  const varsAt = (scope) => {
    const merged = new Map(s.vars);
    for (let i = 0; i <= scope.length; i += 1) {
      const sub = varsByScope.get(keyOf(scope.slice(0, i)));
      if (sub) for (const [name, value] of sub) merged.set(name, value);
    }
    return merged;
  };

  const before = [...s.before];
  for (const event of events) {
    const cwd = cwdAt(event.scope);
    const vars = varsAt(event.scope);
    const resolve = (word) => s.shell.resolveWord(word, { cwd, vars });

    if (event.kind === "assignment") {
      const k = keyOf(event.scope);
      if (!varsByScope.has(k)) varsByScope.set(k, new Map());
      varsByScope.get(k).set(event.name, resolve(event.value).text);
      continue;
    }

    const argv = peel(event.argv);
    if (!argv) {
      before.push(event.argv);
      continue; // a lookup, or a wrapper with nothing after it: nothing runs
    }
    const program = basename(argv[0]);
    if (CD.has(program)) {
      trackCd(argv, event.scope, cwd, resolve, cdByScope, keyOf);
      before.push(argv);
      continue;
    }

    before.push(argv.map((w) => resolve(w).text));
    const base = envChdir(event.argv, resolve, cwd) ?? cwd;
    const ctx = { base, agentId: s.agentId, resolve, before, prefix: event.prefix, signal: s.signal };
    const verdict = await dispatchCommand(event, argv, ctx, { ...s, vars });
    if (verdict) return verdict;
  }
  return null;
}

/**
 * One command, already peeled of wrapper words: call its program's judge, or recurse into a
 * payload it runs.
 *
 * @param {import("../shell.mjs").Command} event
 * @param {string[]} argv  the command with wrappers removed, `argv[0]` the real program
 * @param {import("./judges.mjs").Context} ctx
 * @param {object} s  the walk state (judges, shell, cwd, vars, agentId, signal, depth)
 */
async function dispatchCommand(event, argv, ctx, s) {
  const program = basename(argv[0] ?? "");

  if (SHELLS.has(program)) {
    const payload = shellPayload(argv, event);
    return payload !== null ? recurse(payload, ctx, s) : null;
  }
  if (program === "eval") {
    // eval concatenates its arguments and re-parses. Joining them here loses quoting bash kept,
    // so a parse error in the result is as likely mine as real, and `eval` of a malformed string
    // errors and runs nothing anyway; do not ask on that.
    return argv.length > 1 ? recurse(argv.slice(1).join(" "), ctx, s, { askOnUnparsed: false }) : null;
  }
  if (program === "xargs") {
    return xargsDispatch(argv, event, ctx, s);
  }
  if (RM_LIKE.has(program)) return s.judges.rm(argv, ctx);
  if (program === "find") {
    const verdict = await execVerdict(argv, ctx, s);
    return verdict ?? s.judges.find(unwrapExec(argv), ctx);
  }
  if (program === "git") return s.judges.git(argv, ctx);
  return null;
}

/**
 * A `find` whose `-exec` runs a shell (`-exec sh -c '…'`); the shell's script is walked. A plain
 * `-exec rm` is left for the find judge, which dry-runs it precisely; an `-exec git` discard is a
 * documented floor, for the same reason `xargs git` is (the matched files are an open-ended set).
 *
 * @param {string[]} argv  a peeled `find …` argv
 * @param {import("./judges.mjs").Context} ctx
 * @param {object} s
 */
async function execVerdict(argv, ctx, s) {
  for (const clause of execClauses(argv)) {
    if (!SHELLS.has(basename(clause[0] ?? ""))) continue;
    const payload = shellPayload(clause, {});
    if (payload !== null) {
      const verdict = await recurse(payload, ctx, s);
      if (verdict) return verdict;
    }
  }
  return null;
}

/**
 * List and walk a payload (`sh -c …`, `eval …`, a heredoc), carrying this point's cwd and vars.
 * `askOnUnparsed` asks when the payload cannot be fully parsed (a command bash may still run);
 * `eval` turns it off, because a malformed eval string errors and runs nothing.
 */
async function recurse(text, ctx, s, { askOnUnparsed = true } = {}) {
  if (s.depth >= MAX_DEPTH) {
    return s.judges.whereItRuns("a command nested deeper than this guard follows", ctx);
  }
  const listing = await s.shell.listCommands(text);
  const verdict = await walk(listing.events, {
    ...s, cwd: ctx.base, vars: new Map(s.vars), before: ctx.before, depth: s.depth + 1,
  });
  if (verdict) return verdict;
  return askOnUnparsed && listing.hasError
    ? s.judges.whereItRuns("a command this guard cannot fully parse", ctx)
    : null;
}

/** An `xargs` whose command is a delete: work out where its arguments come from, then judge it. */
async function xargsDispatch(argv, event, ctx, s) {
  let i = 1;
  let file = null;
  let replacement = null;
  while (i < argv.length && argv[i].startsWith("-")) {
    const a = argv[i];
    if (a === "-a" || a === "--arg-file") { file = argv[i + 1]; i += 2; continue; }
    if (a.startsWith("--arg-file=")) { file = a.slice("--arg-file=".length); i += 1; continue; }
    if (a === "-I") { replacement = argv[i + 1]; i += 2; continue; } // -I R (a value follows)
    if (a.startsWith("-I")) { replacement = a.slice(2); i += 1; continue; } // -I{}
    if (a.startsWith("--replace=")) { replacement = a.slice("--replace=".length) || "{}"; i += 1; continue; }
    if (a === "-i" || a === "--replace") { replacement = "{}"; i += 1; continue; } // optional value only
    i += XARGS_VALUED.has(a) ? 2 : 1;
  } // prettier-ignore

  let command = peel(argv.slice(i));
  if (!command) return null;
  // The replacement token stands for the piped-in argument, not an operand of its own.
  command = command.filter((w) => w !== (replacement ?? "{}"));
  const program = basename(command[0] ?? "");

  if (RM_LIKE.has(program)) {
    /** @type {{ kind: "find", argv: string[] } | { kind: "file", path: string } | { kind: "unknown" }} */
    let feed;
    if (file) feed = { kind: "file", path: file };
    else if (event.stdinFile) feed = { kind: "file", path: event.stdinFile };
    else if (event.feeder && basename(event.feeder[0] ?? "") === "find") feed = { kind: "find", argv: event.feeder };
    else feed = { kind: "unknown" };
    return s.judges.pipeFedRm(command, feed, ctx);
  }
  if (SHELLS.has(program)) {
    const payload = shellPayload(command, {});
    return payload !== null ? recurse(payload, ctx, s) : null;
  }
  // `xargs git checkout --` fed a list of paths reverts them, but the paths come from the feed,
  // and this guard would have to reproduce the git judge's per-flag nuance (`restore --staged`
  // is safe, `rm --cached` is safe) to avoid a false alarm on the safe ones. It does not: an
  // `xargs git` discard is a documented floor, not a route this guard judges.
  return null;
}

/**
 * The script a shell runs: the argument after a `-c` (which may be one flag of a cluster, `-ce`),
 * else a heredoc or here-string fed to it, else the string piped in by an `echo`/`printf`. A
 * shell handed a script FILE is not read (its path is not the script text).
 *
 * @param {string[]} argv  the shell command, wrappers already peeled
 * @param {import("../shell.mjs").Command | {}} event
 */
function shellPayload(argv, event) {
  let i = 1;
  let dashC = false;
  for (; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--") { i += 1; break; }
    // `-o pipefail` / `-O extglob` take a value; skip it so it is not read as the script.
    if (/^[-+][oO]$/.test(a)) { i += 1; continue; }
    if (a === "-c" || (a.startsWith("-") && !a.startsWith("--") && a.includes("c"))) { dashC = true; i += 1; break; }
    if (a.startsWith("-") || a.startsWith("+")) continue;
    break; // the first operand: a script file, not read
  }
  if (dashC) return argv[i] !== undefined ? argv[i] : null;
  const operands = argv.slice(1).filter((a) => !a.startsWith("-") && !a.startsWith("+"));
  if (operands.length > 0) return null; // a script file
  if (event.heredoc) return event.heredoc; // heredoc or here-string body
  // `echo 'rm -rf wip' | bash`: what the feeder prints is the script. echo prints its arguments,
  // past its own `-n`/`-e`/`-E`. (`printf`'s format interpretation is a documented floor.)
  const feeder = event.feeder;
  if (feeder && basename(feeder[0] ?? "") === "echo") {
    const args = feeder.slice(1);
    while (args.length > 0 && /^-[neE]+$/.test(args[0])) args.shift();
    return args.join(" ") || null;
  }
  return null;
}

/** Each `-exec` clause of a `find`, wrapper words peeled, up to its `;`/`+` terminator. */
function execClauses(argv) {
  const clauses = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (!FIND_EXEC.has(argv[i])) continue;
    let end = i + 1;
    while (end < argv.length && argv[end] !== ";" && argv[end] !== "+") end += 1;
    clauses.push(peelClause(argv.slice(i + 1, end)));
    i = end;
  }
  return clauses;
}

/**
 * Track a `cd`/`pushd` for its scope. A readable target that is a real directory moves the
 * scope's cwd; a `cd` that would fail (an unreadable target, or one that is not a directory)
 * leaves it where it was, which is what bash does.
 */
function trackCd(argv, scope, cwd, resolve, cdByScope, keyOf) {
  let i = 1;
  while (i < argv.length && argv[i].startsWith("-") && argv[i] !== "--") i += 1;
  if (argv[i] === "--") i += 1;
  if (argv[i] === undefined) return; // `cd` with no argument goes HOME; leave the tracked cwd
  const target = resolve(argv[i]);
  // An unreadable target is left where it was. A readable one moves the tracked cwd even if the
  // directory is not on disk now: a `$(mktemp -d)` exists at run time, and refusing to follow it
  // would judge a later `rm -rf *` against the repo it never touches. Missing a `cd typo; rm` is
  // a floor the guard accepts; asking about a safe scratch delete is a false alarm it must not.
  if (!target.unknown) cdByScope.set(keyOf(scope), resolvePath(cwd, target.text));
}

/** The directory `env -C DIR` / `env --chdir=DIR` runs its command in, resolved, or null. */
function envChdir(argv, resolve, cwd) {
  if (basename(argv[0] ?? "") !== "env") return null;
  for (let i = 1; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "-C" || a === "--chdir") {
      const t = resolve(argv[i + 1] ?? "");
      return t.unknown ? null : resolvePath(cwd, t.text);
    }
    if (a.startsWith("--chdir=")) {
      const t = resolve(a.slice("--chdir=".length));
      return t.unknown ? null : resolvePath(cwd, t.text);
    }
    if (!a.startsWith("-") && !/^[A-Za-z_]\w*=/.test(a)) break; // reached the command
  }
  return null;
}

/**
 * `argv` with leading wrapper words removed, so `argv[0]` is the program that really runs, or null
 * when nothing runs (`command -v rm`, a wrapper with no command after it).
 *
 * @param {string[]} argv
 * @returns {string[] | null}
 */
function peel(argv) {
  let words = argv;
  for (let depth = 0; depth < MAX_PEEL && words.length > 0; depth += 1) {
    const tool = basename(words[0]);
    if (tool === "command" || tool === "exec" || tool === "builtin") {
      // `command`/`exec`/`builtin` run the word after their own options. `command -v NAME` is a
      // lookup, but a `-v` AFTER the program is that program's flag (`command rm -v -rf`), so only
      // a leading one counts. `exec -a NAME` renames; skip its value.
      let i = 1;
      while (i < words.length && words[i].startsWith("-")) {
        if (tool === "command" && (words[i] === "-v" || words[i] === "-V")) return null;
        i += words[i] === "-a" ? 2 : 1;
      }
      words = words.slice(i);
    } else if (POSITIONAL_WRAPPERS.has(tool)) {
      const valued = POSITIONAL_WRAPPERS.get(tool);
      let i = 1;
      while (i < words.length && words[i].startsWith("-")) i += valued.has(words[i]) ? 2 : 1;
      words = words.slice(i + 1); // past the one positional operand (a duration, a lock file)
    } else if (WRAPPERS.has(tool)) {
      const valued = WRAPPERS.get(tool);
      let i = 1;
      while (i < words.length && (words[i].startsWith("-") || /^[A-Za-z_]\w*=/.test(words[i]))) {
        i += valued.has(words[i]) ? 2 : 1;
      }
      words = words.slice(i);
    } else {
      break;
    }
  }
  return words.length > 0 ? words : null;
}

/**
 * A `find` argv with every `-exec` clause's own wrapper words removed, so the clause starts with
 * the program it really runs, so `-exec sudo rm {}` becomes `-exec rm {}` and `-exec xargs rm {}`
 * becomes `-exec rm {}`, which is what the find judge reads to see the delete.
 *
 * @param {string[]} argv
 */
function unwrapExec(argv) {
  const out = [];
  for (let i = 0; i < argv.length; i += 1) {
    out.push(argv[i]);
    if (!FIND_EXEC.has(argv[i])) continue;
    let end = i + 1;
    while (end < argv.length && argv[end] !== ";" && argv[end] !== "+") end += 1;
    out.push(...peelClause(argv.slice(i + 1, end)));
    if (end < argv.length) out.push(argv[end]);
    i = end;
  }
  return out;
}

/** Wrapper words removed from a `find -exec` clause, `xargs` (which runs its command) included. */
function peelClause(clause) {
  let words = peel(clause) ?? clause;
  if (words.length > 0 && basename(words[0]) === "xargs") {
    let i = 1;
    while (i < words.length && words[i].startsWith("-")) i += XARGS_VALUED.has(words[i]) ? 2 : 1;
    words = peel(words.slice(i)) ?? words.slice(i);
  }
  return words;
}
