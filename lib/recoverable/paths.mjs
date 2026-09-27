// Turning the words of a command into the absolute paths it would touch, the way the shell
// would: `~` and `$VAR` resolved by the caller, relative paths joined to the directory the
// command runs in, and globs expanded against the disk.

import { lstatSync, readdirSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, posix, relative, resolve, sep } from "node:path";

/**
 * One operand as the absolute paths it names. A glob that matches nothing stays literal, as
 * bash leaves it.
 *
 * @param {string} base the directory the command runs in
 * @param {string} operand already expanded by resolveWord
 * @returns {string[]}
 */
export function absolute(base, operand) {
  const full = posix.normalize(isAbsolute(operand) ? operand : join(base, operand));
  if (!/[*?[]/.test(full)) return [full];
  const matches = expandGlob(full);
  return matches.length > 0 ? matches.sort() : [full];
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

/** A directory that is not a symlink to one. */
export function isRealDirectory(path) {
  try {
    return lstatSync(path).isDirectory();
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
  const real = name === "" || name === "." || name === ".." ? realOrSelf(path) : join(realOrSelf(dirname(path)), name);
  if (real === realTop) return ".";
  if (real.startsWith(realTop + sep)) return relative(realTop, real);
  return null;
}

function realOrSelf(path) {
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
