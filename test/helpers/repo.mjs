// A small git work tree holding every kind of file RECOVERABLE has to tell apart:
//
//   tracked_clean.txt, cleandir/a.txt   tracked, no edits      (git can give them back)
//   src/mod.py                          tracked, unstaged edit (the uncommitted fix)
//   wip/notes.md, wip/deep/plate.png    untracked              (never reached git)
//   build/, node_modules/, *.pyc        ignored                (a rebuild gives them back)

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { scratchDir } from "./scratch.mjs";

export function gitIn(dir, ...args) {
  return execFileSync("git", ["-c", "user.email=t@example.invalid", "-c", "user.name=t", ...args], {
    cwd: dir,
    stdio: ["ignore", "pipe", "pipe"],
  }).toString("utf8");
}

export function makeTree() {
  const root = scratchDir("jord0-hooks-tree-");
  const t = join(root, "tree");
  const write = (rel, data) => {
    mkdirSync(join(t, rel, ".."), { recursive: true });
    writeFileSync(join(t, rel), data);
  };
  write(".gitignore", "build/\nnode_modules/\n*.pyc\n");
  write("tracked_clean.txt", "clean\n");
  write("src/mod.py", "x = 1\n");
  write("cleandir/a.txt", "a\n");
  gitIn(t, "init", "-q", "-b", "main", ".");
  gitIn(t, "add", "-A");
  gitIn(t, "commit", "-q", "-m", "base");
  write("src/mod.py", "x = 2  # the uncommitted fix\n");
  write("wip/notes.md", "in-flight\n");
  write("wip/deep/plate.png", "\x89PNG");
  write("build/out.o", "\0");
  write("node_modules/x/index.js", "1\n");
  write("src/__pycache__/mod.cpython-312.pyc", "\0");
  write("list.txt", "wip\n");
  try {
    gitIn(t, "update-index", "-q", "--refresh"); // settle stat info so status is deterministic
  } catch {
    // exits 1 when a file is modified, which src/mod.py is, on purpose
  }
  return t;
}
