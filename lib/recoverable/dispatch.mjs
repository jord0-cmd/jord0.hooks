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
const MAX_DEPTH = 5; // `eval "eval '…'"`; past this a payload is left unread and the tree is judged

// Words that run the word after them as a command, with the options of theirs that take a value.
// `command` is handled apart (its `-v`/`-V` is a lookup, not a run), and so are `timeout` (a
// duration operand) and `xargs` (its arguments come from elsewhere).
const WRAPPERS = new Map([
  ["env", new Set(["-u", "--unset", "-C", "--chdir", "-S", "--split-string"])],
  ["sudo", new Set(["-u", "-g", "-C", "-D", "-h", "-p", "-r", "-t", "-U", "--user", "--group", "--prompt"])],
  ["doas", new Set(["-u", "-C"])],
  ["nice", new Set(["-n", "--adjustment"])],
  ["ionice", new Set(["-c", "-n", "-p"])],
  ["stdbuf", new Set(["-i", "-o", "-e"])],
  ["nohup", new Set()],
  ["setsid", new Set()],
  ["chrt", new Set()],
  ["taskset", new Set(["-c", "-p"])],
  ["busybox", new Set()],
]); // prettier-ignore

const TIMEOUT_VALUED = new Set(["-s", "--signal", "-k", "--kill-after"]);
const XARGS_VALUED = new Set([
  "-a", "--arg-file", "-n", "--max-args", "-P", "--max-procs", "-L", "-l", "-s", "--max-chars",
  "-d", "--delimiter", "-E", "-I", "--replace", "-i",
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

    const program = basename(event.argv[0] ?? "");
    if (program === "cd") {
      // `cd` with a readable target moves this scope's directory. An unreadable target
      // (`cd $UNSET`) is left for a later session to handle; see the header's note.
      const target = event.argv[1] !== undefined ? resolve(event.argv[1]) : null;
      if (target && !target.unknown) cdByScope.set(keyOf(event.scope), resolvePath(cwd, target.text));
      before.push(event.argv);
      continue;
    }

    before.push(event.argv.map((w) => resolve(w).text));
    const ctx = { base: cwd, agentId: s.agentId, resolve, before, prefix: event.prefix, signal: s.signal };
    const verdict = await dispatchCommand(event, ctx, { ...s, vars });
    if (verdict) return verdict;
  }
  return null;
}

/**
 * One command: find the program that really runs, then call its judge (or recurse into a payload).
 *
 * @param {import("../shell.mjs").Command} event
 * @param {import("./judges.mjs").Context} ctx
 * @param {object} s  the walk state (judges, shell, cwd, vars, agentId, signal, depth)
 */
async function dispatchCommand(event, ctx, s) {
  const argv = peel(event.argv);
  if (!argv) return null; // a lookup, or a wrapper with nothing after it
  const program = basename(argv[0] ?? "");

  if (SHELLS.has(program)) {
    const payload = shellPayload(argv, event);
    return payload !== null ? recurse(payload, ctx, s) : null;
  }
  if (program === "eval") {
    return argv.length > 1 ? recurse(argv.slice(1).join(" "), ctx, s) : null;
  }
  if (program === "xargs") {
    return xargsDispatch(argv, event, ctx, s);
  }
  if (RM_LIKE.has(program)) return s.judges.rm(argv, ctx);
  if (program === "find") return s.judges.find(unwrapExec(argv), ctx);
  if (program === "git") return s.judges.git(argv, ctx);
  return null;
}

/** List and walk a payload (`sh -c …`, `eval …`, a heredoc), carrying this point's cwd and vars. */
async function recurse(text, ctx, s) {
  if (s.depth >= MAX_DEPTH) {
    return s.judges.whereItRuns("a command nested deeper than this guard follows", ctx);
  }
  const listing = await s.shell.listCommands(text);
  const verdict = await walk(listing.events, {
    ...s, cwd: ctx.base, vars: new Map(s.vars), before: ctx.before, depth: s.depth + 1,
  });
  if (verdict) return verdict;
  // A payload the grammar could not fully read may hide a command bash still runs.
  return listing.hasError ? s.judges.whereItRuns("a command this guard cannot fully parse", ctx) : null;
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
    if (a === "-I" || a === "--replace") { replacement = argv[i + 1]; i += 2; continue; }
    if (a.startsWith("-I")) { replacement = a.slice(2); i += 1; continue; } // -I{}
    if (a.startsWith("--replace=")) { replacement = a.slice("--replace=".length) || "{}"; i += 1; continue; }
    if (a === "-i" || a.startsWith("--replace")) { replacement = "{}"; i += 1; continue; }
    i += XARGS_VALUED.has(a) ? 2 : 1;
  } // prettier-ignore

  let command = peel(argv.slice(i));
  if (!command || !RM_LIKE.has(basename(command[0] ?? ""))) return null; // xargs runs something else
  // The replacement token stands for the piped-in argument, not an operand of its own.
  command = command.filter((w) => w !== (replacement ?? "{}"));

  /** @type {{ kind: "find", argv: string[] } | { kind: "file", path: string } | { kind: "unknown" }} */
  let feed;
  if (file) feed = { kind: "file", path: file };
  else if (event.stdinFile) feed = { kind: "file", path: event.stdinFile };
  else if (event.feeder && basename(event.feeder[0] ?? "") === "find") feed = { kind: "find", argv: event.feeder };
  else feed = { kind: "unknown" };

  return s.judges.pipeFedRm(command, feed, ctx);
}

/** The script a shell runs: its `-c` argument, or a heredoc when no `-c` and no operand precedes it. */
function shellPayload(argv, event) {
  const c = argv.findIndex((a, i) => i > 0 && /^-[a-z]*c$/i.test(a));
  if (c > 0 && argv[c + 1] !== undefined) return argv[c + 1];
  const operands = argv.slice(1).filter((a) => !a.startsWith("-") && !a.startsWith("+"));
  return operands.length === 0 && event.heredoc ? event.heredoc : null;
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
  for (let depth = 0; depth < 6 && words.length > 0; depth += 1) {
    const tool = basename(words[0]);
    if (tool === "command" || tool === "exec") {
      // `command`/`exec` run the word after their own options. `command -v NAME` is a lookup,
      // but a `-v` AFTER the program is that program's flag (`command rm -v -rf`), so only a
      // leading one counts. `exec -a NAME` renames; skip its value.
      let i = 1;
      while (i < words.length && words[i].startsWith("-")) {
        if (tool === "command" && (words[i] === "-v" || words[i] === "-V")) return null;
        i += words[i] === "-a" ? 2 : 1;
      }
      words = words.slice(i);
    } else if (tool === "timeout") {
      let i = 1;
      while (i < words.length && words[i].startsWith("-")) i += TIMEOUT_VALUED.has(words[i]) ? 2 : 1;
      words = words.slice(i + 1); // past the duration
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
