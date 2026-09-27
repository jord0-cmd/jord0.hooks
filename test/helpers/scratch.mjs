// Temporary directories for tests, removed when the test process exits.
//
// The suite makes a git work tree for nearly every RECOVERABLE test, and one test fills a
// directory with six thousand files. Left behind, two days of runs filled a 32 GB tmpfs's
// inode table (a million entries) while its bytes were still 92% free, and the next write to
// /tmp failed with "No space left on device". So everything made here goes when the process
// does, whether the tests passed or not.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** @type {string[]} */
const made = [];

process.on("exit", () => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

/**
 * A fresh directory under the system temp directory, removed when the process exits.
 *
 * @param {string} prefix e.g. "jord0-hooks-tree-"
 */
export function scratchDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  made.push(dir);
  return dir;
}
