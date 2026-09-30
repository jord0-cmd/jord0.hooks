// What a command line means to the shell before any program sees it: which words are wrappers
// that run the word after them, and which program finally runs. All three hooks ask this
// question, and each once kept its own table of wrappers. The tables drifted apart, so a command
// one hook saw through walked straight past another (`env -S`, `taskset MASK`, `/usr/bin/time`).
// There is one table now, and every hook reads it.
//
// `peel` removes wrapper words and reports what they changed on the way: variables set for the
// command (`env NAME=value`, `sudo NAME=value`), a directory it runs in (`env -C`), and a string a
// wrapper hands to `sh -c` (`flock … -c '…'`), which the caller reads as a payload.

import { basename } from "node:path";

export const RM_LIKE = new Set(["rm", "unlink", "shred"]);
export const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "ash"]);
export const FIND_EXEC = new Set(["-exec", "-execdir", "-ok", "-okdir"]);
export const CD = new Set(["cd", "pushd", "popd"]);

/** Wrappers stacked deeper than this are not followed; the caller judges where the command runs. */
export const MAX_PEEL = 12;

// Words that run the word after them, each with its options that take a value. `command`, `exec`
// and `builtin` are handled apart (`command -v` is a lookup and runs nothing), and so are `env`
// (it splits strings, changes directory and sets variables) and the ones with a positional
// operand of their own.
const WRAPPERS = new Map([
  ["sudo", new Set([
    "-u", "-g", "-C", "-D", "-h", "-p", "-r", "-t", "-U", "-T", "--user", "--group", "--prompt",
    "--chdir", "--role", "--type", "--close-from", "--host", "--other-user", "--command-timeout",
  ])],
  ["doas", new Set(["-u", "-C"])],
  ["nice", new Set(["-n", "--adjustment"])],
  ["ionice", new Set(["-c", "-n", "-p", "--class", "--classdata"])],
  ["stdbuf", new Set(["-i", "-o", "-e", "--input", "--output", "--error"])],
  ["nohup", new Set()],
  ["setsid", new Set()],
  ["busybox", new Set()],
  ["chronic", new Set()],
  ["time", new Set(["-o", "-f", "--output", "--format"])],
  // Options read from each tool's own --help (numactl 2.0, strace 6.x, util-linux 2.40 unshare).
  ["numactl", new Set(["-i", "-p", "-P", "-C", "-N", "-m", "-L", "-o", "-M", "-I", "-S", "-f"])],
  ["strace", new Set([
    "-e", "-a", "-o", "-s", "-X", "-O", "-S", "-P", "-p", "-U", "-I", "-b", "-E", "-u", "--argv0",
  ])],
  ["unshare", new Set([
    "-l", "--load-interp", "--propagation", "-R", "--root", "-w", "--wd", "-S", "--setuid", "-G",
    "--setgid", "--map-user", "--map-group", "--map-users", "--map-groups", "--setgroups",
    "--monotonic", "--boottime",
  ])],
]); // prettier-ignore
// Wrapper options that change the directory the command runs in (`unshare -w DIR`; `-R DIR`, a new
// root, which unshare also makes the working directory), or set a variable for it (`strace -E`).
const CHDIR = new Map([["unshare", new Set(["-w", "--wd", "-R", "--root"])]]);
const SETS_ENV = new Map([["strace", new Set(["-E", "--env"])]]);

// Wrappers that take one positional operand of their own before the command: `timeout 5 rm`,
// `flock lock rm`, `taskset 0x3 rm` (with -c the operand is a CPU list instead of a mask).
const POSITIONAL = new Map([
  ["timeout", new Set(["-s", "--signal", "-k", "--kill-after"])],
  ["flock", new Set(["-w", "--timeout", "-E", "--conflict-exit-code"])],
  ["taskset", new Set()],
  // the operand is a priority
  ["chrt", new Set(["-T", "-P", "-D", "--sched-runtime", "--sched-period", "--sched-deadline"])],
]); // prettier-ignore

const ENV_VALUED = new Set([
  "-u",
  "--unset",
  "-C",
  "--chdir",
  "-S",
  "--split-string",
  "-a",
  "--argv0",
]);
const ASSIGNMENT = /^([A-Za-z_]\w*)=(.*)$/s;

/**
 * @typedef {object} Peeled
 * @property {string[]} argv the program that really runs, then its arguments
 * @property {Array<[string, string]>} prefix `NAME=value` a wrapper sets for it (`env`, `sudo`)
 * @property {string[]} chdir each `env -C DIR` on the way, outermost first (a relative one is
 *   relative to the one before it)
 * @property {boolean} capped more than MAX_PEEL wrappers: `argv` is where peeling stopped
 */

