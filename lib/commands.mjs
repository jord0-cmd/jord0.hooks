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
  ["sudo", new Set(["-u", "-g", "-C", "-D", "-h", "-p", "-r", "-t", "-U", "-T", "--user", "--group", "--prompt", "--chdir", "--role", "--type", "--close-from", "--host", "--other-user", "--command-timeout"])],
  ["doas", new Set(["-u", "-C"])],
  ["nice", new Set(["-n", "--adjustment"])],
  ["ionice", new Set(["-c", "-n", "-p", "--class", "--classdata"])],
  ["stdbuf", new Set(["-i", "-o", "-e", "--input", "--output", "--error"])],
  ["nohup", new Set()],
  ["setsid", new Set()],
  ["busybox", new Set()],
  ["chronic", new Set()],
  ["time", new Set(["-o", "-f", "--output", "--format"])],
]); // prettier-ignore

// Wrappers that take one positional operand of their own before the command: `timeout 5 rm`,
// `flock lock rm`, `taskset 0x3 rm` (with -c the operand is a CPU list instead of a mask).
const POSITIONAL = new Map([
  ["timeout", new Set(["-s", "--signal", "-k", "--kill-after"])],
  ["flock", new Set(["-w", "--timeout", "-E", "--conflict-exit-code"])],
  ["taskset", new Set()],
]); // prettier-ignore

const ENV_VALUED = new Set(["-u", "--unset", "-C", "--chdir", "-S", "--split-string", "-a", "--argv0"]);
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
    if (tool === "command" || tool === "exec" || tool === "builtin") {
      // `command -v NAME` is a lookup, but a `-v` AFTER the program is that program's flag
      // (`command rm -v -rf`), so only a leading one counts. `exec -a NAME` renames; skip its value.
      let i = 1;
      while (i < words.length && words[i].startsWith("-") && words[i] !== "--") {
        if (tool === "command" && (words[i] === "-v" || words[i] === "-V")) return null;
        i += words[i] === "-a" ? 2 : 1;
      }
      if (words[i] === "--") i += 1;
      words = words.slice(i);
    } else if (tool === "env") {
      const next = peelEnv(words, prefix, chdir);
      if (next === null) return null;
      words = next;
    } else if (POSITIONAL.has(tool)) {
      const valued = POSITIONAL.get(tool);
      let i = 1;
      while (i < words.length && words[i].startsWith("-")) {
        // `taskset -p MASK PID` changes a running process and starts nothing.
        if (tool === "taskset" && /^-(?:[a-z]*p[a-z]*|-pid)$/.test(words[i])) return null;
        if (tool === "flock" && (words[i] === "-c" || words[i] === "--command")) break;
        i += valued.has(words[i]) ? 2 : 1;
      }
      if (tool === "flock") {
        // `flock LOCK -c 'CMD'` and `flock -c 'CMD' LOCK`: flock hands CMD to `sh -c`.
        const c = words.findIndex((w, j) => j > 0 && (w === "-c" || w === "--command"));
        if (c > 0 && words[c + 1] !== undefined) return { argv: ["sh", "-c", words[c + 1]], prefix, chdir, capped: false };
      }
      words = words.slice(i + 1); // past the operand: a duration, a lock file, a mask or CPU list
    } else if (WRAPPERS.has(tool)) {
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
          i += valued.has(word) ? 2 : 1;
        } else break;
      }
      words = words.slice(i);
    } else break;
  }
  return words.length > 0 ? { argv: words, prefix, chdir, capped: false } : null;
}

/**
 * The words after an `env` and its own options, `NAME=value` words and `-C DIR` recorded on the
 * way, and a `-S STRING` split into words in place, as env does.
 */
function peelEnv(words, prefix, chdir) {
  let i = 1;
  while (i < words.length) {
    const word = words[i];
    const eq = word.startsWith("--") ? word.indexOf("=") : -1;
    const option = eq > 0 ? word.slice(0, eq) : word;
    const attached = /^-[CSu]./.test(word) ? word.slice(2) : null; // `-Cdir`, `-S'rm x'`
    const valueOf = () => (eq > 0 ? word.slice(eq + 1) : attached ?? words[i + 1]);
    const step = eq > 0 || attached !== null ? 1 : 2;
    const letter = attached !== null ? word.slice(0, 2) : option;
    if (letter === "-S" || letter === "--split-string") {
      const split = splitString(valueOf() ?? "");
      return [...split, ...words.slice(i + step)];
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

/**
 * `env -S`'s string as the words it becomes: split on whitespace, with single quotes, double
 * quotes and backslash escapes honoured as env honours them.
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
