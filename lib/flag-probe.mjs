// FLAG-PROBE — read a script before you ask it for --help.
//
// The failure it exists for: to learn a script's options, Claude runs `./gen-config.sh --help`.
// The script does not parse `--help`. It ignores the flag and does its job: rewrites a config,
// restarts a service, evicts the two models that were loaded. A help flag is a guess about a
// fact that is sitting right there in the file, and for a script that does not handle it, the
// guess runs the script.
//
// So for every Bash command, this finds each script invoked with a standalone `-h` / `--help`
// (typed directly, behind `sudo` / `timeout` / an interpreter, inside `bash -c '…'`, or on the
// far side of `ssh host '…'`) and denies the call unless
//
//   the script's source visibly handles the flag  (a literal --help, a `-h)` case, or a
//                                                  parser that answers it: argparse, click, …)
//   or this session has already read the script   (a Read of the file, or cat / head / sed -n /
//                                                  rg … naming it, earlier or earlier in this command)
//
// The fix is always one command, `head -40 <script>`, and the reason says so.

import { open, readFile, stat } from "node:fs/promises";
import { basename, delimiter, isAbsolute, join, resolve } from "node:path";

import { listCommands, resolveWord } from "./shell.mjs";
import { readActivity } from "./transcript.mjs";

const HELP_FLAGS = new Set(["-h", "--help"]);
const SCRIPT_SUFFIX = /\.(?:sh|bash|zsh|ksh|py|js|mjs|cjs|ts|rb|pl|php|lua|r|jl|ps1)$/i;
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "ash"]);
// Words that run the next word as a COMMAND, found on PATH: `sudo x.sh`, `nice -n 5 x.sh`.
const RUNNERS = new Set(["sudo", "env", "nice", "nohup", "time", "command", "exec", "stdbuf", "chrt", "ionice"]);
// Words that run the next word as a FILE, found from the working directory: `python3 x.py`.
const INTERPRETERS = new Set([
  ...SHELLS, "python", "python3", "node", "deno", "bun", "ruby", "perl", "php", "Rscript", "tsx",
  "ts-node", "lua", "julia", "pwsh",
]); // prettier-ignore
const INTERPRETER_PAIRS = new Set(["uv run", "poetry run", "pdm run", "pipenv run", "deno run", "bun run", "npx tsx"]);
// Interpreter options that run code or a module given inline, so no script file follows.
const INLINE_CODE = new Set(["-m", "-c", "-e", "-p", "-E", "--eval", "--print", "-r"]);
// Options of `timeout` / `ssh` that take a value of their own.
const TIMEOUT_VALUED = new Set(["-k", "-s", "--kill-after", "--signal"]);
const SSH_VALUED = new Set("BbcDEeFIiJLlmOoPpQRSWw".split("").map((c) => `-${c}`));
// Commands that show a file without running it.
const READERS = new Set([
  "cat", "head", "tail", "less", "more", "bat", "batcat", "sed", "awk", "grep", "rg", "nl",
  "view", "vim", "nano", "wc", "file",
]); // prettier-ignore
// Argument parsers that answer --help by themselves.
const HELP_PARSERS =
  /\b(?:argparse|optparse|click|typer|docopt|fire|commander|yargs|meow|cac|oclif|clipanion|OptionParser|Getopt::Long::Descriptive|clap)\b/;
const MAX_SOURCE_BYTES = 1_000_000;

/**
 * @typedef {{ script: string, path: string | null, remote: string | null, invocation: string }} Probe
 *   `path` is the resolved local file, `remote` the ssh host when the script lives elsewhere
 */

/**
 * @param {Record<string, any>} payload the PreToolUse payload
 * @returns {Promise<import("./runner.mjs").Verdict | null>}
 */
export async function judge(payload) {
  const command = payload.tool_input?.command;
  if (typeof command !== "string") return null;
  const cwd = typeof payload.cwd === "string" ? payload.cwd : process.cwd();
  const { probes, readsBefore } = await inspect(command, cwd);
  if (probes.length === 0) return null;

  const activity =
    typeof payload.transcript_path === "string" ? await readActivity(payload.transcript_path) : null;
  const earlierReads = activity ? await readsIn(activity.uses, cwd) : [];

  for (const probe of probes) {
    if (probe.path && (await declaresHelp(probe.path))) continue;
    const reads = [...earlierReads, ...(readsBefore.get(probe) ?? [])];
    if (reads.some((r) => sameScript(r, probe))) continue;
    return { decision: "deny", reason: refusal(probe) };
  }
  return null;
}