/**
 * `argv` with its leading wrapper words removed, or null when nothing runs (`command -v rm`, a
 * wrapper with no command after it).
 *
 * @param {string[]} argv
 * @returns {Peeled | null}
 */
export function peel(argv) {
  let words = argv;
  const prefix = [];
  const chdir = [];
  for (let depth = 0; words.length > 0; depth += 1) {
    if (depth >= MAX_PEEL) return { argv: words, prefix, chdir, capped: true };
    const tool = basename(words[0]);
    let next;
    if (tool === "command" || tool === "exec" || tool === "builtin")
      next = afterBuiltin(tool, words);
    else if (tool === "env") next = peelEnv(words, prefix, chdir);
    else if (POSITIONAL.has(tool)) {
      const end = optionsEnd(tool, words);
      if (end < 0) return null;
      // `flock LOCK -c 'CMD'` and `flock -c 'CMD' LOCK`: flock hands CMD to `sh -c`.
      const cmd = tool === "flock" ? flockCommand(words) : undefined;
      if (cmd !== undefined) return { argv: ["sh", "-c", cmd], prefix, chdir, capped: false };
      next = words.slice(end + 1); // past the operand: a duration, a lock file, a mask or CPU list
    } else if (WRAPPERS.has(tool)) next = afterWrapper(tool, words, prefix, chdir);
    else break;
    if (next === null) return null;
    words = next;
  }
  return words.length > 0 ? { argv: words, prefix, chdir, capped: false } : null;
}

// `command -v NAME` is a lookup, but a `-v` AFTER the program is that program's flag
// (`command rm -v -rf`), so only a leading one counts. `exec -a NAME` renames the program: its
// value is skipped.
function afterBuiltin(tool, words) {
  let i = 1;
  while (i < words.length && words[i].startsWith("-") && words[i] !== "--") {
    if (tool === "command" && (words[i] === "-v" || words[i] === "-V")) return null;
    i += words[i] === "-a" ? 2 : 1;
  }
  if (words[i] === "--") i += 1;
  return words.slice(i);
}

// Where a positional wrapper's own options end, or -1 when it starts nothing: `taskset -p MASK
// PID` changes a running process.
function optionsEnd(tool, words) {
  const valued = POSITIONAL.get(tool);
  let i = 1;
  while (i < words.length && words[i].startsWith("-")) {
    if (tool === "taskset" && /^-(?:[a-z]*p[a-z]*|-pid)$/.test(words[i])) return -1;
    if (tool === "flock" && (words[i] === "-c" || words[i] === "--command")) break;
    i += valued.has(words[i]) ? 2 : 1;
  }
  return i;
}

// The command a flock hands to `sh -c`, wherever its -c sits, or undefined.
function flockCommand(words) {
  const c = words.findIndex((w, j) => j > 0 && (w === "-c" || w === "--command"));
  return c > 0 ? words[c + 1] : undefined;
}

// A wrapper from the table: its options skipped, `NAME=value` words after sudo or doas and a
// `-E NAME=value` recorded as the command's environment, and a directory option recorded.
function afterWrapper(tool, words, prefix, chdir) {
  const valued = WRAPPERS.get(tool);
  let i = 1;
  while (i < words.length) {
    const word = words[i];
    const set = ASSIGNMENT.exec(word);
    if (set && (tool === "sudo" || tool === "doas")) {
      prefix.push([set[1], set[2]]);
      i += 1;
    } else if (word === "--") {
      i += 1;
      break;
    } else if (word.startsWith("-")) {
      const eq = word.startsWith("--") ? word.indexOf("=") : -1;
      const option = eq > 0 ? word.slice(0, eq) : word;
      const value = eq > 0 ? word.slice(eq + 1) : words[i + 1];
      if (CHDIR.get(tool)?.has(option) && value !== undefined) chdir.push(value);
      const env = SETS_ENV.get(tool)?.has(option) ? ASSIGNMENT.exec(value ?? "") : null;
      if (env) prefix.push([env[1], env[2]]);
      i += eq < 0 && valued.has(word) ? 2 : 1;
    } else break;
  }
  return words.slice(i);
}

/**
 * The words after an `env` and its own options, `NAME=value` words and `-C DIR` recorded on the
 * way, and a `-S STRING` split into words in place, as env does. Null when nothing runs, a string
 * env refuses included.
 */
