// FLAG-PROBE: read a script before you ask it for --help.
//
// The failure it exists for: to learn a script's options, Claude runs `./gen-config.sh --help`.
// The script does not parse `--help`. It ignores the flag and does its job: rewrites a config,
// restarts a service, evicts the two models that were loaded. A help flag is a guess about a
// fact that is sitting right there in the file, and for a script that does not handle it, the
// guess runs the script.
//
// So for every Bash command, this finds each script invoked with a standalone `-h` / `--help`:
// typed directly, behind `sudo` / `nice` / `timeout`, run by an interpreter, inside `bash -c`,
// `eval` or a heredoc fed to a shell, or on the far side of `ssh host '…'`. It denies the call
// unless
//
//   the script's code handles the flag   (a `-h|--help)` case arm, a test against "--help", or
//                                         an import of a parser that answers it: argparse, click,
//                                         commander, yargs … Comments do not count: "this script
//                                         does not support --help" is not support for --help.
//   or this session has already read it  (a Read of the file, or cat / head / sed -n / rg … with
//                                         the file as an operand, earlier in the session or
//                                         earlier in the same command)
//
// A probe it cannot resolve (`"$f" --help` in a loop) is asked about instead, because a word the
// guard cannot read is not a word that names nothing. The fix is always one command,
// `head -40 <script>`, and the reason says so.

import { open, readFile, stat } from "node:fs/promises";
import { basename, delimiter, isAbsolute, join, resolve } from "node:path";

import { agentIdOf } from "./runner.mjs";
import { SHELLS, peel } from "./commands.mjs";
import { listCommands, resolveWord } from "./shell.mjs";
import { readActivity } from "./transcript.mjs";