function refusal(probe) {
  const look = probe.remote
    ? `ssh ${probe.remote} head -40 ${probe.script}`
    : `head -40 ${probe.script}`;
  return (
    `FLAG-PROBE: \`${probe.invocation}\` guesses that ${basename(probe.script)} parses a help ` +
    "flag. Nothing in it says so, and this session has not read it; a script that ignores the " +
    `flag simply runs. Read it first (\`${look}\`); once it has been read, the call is allowed.`
  );
}

// ─── Finding the probes ─────────────────────────────────────────────────────────────────

/**
 * Every help-flag probe in `command`, and for each one the reads that come before it in the
 * same command (`head -40 x.sh; ./x.sh --help` is a read, then a probe).
 *
 * @param {string} command
 * @param {string} cwd
 * @returns {Promise<{ probes: Probe[], readsBefore: Map<Probe, Read[]> }>}
 */
async function inspect(command, cwd) {
  const probes = [];
  const readsBefore = new Map();
  const reads = [];
  await visit(command, cwd, null, 0, (kind, item) => {
    if (kind === "read") reads.push(item);
    else {
      probes.push(item);
      readsBefore.set(item, [...reads]);
    }
  });
  return { probes, readsBefore };
}

/**
 * Walk the commands of `text`, following `cd`, and report reads and probes in order. Payloads
 * of `bash -c` and `ssh host …` are walked the same way, three levels deep at most.
 *
 * @param {string} text
 * @param {string} cwd
 * @param {string | null} remote the ssh host the text runs on, if any
 * @param {number} depth
 * @param {(kind: "read" | "probe", item: any) => void} report
 */
async function visit(text, cwd, remote, depth, report) {
  if (depth > 3) return;
  const { events } = await listCommands(text);
  const cwdByScope = new Map([["", cwd]]);
  const vars = new Map();
  for (const event of events) {
    const key = event.scope.join("/");
    const here = nearest(cwdByScope, event.scope) ?? cwd;
    if (event.kind === "assignment") {
      vars.set(event.name, event.value);
      continue;
    }
    const argv = event.argv.map((w) => resolveWord(w, { cwd: here, vars }).text);
    const tool = basename(argv[0] ?? "");

    if (tool === "cd" && argv.length <= 2 && !remote) {
      cwdByScope.set(key, argv[1] ? resolve(here, argv[1]) : (process.env.HOME ?? here));
      continue;
    }
    const payload = nestedPayload(argv);
    if (payload) {
      await visit(payload.text, here, payload.remote ?? remote, depth + 1, report);
      continue;
    }
    if (READERS.has(tool) && !argv.some((a) => HELP_FLAGS.has(a))) {
      for (const arg of argv.slice(1)) {
        if (!arg.startsWith("-")) report("read", { name: basename(arg), path: localPath(arg, here, remote) });
      }
      continue;
    }
    const found = scriptIndex(argv);
    if (found && argv.slice(found.at + 1).some((a) => HELP_FLAGS.has(a))) {
      const script = argv[found.at];
      const path = remote ? null : await localScript(script, here, found);
      // A local word that is not a script on disk (a binary, a missing file) is nothing to protect.
      if (remote || path) report("probe", { script, path, remote, invocation: event.argv.join(" ") });
    }
  }
}

