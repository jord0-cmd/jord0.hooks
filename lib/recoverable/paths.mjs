// Turning the words of a command into the absolute paths it would touch, the way the shell
// would: `~` and `$VAR` resolved by the caller, relative paths joined to the directory the
// command runs in, and globs expanded against the disk.

import { lstatSync, opendirSync, readdirSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, posix, relative, resolve, sep } from "node:path";

/**
 * One operand as the absolute paths it names. A glob that matches nothing stays literal, as
 * bash leaves it.
 *
 * `..` is resolved the way the kernel resolves it, through the disk: in `link/../x` the `..` is the
 * parent of wherever `link` points, which is not what cutting the string gives. A trailing slash
 * names the directory itself, through a symlink: `rm -rf link/` deletes what `link` points to.
 *
 * @param {string} base the directory the command runs in
 * @param {string} operand already expanded
 * @param {boolean} [glob] whether the shell globs this word (false when its pattern was quoted)
 * @returns {string[]}
 */
export function absolute(base, operand, glob = true) {
  // Joined as text: `path.join` would cut every `..` out of the string before the disk is asked.
  const full = physical(isAbsolute(operand) ? operand : `${base}/${operand}`);
  const through = /\/\.?$/.test(operand) ? realOrSelf(full) : full;
  if (!glob || !/[*?[]/.test(through)) return [through];
  const matches = expandGlob(through);
  return matches.length > 0 ? matches.sort() : [through];
}

/**
 * `path` with `.` dropped and each `..` taken from the real directory before it, so a symlink
 * earlier in the path is followed, as the kernel does. The last component is left as written:
 * `rm link` removes the link.
 */
function physical(path) {
  const parts = path.split("/");
  if (!parts.includes("..")) return posix.normalize(path);
  let current = "/";
  for (const part of parts) {
    if (part === "" || part === ".") continue;
    current = part === ".." ? dirname(realOrSelf(current)) : join(current, part);
  }
  return current;
}

/** Does anything exist at this path (a dangling symlink counts: rm removes it)? */
export function exists(path) {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * The directories directly inside `dir`, never through a symlink, reading at most `budget` of its
 * entries, and whether `dir` holds a `.git` (read with the rest, or one lstat when the budget cut
 * the listing short, however wide the directory). An unreadable directory gives nothing: a delete
 * cannot read it either.
 *
 * @param {string} dir
 * @param {number} budget entries to read at most
 * @returns {{ dirs: string[], read: number, git: boolean }}
 */
export function listDirectories(dir, budget) {
  const dirs = [];
  let read = 0;
  let git = false;
  let whole = false; // every entry was read, so `git` is already known
  let handle;
  try {
    handle = opendirSync(dir);
  } catch {
    return { dirs, read, git: false };
  }
  try {
    while (read < budget) {
      const entry = handle.readSync();
      if (entry === null) {
        whole = true;
        break;
      }
      read += 1;
      if (entry.name === ".git") git = true;
      else if (entry.isDirectory()) dirs.push(join(dir, entry.name));
    }
  } catch {
    // a directory removed while it was read has nothing more to give
  } finally {
    handle.closeSync();
  }
  return { dirs, read, git: whole ? git : hasEntry(join(dir, ".git")) };
}

/** Does anything exist at this path, without the cost of an exception when nothing does? */
function hasEntry(path) {
  try {
    return lstatSync(path, { throwIfNoEntry: false }) !== undefined;
  } catch {
    return false;
  }
}

/** A directory that is not a symlink to one. */
export function isRealDirectory(path) {
  try {
    return lstatSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** A directory, reached through symlinks: where a command runs, or where git is asked. */
export function isDirectory(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * `path` relative to the work tree `top`, or null when it lies outside it. The parent is
 * resolved through symlinks and the last component is not, because `rm link` removes the link
 * and not what it points to.
 *
 * @param {string} top
 * @param {string} path
 */
export function inside(top, path) {
  const realTop = realOrSelf(top);
  const name = basename(path);
  const real =
    name === "" || name === "." || name === ".."
      ? realOrSelf(path)
      : join(realOrSelf(dirname(path)), name);
  if (real === realTop) return ".";
  if (real.startsWith(realTop + sep)) return relative(realTop, real);
  return null;
}

export function realOrSelf(path) {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/** Bash-style glob expansion, segment by segment: `*` and `?` never match a leading dot. */
function expandGlob(pattern) {
  const parts = pattern.split("/");
  let found = [parts[0] === "" ? "/" : parts[0]];
  for (const part of parts.slice(1)) {
    if (part === "") continue;
    if (!/[*?[]/.test(part)) {
      found = found.map((dir) => join(dir, part)).filter(exists);
      continue;
    }
    const re = segmentRegex(part);
    const next = [];
    for (const dir of found) {
      let names;
      try {
        names = readdirSync(dir);
      } catch {
        continue;
      }
      for (const name of names) {
        if (name.startsWith(".") && !part.startsWith(".")) continue;
        if (re.test(name)) next.push(join(dir, name));
      }
    }
    found = next;
  }
  return found;
}

function segmentRegex(part) {
  try {
    return segmentRegexOrThrow(part);
  } catch {
    // An invalid bracket (`[z-a]`) is not a pattern to bash either: it matches itself.
    return new RegExp(`^${part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`);
  }
}

function segmentRegexOrThrow(part) {
  let out = "";
  for (let i = 0; i < part.length; i += 1) {
    const c = part[i];
    if (c === "*") out += "[^/]*";
    else if (c === "?") out += "[^/]";
    else if (c === "[") {
      const close = part.indexOf("]", i + 2);
      if (close < 0) {
        out += "\\[";
        continue;
      }
      let body = part.slice(i + 1, close);
      if (body.startsWith("!")) body = `^${body.slice(1)}`;
      out += `[${body.replace(/\\/g, "\\\\")}]`;
      i = close;
    } else out += c.replace(/[.+^${}()|\\]/g, "\\$&");
  }
  return new RegExp(`^${out}$`);
}