function peelEnv(words, prefix, chdir) {
  let i = 1;
  while (i < words.length) {
    const word = words[i];
    const eq = word.startsWith("--") ? word.indexOf("=") : -1;
    const option = eq > 0 ? word.slice(0, eq) : word;
    const attached = /^-[CSu]./.test(word) ? word.slice(2) : null; // `-Cdir`, `-S'rm x'`
    const valueOf = () => (eq > 0 ? word.slice(eq + 1) : (attached ?? words[i + 1]));
    const step = eq > 0 || attached !== null ? 1 : 2;
    const letter = attached !== null ? word.slice(0, 2) : option;
    if (letter === "-S" || letter === "--split-string") {
      const split = splitEnvString(valueOf() ?? "");
      return split === null ? null : [...split, ...words.slice(i + step)];
    }
    if (letter === "-C" || letter === "--chdir") {
      const dir = valueOf();
      if (dir !== undefined) chdir.push(dir);
      i += step;
      continue;
    }
    if (word === "--") return words.slice(i + 1);
    if (word === "-" || word === "-i" || word === "--ignore-environment") {
      i += 1;
      continue;
    }
    if (word.startsWith("-")) {
      i += ENV_VALUED.has(letter) && attached === null && eq < 0 ? 2 : 1;
      continue;
    }
    const set = ASSIGNMENT.exec(word);
    if (set) {
      prefix.push([set[1], set[2]]);
      i += 1;
      continue;
    }
    break;
  }
  return i < words.length ? words.slice(i) : null;
}

// The escapes `env -S` decodes to one character. Any other makes env refuse the whole string.
const ENV_ESCAPES = new Map([
  ["t", "\t"],
  ["n", "\n"],
  ["r", "\r"],
  ["f", "\f"],
  ["v", "\v"],
  ["#", "#"],
  ["$", "$"],
  ['"', '"'],
  ["'", "'"],
  ["\\", "\\"],
]);

/**
 * `env -S`'s string as the words GNU env makes of it, or null when env refuses it and runs nothing
 * (exit 125). Driven on coreutils 9.7: whitespace separates words, and so does `\_` (inside double
 * quotes it is a space); `\t \n \r \f \v` are those characters and `\# \$ \" \' \\` the
 * character itself; `\c` ends the string; a `#` that starts a word starts a comment; single quotes
 * keep everything but `\\` and `\'`. Refused: any other escape, `\c` inside double quotes, a
 * trailing backslash, an unterminated quote. `${NAME}` is kept as written: env fills it in from
 * its own environment.
 *
 * @param {string} text
 * @returns {string[] | null}
 */
function splitEnvString(text) {
  const out = [];
  let word = null;
  let quote = null;
  const end = () => {
    if (word !== null) out.push(word);
    word = null;
  };
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (quote === "'") {
      if (c === "'") quote = null;
      else if (c === "\\" && (text[i + 1] === "\\" || text[i + 1] === "'")) word += text[(i += 1)];
      else word += c;
    } else if (c === "\\") {
      const e = text[(i += 1)];
      if (e === undefined) return null;
      if (e === "_") {
        if (quote) word += " ";
        else end();
      } else if (e === "c") {
        if (quote) return null;
        break;
      } else if (ENV_ESCAPES.has(e)) word = (word ?? "") + ENV_ESCAPES.get(e);
      else return null;
    } else if (quote === '"') {
      if (c === '"') quote = null;
      else word += c;
    } else if (c === "'" || c === '"') {
      quote = c;
      word ??= "";
    } else if (/\s/.test(c)) end();
    else if (c === "#" && word === null) break;
    else word = (word ?? "") + c;
  }
  if (quote) return null;
  end();
  return out;
}

/**
 * The items `xargs` reads from text: split on blanks, with single quotes, double quotes and
 * backslash escapes honoured as xargs honours them.
 *
 * @param {string} text
 * @returns {string[]}
 */
export function splitString(text) {
  const out = [];
  let word = null;
  let quote = null;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (quote) {
      if (c === quote) quote = null;
      else if (c === "\\" && quote === '"' && i + 1 < text.length) word += text[(i += 1)];
      else word += c;
    } else if (c === "'" || c === '"') {
      quote = c;
      word ??= "";
    } else if (c === "\\" && i + 1 < text.length) {
      word = (word ?? "") + text[(i += 1)];
    } else if (/\s/.test(c)) {
      if (word !== null) out.push(word);
      word = null;
    } else word = (word ?? "") + c;
  }
  if (word !== null) out.push(word);
  return out;
}