/** The text a `bash -c` / `sh -c` or an `ssh host` runs, if this command is one. */
function nestedPayload(argv) {
  const tool = basename(argv[0] ?? "");
  if (SHELLS.has(tool)) {
    const c = argv.findIndex((a, i) => i > 0 && /^-[a-zA-Z]*c[a-zA-Z]*$/.test(a));
    if (c > 0 && argv[c + 1] !== undefined) return { text: argv[c + 1], remote: null };
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

/**
 * The script this command RUNS, or null. Only the command position counts, and it matters who
 * put the script there: an interpreter opens it as a file, anything else runs it as a command.
 *
 * @returns {{ at: number, asFile: boolean, shell: boolean } | null}
 */
function scriptIndex(argv) {
  let i = 0;
  let asFile = false;
  let shell = false;
  while (i < argv.length) {
    const tool = basename(argv[i]);
    if (INTERPRETER_PAIRS.has(`${tool} ${argv[i + 1] ?? ""}`)) {
      i += 2;
      asFile = true;
    } else if (tool === "timeout") {
      i += 1;
      while (i < argv.length && argv[i].startsWith("-")) i += TIMEOUT_VALUED.has(argv[i]) ? 2 : 1;
      i += 1; // the duration
      asFile = false;
      continue;
    } else if (INTERPRETERS.has(tool)) {
      i += 1;
      asFile = true;
      shell = SHELLS.has(tool);
    } else if (RUNNERS.has(tool)) {
      i += 1;
      asFile = false;
    } else {
      return isScript(argv[i]) || asFile ? { at: i, asFile, shell } : null;
    }
    while (i < argv.length && (argv[i].startsWith("-") || /^[A-Za-z_]\w*=/.test(argv[i]))) {
      if (asFile && INLINE_CODE.has(argv[i])) return null; // `python3 -m pip`, `node -e '…'`
      i += 1;
    }
  }
  return null;
}

/** Could this word name a script? Confirmed against the disk later, where there is one. */
function isScript(word) {
  return SCRIPT_SUFFIX.test(word) || /^\.{1,2}\//.test(word) || (word.includes("/") && !word.endsWith("/"));
}

/**
 * The script file a word runs on this machine, or null. A path is a path; a bare name is found
 * the way its runner finds it: a command on PATH; an interpreter's file in the working directory,
 * then on PATH for a shell (bash does that, python does not). A compiled program
 * (`/usr/bin/git --help`) is not a script.
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
    if (file && (SCRIPT_SUFFIX.test(file) || (await startsWithShebang(file)))) return file;
    if (file) return null;
  }
  return null;
}

async function startsWithShebang(path) {
  let handle;
  try {
    handle = await open(path, "r");
    const head = Buffer.alloc(2);
    await handle.read(head, 0, 2, 0);
    return head.toString("latin1") === "#!";
  } catch {
    return false;
  } finally {
    await handle?.close();
  }
}

// ─── Deciding ───────────────────────────────────────────────────────────────────────────

/** Does the file's own source handle the flag? */
export async function declaresHelp(path) {
  let source;
  try {
    if ((await stat(path)).size > MAX_SOURCE_BYTES) return false;
    source = await readFile(path, "utf8");
  } catch {
    return false;
  }
  return source.includes("--help") || /(?:^|[\s(|'"])-h[)|'"]/m.test(source) || HELP_PARSERS.test(source);
}

/**
 * @typedef {{ name: string, path: string | null }} Read
 * @param {import("./transcript.mjs").ToolUse[]} uses
 * @param {string} cwd
 * @returns {Promise<Read[]>}
 */
async function readsIn(uses, cwd) {
  const reads = [];
  for (const use of uses) {
    if (use.name === "Read" && typeof use.input?.file_path === "string") {
      const path = resolve(cwd, use.input.file_path);
      reads.push({ name: basename(path), path });
    } else if (use.name === "Bash" && typeof use.input?.command === "string") {
      await visit(use.input.command, cwd, null, 0, (kind, item) => {
        if (kind === "read") reads.push(item);
      });
    }
  }
  return reads;
}

/** A local read matches by resolved path; a remote one can only match by name. */
function sameScript(read, probe) {
  if (probe.path && read.path) return read.path === probe.path;
  return read.name === basename(probe.script);
}

function localPath(word, cwd, remote) {
  if (remote) return null;
  return isAbsolute(word) ? word : resolve(cwd, word);
}

async function existingFile(path) {
  if (!path) return null;
  try {
    return (await stat(path)).isFile() ? path : null;
  } catch {
    return null;
  }
}

function nearest(map, scope) {
  for (let n = scope.length; n >= 0; n -= 1) {
    const key = scope.slice(0, n).join("/");
    if (map.has(key)) return map.get(key);
  }
  return undefined;
}