const HELP_FLAGS = new Set(["-h", "--help"]);
// A help flag standing as a word of its own, for text the grammar could not parse.
const HELP_WORD = /(?:^|[\s;&|('"`])(?:-h|--help)(?=$|[\s;&|)'"`])/m;
const SCRIPT_SUFFIX = /\.(?:sh|bash|zsh|ksh|py|js|mjs|cjs|ts|rb|pl|php|lua|jl|ps1)$/i;
const MAX_SOURCE_BYTES = 1_000_000;
const MAX_DEPTH = 3;

// Words that run the next word as a FILE, with the options that run inline code instead (then
// no script follows) and the options that take a value.
const INTERPRETERS = new Map(
  [
    [[...SHELLS, "source", "."], { inline: ["-c"], valued: ["-o", "+o", "-O", "+O"] }],
    [["python", "python3"], { inline: ["-c", "-m"], valued: ["-W", "-X", "-Q"] }],
    [["node"], { inline: ["-e", "-p", "--eval", "--print"], valued: ["-r", "--require", "--import", "--loader"] }],
    [["bun", "tsx", "ts-node"], { inline: ["-e", "-p", "--eval", "--print"], valued: [] }],
    [["deno"], { inline: [], valued: [] }],
    [["ruby"], { inline: ["-e"], valued: ["-I", "-r"] }],
    [["perl"], { inline: ["-e", "-E"], valued: ["-I"] }],
    [["php"], { inline: ["-r"], valued: ["-c", "-d"] }],
    [["Rscript", "lua"], { inline: ["-e"], valued: [] }],
    [["julia"], { inline: ["-e", "-E"], valued: [] }],
    [["pwsh"], { inline: ["-c", "-Command", "-command"], valued: [] }],
  ].flatMap(([names, rules]) =>
    names.map((name) => [name, { inline: new Set(rules.inline), valued: new Set(rules.valued) }]),
  ),
);
const INTERPRETER_PAIRS = new Set(["uv run", "poetry run", "pdm run", "pipenv run", "deno run", "bun run", "npx tsx"]);
const SSH_VALUED = new Set("BbcDEeFIiJLlmOoPpQRSWw".split("").map((c) => `-${c}`));

// Commands that show a file without running it, and how to find the file among their words.
// `pattern: true` means the first operand is a pattern or a program, not a file, unless the
// pattern came in through one of `patternFlags` instead.
const READERS = new Map([
  ...["cat", "head", "tail", "less", "more", "bat", "batcat", "nl", "view", "vim", "nano"].map((name) => [
    name,
    { pattern: false, patternFlags: [], valued: ["-n", "-c", "-l", "-r", "--language", "--line-range"] },
  ]),
  ...["grep", "egrep", "fgrep", "rg"].map((name) => [
    name,
    {
      pattern: true,
      patternFlags: ["-e", "-f", "--regexp", "--file"],
      valued: ["-m", "-A", "-B", "-C", "-g", "-t", "-T", "--max-count", "--glob", "--type", "--type-not"],
    },
  ]),
  ["sed", { pattern: true, patternFlags: ["-e", "-f", "--expression", "--file"], valued: ["-l"] }],
  ["awk", { pattern: true, patternFlags: ["-f", "--file"], valued: ["-F", "-v"] }],
]);

/**
 * @typedef {{ script: string, path: string | null, remote: string | null, invocation: string, flag?: string }} Probe
 *   `path` is the resolved local file, `remote` the ssh host when the script lives elsewhere
 * @typedef {{ name: string, path: string | null, remote: string | null }} Read
 * @typedef {{ invocation: string, unparsed?: boolean }} Unreadable a probe whose program or directory
 *   cannot be resolved, or (`unparsed`) a command the grammar could not read that carries a help flag
 */

/**
 * @param {Record<string, any>} payload the PreToolUse payload
 * @returns {Promise<import("./runner.mjs").Verdict | null>}
 */
export async function judge(payload) {
  // Wired to Bash. A call to another tool (BashOutput, or a matcher someone widened) is not
  // this guard's business; a Bash call with no command still is, and is a fault.
  if (typeof payload.tool_name === "string" && payload.tool_name !== "Bash") return null;
  const command = payload.tool_input?.command;
  if (typeof command !== "string") throw new Error("the payload carries no tool_input.command string");
  const cwd = typeof payload.cwd === "string" ? payload.cwd : process.cwd();
  const { probes, unreadable, readsBefore } = await inspect(command, cwd);
  if (probes.length === 0 && unreadable.length === 0) return null;

  if (probes.length) {
    const activity =
      typeof payload.transcript_path === "string" ? await readActivity(payload.transcript_path) : null;
    const earlier = activity ? await readsIn(activity.uses, cwd) : [];
    for (const probe of probes) {
      if (probe.path && (await handlesHelp(probe.path, probe.flag))) continue;
      const reads = [...earlier, ...(readsBefore.get(probe) ?? [])];
      if (reads.some((r) => sameScript(r, probe))) continue;
      return { decision: "deny", reason: refusal(probe) };
    }
  }
  if (unreadable.length) {
    const [first] = unreadable;
    const what = first.unparsed
      ? `FLAG-PROBE: part of \`${first.invocation}\` cannot be parsed and it carries a help flag, so ` +
        "this guard cannot tell which program is asked for help, or whether it parses the flag."
      : `FLAG-PROBE: \`${first.invocation}\` asks a program for help, and this guard cannot ` +
        "tell which program that is, so it cannot tell whether it parses the flag.";
    return agentIdOf(payload)
      ? { decision: "deny", reason: `${what} Read the script first, then run it by its name.` }
      : { decision: "ask", reason: what };
  }
  return null;
}

function refusal(probe) {
  // A bare name found on PATH is read by its full path. Anything with a slash reads as typed.
  const shown = probe.script.includes("/") || !probe.path ? probe.script : probe.path;
  const look = probe.remote ? `ssh ${probe.remote} head -40 ${probe.script}` : `head -40 ${shown}`;
  return (
    `FLAG-PROBE: \`${probe.invocation}\` guesses that ${basename(probe.script)} parses a help ` +
    "flag. Nothing in it says so, and this session has not read it. A script that ignores the " +
    `flag simply runs. Read it first with \`${look}\`. Once it has been read, the call is allowed.`
  );
}

// ─── Finding the probes ─────────────────────────────────────────────────────────────────

/**
 * Every help-flag probe in `command`, the ones that cannot be resolved, and for each probe the
 * reads that come before it in the same command.
 *
 * @param {string} command
 * @param {string} cwd
 */
async function inspect(command, cwd) {
  /** @type {Probe[]} */
  const probes = [];
  /** @type {Unreadable[]} */
  const unreadable = [];
  /** @type {Map<Probe, Read[]>} */
  const readsBefore = new Map();
  /** @type {Read[]} */
  const reads = [];
  await visit(command, cwd, null, 0, {
    read: (r) => reads.push(r),
    probe: (p) => {
      probes.push(p);
      readsBefore.set(p, [...reads]);
    },
    unreadable: (u) => unreadable.push(u),
  });
  return { probes, unreadable, readsBefore };
}

/**
 * Walk the commands of `text`, following `cd` and variables, and report reads and probes in
 * order. Payloads of `bash -c`, `eval`, a heredoc fed to a shell and `ssh host …` are walked the
 * same way, a few levels deep.
 *
 * @param {string} text
 * @param {string | null} cwd null once a `cd` went somewhere this guard cannot read
 * @param {string | null} remote the ssh host the text runs on, if any
 * @param {number} depth
 * @param {{ read(r: Read): void, probe(p: Probe): void, unreadable(u: Unreadable): void }} report
 */
async function visit(text, cwd, remote, depth, report) {
  if (depth > MAX_DEPTH) return;
  const { events, hasError } = await listCommands(text);
  // A span the grammar could not read may hold a probe. A help flag in it is asked about.
  // Quoted prose that mentions --help is not a probe (`git commit -m "document --help"`).
  if (hasError && HELP_WORD.test(withoutQuotes(text))) report.unreadable({ invocation: firstLine(text), unparsed: true });
  const cwdByScope = new Map([["", cwd]]);
  // Variables are scoped like the directory: `(S=x)` sets S only inside its subshell.
  const varsByScope = new Map([["", new Map()]]);
  const varsAt = (scope) => {
    const merged = new Map();
    for (let i = 0; i <= scope.length; i += 1) for (const [k, v] of varsByScope.get(scope.slice(0, i).join("/")) ?? []) merged.set(k, v);
    return merged;
  };
  const setVar = (scope, name, value) => {
    const key = scope.join("/");
    if (!varsByScope.has(key)) varsByScope.set(key, new Map());
    varsByScope.get(key).set(name, value);
  };
  for (const event of events) {
    const here = nearest(cwdByScope, event.scope, cwd);
    if (event.kind === "assignment") {
      setVar(event.scope, event.name, event.value);
      continue;
    }
    if (event.kind === "loopvar") {
      // It takes each value in turn, so a program it names is unreadable. Set to itself, it stays
      // unknown, and an environment variable of the same name cannot answer for it.
      setVar(event.scope, event.name, `$${event.name}`);
      continue;
    }
    if (event.kind !== "command") continue; // a function definition runs nothing where it stands
    const vars = varsAt(event.scope);
    const resolved = event.argv.map((w) => resolveWord(w, { cwd: here ?? "/", vars }).text);
    // The shell's wrappers (env -S, sudo, flock, taskset, …) from the table all three hooks share.
    const peeled = peel(resolved);
    if (!peeled) continue;
    const argv = peeled.argv;
    const words = argv.map((text) => ({ text, unknown: /[$`]/.test(text) || /\{[^{}]*(?:,|\.\.)[^{}]*\}/.test(text) }));
    const tool = basename(argv[0] ?? "");
    const invocation = event.argv.join(" ");

    if (tool === "cd" && !remote) {
      let i = 1;
      while (i < words.length && /^-[LPe@]+$/.test(words[i].text)) i += 1;
      if (words[i]?.text === "--") i += 1;
      const target = words[i];
      // A bare `cd` goes home; `cd -` goes wherever the shell was before, which is unknown here.
      const next = !target
        ? (process.env.HOME ?? here)
        : target.unknown || target.text === "-" || !here
          ? null
          : resolve(here, target.text);
      cwdByScope.set(event.scope.join("/"), next);
      continue;
    }
    const nested = nestedPayload(argv, event);
    if (nested) {
      await visit(nested.text, here, nested.remote ?? remote, depth + 1, report);
      continue;
    }
    if (READERS.has(tool) && !argv.some((a) => HELP_FLAGS.has(a))) {
      // A read counts when it showed the file: not when its output went elsewhere, when it only
      // counted or tested, when it edited in place, or when it may not have run at all.
      if (showsTheFile(tool, argv, event)) {
        for (const file of readerFiles(tool, argv)) {
          report.read({ name: basename(file), path: remote || !here ? null : resolve(here, file), remote });
        }
      }
      continue;
    }
    const found = commandPosition(argv);
    if (!found || !argv.slice(found.at + 1).some((a) => HELP_FLAGS.has(a))) continue;
    const script = argv[found.at];
    if (words[found.at].unknown || (!here && !remote && !isAbsolute(script))) {
      report.unreadable({ invocation });
      continue;
    }
    if (!isScript(script) && !found.asFile) continue; // `git --help`: a program, not a script
    const path = remote ? null : await localScript(script, here, found);
    // A local word that is not a script on disk (a binary, a missing file) is nothing to protect.
    const flag = argv.slice(found.at + 1).find((a) => HELP_FLAGS.has(a));
    if (remote || path) report.probe({ script, path, remote, invocation, flag });
  }
}

// Reader flags after which nothing of the file's text is shown.
const SHOWS_NOTHING = /^-(?:[a-zA-Z]*[clLqs][a-zA-Z]*|-count|-files-with(?:out)?-matches|-quiet|-silent)$/;

/** Did this reader put the file's text in front of the session? */
function showsTheFile(tool, argv, event) {
  if (event.conditional) return false;
  if (event.writes.length > 0) return false; // `cat x > /dev/null`, `head x > y`
  if ((tool === "sed" || tool === "gsed") && argv.some((a) => /^-[a-zA-Z]*i|^--in-place/.test(a))) return false;
  if (["grep", "egrep", "fgrep", "rg"].includes(tool) && argv.some((a) => SHOWS_NOTHING.test(a))) return false;
  return true;
}

/** `text` with its quoted strings blanked. */
function withoutQuotes(text) {
  return text.replace(/'[^']*'|"(?:[^"\\]|\\.)*"/g, "''");
}

/** The text a `bash -c`, `eval`, heredoc-fed shell or `ssh host` runs, if this command is one. */
function nestedPayload(argv, event) {
  const tool = basename(argv[0] ?? "");
  if (tool === "eval" && argv.length > 1) return { text: argv.slice(1).join(" "), remote: null };
  if (SHELLS.has(tool)) {
    const c = argv.findIndex((a, i) => i > 0 && /^-[a-zA-Z]*c[a-zA-Z]*$/.test(a));
    if (c > 0 && argv[c + 1] !== undefined) return { text: argv[c + 1], remote: null };
    const operands = argv.slice(1).filter((a) => !a.startsWith("-") && !a.startsWith("+"));
    if (operands.length === 0 && event.heredoc) return { text: event.heredoc, remote: null };
  }
  if (tool === "ssh") {
    let i = 1;
    while (i < argv.length && argv[i].startsWith("-")) i += SSH_VALUED.has(argv[i]) ? 2 : 1;
    const host = argv[i];
    const rest = argv.slice(i + 1);
    if (host && rest.length) return { text: rest.join(" "), remote: host };
  }
  return null;
}

/** The operands of a reader that name files it shows (never its pattern or program). */
function readerFiles(tool, argv) {
  const rules = READERS.get(tool);
  const operands = [];
  let patternGiven = false;
  for (let i = 1; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--") {
      for (const item of argv.slice(i + 1)) operands.push(item);
      break;
    }
    if (a.startsWith("-") && a.length > 1) {
      if (rules.patternFlags.includes(a)) {
        patternGiven = true;
        i += 1;
      } else if (rules.valued.includes(a)) {
        i += 1;
      }
      continue;
    }
    operands.push(a);
  }
  return rules.pattern && !patternGiven ? operands.slice(1) : operands;
}

/**
 * The word this command RUNS, past any runner or interpreter in front of it, or null when an
 * interpreter is told to run inline code instead of a file. It matters who put the word there:
 * an interpreter opens it as a file, anything else runs it as a command.
 *
 * @returns {{ at: number, asFile: boolean, shell: boolean } | null}
 */
function commandPosition(argv) {
  let i = 0;
  let asFile = false;
  let shell = false;
  while (i < argv.length) {
    const tool = basename(argv[i]);
    let valued = new Set();
    let inline = new Set();
    if (INTERPRETER_PAIRS.has(`${tool} ${argv[i + 1] ?? ""}`)) {
      i += 2;
      asFile = true;
      shell = false;
    } else if (INTERPRETERS.has(tool)) {
      ({ valued, inline } = INTERPRETERS.get(tool));
      i += 1;
      asFile = true;
      shell = SHELLS.has(tool) || tool === "source" || tool === ".";
    } else {
      return { at: i, asFile, shell };
    }
    while (i < argv.length && (/^[-+]/.test(argv[i]) || /^[A-Za-z_]\w*=/.test(argv[i]))) {
      if (inline.has(argv[i])) return null; // `python3 -m pip`, `node -e '…'`: no script file
      i += valued.has(argv[i]) ? 2 : 1;
    }
  }
  return null;
}

/** Could this word name a script? Confirmed against the disk later, where there is one. */
function isScript(word) {
  return SCRIPT_SUFFIX.test(word) || /^\.{1,2}\//.test(word) || (word.includes("/") && !word.endsWith("/"));
}

/**
 * The script file a word runs on this machine, or null. A word with a slash is a path. A bare
 * name is found the way its runner finds it. A command is looked up on PATH. An interpreter's
 * file is looked up in the working directory, and then on PATH only for a shell, because bash
 * searches PATH for its script and python does not. A file an interpreter is told to run is a
 * script whatever its name. So is an executable text file with no `#!`, which bash runs as a
 * shell script. A compiled program (`/usr/bin/git --help`) is not a script.
 *
 * @param {string} word
 * @param {string} cwd
 * @param {{ asFile: boolean, shell: boolean }} how
 */
async function localScript(word, cwd, { asFile, shell }) {
  const onPath = (process.env.PATH ?? "").split(delimiter).filter(Boolean).map((dir) => join(dir, word));
  let candidates;
  if (word.includes("/")) candidates = [isAbsolute(word) ? word : resolve(cwd, word)];
  else if (asFile) candidates = shell ? [resolve(cwd, word), ...onPath] : [resolve(cwd, word)];
  else candidates = onPath;
  for (const path of candidates) {
    const file = await existingFile(path);
    if (!file) continue;
    if (asFile || SCRIPT_SUFFIX.test(file)) return file;
    const head = await firstBytes(file, SNIFF_BYTES);
    if (head.subarray(0, 2).toString("latin1") === "#!") return file;
    // A NUL in the first few kilobytes marks a compiled program: ELF, Mach-O and PE all have one.
    return (await isExecutable(file)) && !head.includes(0) ? file : null;
  }
  return null;
}

const SNIFF_BYTES = 4096;

async function firstBytes(path, count) {
  let handle;
  try {
    handle = await open(path, "r");
    const buffer = Buffer.alloc(count);
    const { bytesRead } = await handle.read(buffer, 0, count, 0);
    return buffer.subarray(0, bytesRead);
  } catch {
    return Buffer.alloc(0);
  } finally {
    await handle?.close();
  }
}

async function isExecutable(path) {
  try {
    return ((await stat(path)).mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

// ─── Deciding ───────────────────────────────────────────────────────────────────────────

// Code that answers a help flag, looked for only in lines that are not comments.
const HANDLES_HELP = [
  // A case arm, where one can start (a line, after `;;`, after `in`): -h|--help)  "--help")
  // Anchored, because "(or make --help)" in a usage string is not one.
  /(?:^|;;|\bin)\s*\(?\s*(?:['"]?[^\s|)('"]+['"]?\s*\|\s*)*['"]?(?:--help|-h)['"]?\s*(?:\|\s*['"]?[^\s|)('"]+['"]?\s*)*\)/m,
  /(?:==?|!=|-eq)\s*['"]?(?:--help|-h)['"]?(?=[\s\]);]|$)/m, // [ "$1" = "--help" ], x == "-h"
  /['"](?:--help|-h)['"]\s*(?:in\b|\))/m, // "--help" in sys.argv, argv.includes("--help"), ('-h', '--help')
  /\bcase\s+['"](?:--help|-h)['"]\s*:/m, // switch (arg) { case "--help": }
];
// getopts answers only single letters, and `h:` takes a value (a host), so it handles -h, not --help.
const GETOPTS_H = /\bgetopts\s+['"]?:?[A-Za-z:]*h(?!:)/m;
// Parsers that answer --help by themselves, recognised by the line that brings them in.
const HELP_PARSERS = [
  /^\s*(?:import|from)\s+(?:argparse|optparse|click|typer|docopt|fire)\b/m,
  /(?:require\(\s*|from\s+|import\s+)['"](?:commander|yargs|meow|cac|@oclif\/core|clipanion)(?:\/[\w-]+)?['"]/m,
  /^\s*require\s+['"]optparse['"]/m,
  // Wrappers that hand every argument to a CLI that answers help: Django's manage.py, and the
  // Gradle wrapper. Recognised by the call they make, never by their file name.
  /\bexecute_from_command_line\s*\(/m,
  /\borg\.gradle\.wrapper\.GradleWrapperMain\b/m,
];

/**
 * Does the file's code, as opposed to its comments and the text it prints, handle the flag?
 *
 * @param {string} path
 * @param {string} [flag] the flag that was typed; `getopts` answers `-h`, never `--help`
 */
export async function handlesHelp(path, flag = "--help") {
  let source;
  try {
    if ((await stat(path)).size > MAX_SOURCE_BYTES) return false;
    source = await readFile(path, "utf8");
  } catch {
    return false;
  }
  const code = withoutComments(withoutHeredocs(source));
  if (/\badd_help\s*=\s*False\b/.test(code)) return false;
  if (flag === "-h" && GETOPTS_H.test(code)) return true;
  return HANDLES_HELP.some((re) => re.test(code)) || HELP_PARSERS.some((re) => re.test(code));
}

/** A shell script with its heredoc bodies removed: a usage text that lists `-h|--help)` handles nothing. */
function withoutHeredocs(source) {
  const lines = source.split("\n");
  const out = [];
  for (let i = 0; i < lines.length; i += 1) {
    out.push(lines[i]);
    const tag = /<<-?\s*['"]?([A-Za-z_]\w*)['"]?/.exec(codeOf(lines[i]))?.[1];
    if (!tag) continue;
    while (i + 1 < lines.length && lines[i + 1].trim() !== tag) i += 1;
  }
  return out.join("\n");
}

/** The source with its comments removed, shebang included. */
function withoutComments(source) {
  return source.split("\n").map(codeOf).join("\n");
}

/**
 * A line up to its comment: an unquoted `#` or `//` at the start of the line or after a space.
 * `${#x}`, `$#`, `this.#x` and `http://` are not comments, and neither is either mark inside
 * quotes. Cutting too much can only refuse a script that handles the flag, which costs one read.
 */
function codeOf(line) {
  let quote = "";
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i];
    if (quote) {
      if (c === "\\" && quote !== "'") i += 1;
      else if (c === quote) quote = "";
    } else if (c === "'" || c === '"' || c === "`") {
      quote = c;
    } else if ((c === "#" || (c === "/" && line[i + 1] === "/")) && (i === 0 || /\s/.test(line[i - 1]))) {
      return line.slice(0, i);
    }
  }
  return line;
}

/**
 * @param {import("./transcript.mjs").ToolUse[]} uses
 * @param {string} sessionCwd used where an entry does not record its own
 * @returns {Promise<Read[]>}
 */
async function readsIn(uses, sessionCwd) {
  /** @type {Read[]} */
  const reads = [];
  for (const use of uses) {
    const cwd = use.cwd ?? sessionCwd;
    if (use.name === "Read" && typeof use.input?.file_path === "string") {
      const path = resolve(cwd, use.input.file_path);
      reads.push({ name: basename(path), path, remote: null });
    } else if (use.name === "Bash" && typeof use.input?.command === "string") {
      await visit(use.input.command, cwd, null, 0, {
        read: (r) => reads.push(r),
        probe: () => {},
        unreadable: () => {},
      });
    }
  }
  return reads;
}

/** Local matches local by path. Remote matches remote on the same host by name. Never across. */
function sameScript(read, probe) {
  if (probe.remote) return read.remote === probe.remote && read.name === basename(probe.script);
  return read.remote === null && read.path !== null && read.path === probe.path;
}

async function existingFile(path) {
  if (!path) return null;
  try {
    return (await stat(path)).isFile() ? path : null;
  } catch {
    return null;
  }
}

/** The directory in effect for a scope: its own `cd`, else its nearest enclosing scope's. */
function nearest(map, scope, fallback) {
  for (let n = scope.length; n >= 0; n -= 1) {
    const key = scope.slice(0, n).join("/");
    if (map.has(key)) return map.get(key);
  }
  return fallback;
}

function firstLine(text) {
  const line = text.trim().split("\n")[0];
  return line.length > 120 ? `${line.slice(0, 119)}…` : line;
}
