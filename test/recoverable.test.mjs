// RECOVERABLE, in two layers.
//
// The judges, called directly with commands that are already unwrapped: every verdict about
// WHAT is lost, and every hardening of HOW git is asked.
//
// The whole hook, through the real entry script: the command shapes the dispatcher has to see
// through. These lists are the acceptance for lib/recoverable/dispatch.mjs.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, it } from "node:test";
import { pathToFileURL } from "node:url";

import * as recoverable from "../lib/recoverable/index.mjs";
import * as judges from "../lib/recoverable/judges.mjs";
import { resolveWord } from "../lib/shell.mjs";
import { ROOT, decisionOf, reasonOf, runHook } from "./helpers/hook.mjs";
import { gitIn, makeTree } from "./helpers/repo.mjs";

let tree;
beforeEach(() => {
  tree = makeTree();
});

const ctx = (agentId = "", before = []) => ({
  base: tree,
  agentId,
  before,
  resolve: (word) => resolveWord(word, { cwd: tree }),
});
const words = (text) => text.split(" ");

describe("judges: what a delete would lose", () => {
  it("asks on the main thread, naming the untracked victims", async () => {
    const v = await judges.rm(words("rm -rf wip"), ctx());
    assert.equal(v.decision, "ask");
    assert.match(v.reason, /wip\/deep\/plate\.png, wip\/notes\.md \(2 paths, untracked or edited/);
  });

  it("denies a subagent and says whose work it is", async () => {
    const v = await judges.rm(words("rm -rf wip"), ctx("agent-1"));
    assert.equal(v.decision, "deny");
    assert.match(v.reason, /work that is not yours/);
    assert.match(v.reason, /belongs to the main session/);
  });

  for (const cmd of ["rm -r wip", "rm -rf wip/", "rm -rf ./wip/deep", "rm --recursive --force wip", "rm -rf wip/*", "rm -rf src"]) {
    it(`loses work: ${cmd}`, async () => {
      assert.equal((await judges.rm(words(cmd), ctx()))?.decision, "ask");
    });
  }

  for (const cmd of ["rm -rf build", "rm -rf node_modules", "rm -rf cleandir", "rm -rf does-not-exist", "rm -f wip/notes.md"]) {
    it(`loses nothing git cannot return: ${cmd}`, async () => {
      assert.equal(await judges.rm(words(cmd), ctx()), null);
    });
  }

  it("judges a single-file delete when a subagent makes it", async () => {
    assert.equal((await judges.rm(words("rm -f wip/notes.md"), ctx("agent-1")))?.decision, "deny");
  });

  it("judges where it runs when a target cannot be read", async () => {
    const v = await judges.rm(["rm", "-rf", "$UNSET_ANYWHERE_X/wip"], ctx());
    assert.equal(v?.decision, "ask");
    assert.match(v.reason, /a target this guard cannot read/);
  });

  it("says nothing outside a repository", async () => {
    const outside = join(tree, "..", "loose");
    mkdirSync(join(outside, "d"), { recursive: true });
    writeFileSync(join(outside, "d", "f"), "x");
    assert.equal(await judges.rm(["rm", "-rf", join(outside, "d")], ctx()), null);
  });
});

describe("judges: find", () => {
  for (const cmd of ["find wip -delete", "find . -name notes.md -delete", "find wip -type f -exec rm {} +"]) {
    it(`loses work: ${cmd}`, async () => {
      assert.equal((await judges.find(words(cmd), ctx()))?.decision, "ask");
    });
  }

  for (const cmd of ["find . -name *.pyc -delete", "find . -name __pycache__ -type d -exec rm -rf {} +", "find wip -name *.md"]) {
    it(`loses nothing: ${cmd}`, async () => {
      assert.equal(await judges.find(words(cmd), ctx()), null);
    });
  }

  it("dry-runs through the system find, never a `find` in the working directory", async () => {
    const decoy = join(tree, "find");
    writeFileSync(decoy, `#!/bin/sh\necho ran > "${tree}/decoy-ran"\n`);
    chmodSync(decoy, 0o755);
    await judges.find(["./find", "wip", "-delete"], ctx());
    assert.equal(existsSync(join(tree, "decoy-ran")), false);
  });

  it("stays quiet on a sweep far larger than any cap one would guess", async () => {
    const cache = join(tree, "src", "__pycache__");
    for (let i = 0; i < 6000; i += 1) writeFileSync(join(cache, `m${i}.cpython-312.pyc`), "");
    assert.equal(await judges.find(words("find . -name *.pyc -delete"), ctx()), null);
    assert.equal((await judges.find(words("find . -delete"), ctx()))?.decision, "ask");
  });
});

describe("judges: xargs-fed rm", () => {
  it("dry-runs a printing find feeder exactly as written", async () => {
    assert.equal((await judges.pipeFedRm(["rm", "-rf"], { kind: "find", argv: words("find . -name wip") }, ctx()))?.decision, "ask");
    assert.equal(await judges.pipeFedRm(["rm", "-f"], { kind: "find", argv: words("find . -name *.pyc") }, ctx()), null);
  });

  it("reads the operands from an input file", async () => {
    assert.equal((await judges.pipeFedRm(["rm", "-rf"], { kind: "file", path: "list.txt" }, ctx()))?.decision, "ask");
  });

  it("judges where it runs when the feeder cannot be read", async () => {
    const v = await judges.pipeFedRm(["rm", "-rf"], { kind: "unknown" }, ctx());
    assert.match(v.reason, /its input cannot be read/);
  });
});

describe("judges: git", () => {
  const loud = [
    "git restore src/mod.py",
    "git restore .",
    "git checkout .",
    "git checkout -- src/mod.py",
    "git checkout src/mod.py",
    "git checkout -f",
    "git clean -f",
    "git clean -fd",
    "git clean -fdx wip",
    "git -C . clean -f",
    "git switch --discard-changes main",
    "git switch -f main",
    "git checkout-index -f -a",
    "git checkout-index --force src/mod.py",
    "git rm -f src/mod.py",
    "git rm -rf src",
    "git reset --hard",
    "git reset --hard HEAD~0",
  ];
  for (const cmd of loud) {
    it(`loses work: ${cmd}`, async () => {
      assert.equal((await judges.git(words(cmd), ctx()))?.decision, "ask");
      assert.equal((await judges.git(words(cmd), ctx("agent-1")))?.decision, "deny");
    });
  }

  const quiet = [
    "git restore --staged src/mod.py",
    "git restore tracked_clean.txt",
    "git checkout -- tracked_clean.txt",
    "git checkout -b some-branch",
    "git switch -c other",
    "git clean -n",
    "git clean -nfd",
    "git clean --dry-run -fd wip",
    "git clean -f cleandir",
    "git clean -fX",
    "git checkout-index -a",
    "git rm --cached src/mod.py",
    "git rm src/mod.py",
    "git stash list",
    "git stash push -u",
    "git stash drop",
    "git status --short",
  ];
  for (const cmd of quiet) {
    it(`loses nothing: ${cmd}`, async () => {
      assert.equal(await judges.git(words(cmd), ctx()), null);
    });
  }

  it("treats a staged edit as safe from `checkout -- f`, which restores from the index", async () => {
    gitIn(tree, "add", "src/mod.py");
    assert.equal(await judges.git(words("git checkout -- src/mod.py"), ctx()), null);
    assert.equal((await judges.git(words("git checkout HEAD -- src/mod.py"), ctx()))?.decision, "ask");
  });

  it("asks before dropping a stash that holds something", async () => {
    gitIn(tree, "stash", "push", "-u", "-q");
    assert.equal((await judges.git(words("git stash drop"), ctx()))?.decision, "ask");
    assert.equal((await judges.git(words("git stash clear"), ctx("agent-1")))?.decision, "deny");
  });

  it("asks when the same command stashes first and then drops", async () => {
    const before = [words("git stash -u")];
    assert.equal((await judges.git(words("git stash drop"), ctx("", before)))?.decision, "ask");
  });
});

describe("judges: asking git without running the repository's programs", () => {
  it("never executes core.fsmonitor", async () => {
    const trap = join(tree, "..", "fsmon.sh");
    writeFileSync(trap, `#!/bin/sh\necho ran > "${tree}/../fsmonitor-ran"\n`);
    chmodSync(trap, 0o755);
    gitIn(tree, "config", "core.fsmonitor", trap);
    await judges.rm(words("rm -rf wip"), ctx());
    await judges.git(words("git checkout -- src/mod.py"), ctx());
    assert.equal(existsSync(join(tree, "..", "fsmonitor-ran")), false);
  });

  it("never executes a clean filter selected by .gitattributes", async () => {
    writeFileSync(join(tree, ".gitattributes"), "*.py filter=evil\n");
    gitIn(tree, "config", "filter.evil.clean", `sh -c 'echo ran >> "${tree}/../filter-ran"; cat'`);
    // Same size as the committed "x = 1\n", so git cannot tell from stat alone and must hash
    // the file, which is when it runs a clean filter. A size change would never exercise it.
    writeFileSync(join(tree, "src", "mod.py"), "x = 9\n");
    const v = await judges.git(words("git checkout -- src/mod.py"), ctx());
    assert.equal(v?.decision, "ask", "the edit must still be seen");
    assert.equal(existsSync(join(tree, "..", "filter-ran")), false);
  });

  it("carries every pin on git's command line, where even git 2.30 honours it", async () => {
    // GIT_CONFIG_COUNT arrived in git 2.31, and git 2.30 was driven ignoring it. A shim ahead
    // of the real git records every call's arguments.
    const realGit = execFileSync("sh", ["-c", "command -v git"]).toString().trim();
    const shimDir = join(tree, "..", "shim");
    const log = join(tree, "..", "git-calls.log");
    mkdirSync(shimDir);
    writeFileSync(join(shimDir, "git"), `#!/bin/sh\nprintf '%s\\n' "$*" >> "${log}"\nexec "${realGit}" "$@"\n`);
    chmodSync(join(shimDir, "git"), 0o755);
    const saved = process.env.PATH;
    process.env.PATH = `${shimDir}:${saved}`;
    try {
      await judges.git(words("git checkout -- src/mod.py"), ctx());
      await judges.rm(words("rm -rf wip"), ctx());
    } finally {
      process.env.PATH = saved;
    }
    const calls = readFileSync(log, "utf8").trim().split("\n").filter((c) => !/^version\b/.test(c));
    assert.ok(calls.length >= 3, calls.join("\n"));
    for (const call of calls) {
      assert.match(call, /-c core\.fsmonitor= /, call);
      assert.match(call, /-c core\.hooksPath=\/dev\/null /, call);
      assert.match(call, /-c log\.showSignature=false /, call);
    }
  });

  it("names git's own subcommand when a call runs out of time", async () => {
    const realGit = execFileSync("sh", ["-c", "command -v git"]).toString().trim();
    const shimDir = join(tree, "..", "slow");
    mkdirSync(shimDir);
    writeFileSync(join(shimDir, "git"), `#!/bin/sh\ncase " $* " in *" status "*) sleep 3 ;; esac\nexec "${realGit}" "$@"\n`);
    chmodSync(join(shimDir, "git"), 0o755);
    const saved = process.env.PATH;
    process.env.PATH = `${shimDir}:${saved}`;
    try {
      await assert.rejects(judges.rm(words("rm -rf wip"), ctx()), (err) => {
        assert.ok(err instanceof judges.ProbeFailed);
        assert.equal(err.message, "git status: timed out after 2000 ms");
        return true;
      });
    } finally {
      process.env.PATH = saved;
    }
  });

  it("refuses to guess on a git older than 2.26, which cannot list a repository's filters", () => {
    // The version is read once per process, so this runs in a fresh one, with a git that says 2.25.
    const realGit = execFileSync("sh", ["-c", "command -v git"]).toString().trim();
    const shimDir = join(tree, "..", "old");
    mkdirSync(shimDir);
    writeFileSync(join(shimDir, "git"), `#!/bin/sh\n[ "$1" = version ] && { echo "git version 2.25.0"; exit 0; }\nexec "${realGit}" "$@"\n`);
    chmodSync(join(shimDir, "git"), 0o755);
    const judgesUrl = pathToFileURL(join(ROOT, "lib", "recoverable", "judges.mjs")).href;
    const shellUrl = pathToFileURL(join(ROOT, "lib", "shell.mjs")).href;
    const script = `
      import * as judges from ${JSON.stringify(judgesUrl)};
      import { resolveWord } from ${JSON.stringify(shellUrl)};
      const ctx = { base: process.cwd(), agentId: "", before: [], resolve: (w) => resolveWord(w, { cwd: process.cwd() }) };
      try { await judges.rm(["rm", "-rf", "wip"], ctx); console.log("NO ERROR"); }
      catch (err) { console.log(err instanceof judges.ProbeFailed ? "ProbeFailed: " + err.message : "OTHER: " + err.message); }`;
    const out = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
      cwd: tree,
      env: { ...process.env, PATH: `${shimDir}:${process.env.PATH}` },
    }).toString("utf8").trim();
    assert.equal(out, "ProbeFailed: git 2.25 is older than 2.26 and cannot list this repository's filters");
  });

  it("keeps working when a blanked filter is marked required", async () => {
    writeFileSync(join(tree, ".gitattributes"), "*.py filter=lfsish\n");
    gitIn(tree, "config", "filter.lfsish.clean", `sh -c 'echo ran >> "${tree}/../filter-ran"; cat'`);
    gitIn(tree, "config", "filter.lfsish.required", "true");
    writeFileSync(join(tree, "src", "mod.py"), "x = 9\n");
    const v = await judges.git(words("git checkout -- src/mod.py"), ctx());
    assert.equal(v?.decision, "ask");
    assert.equal(existsSync(join(tree, "..", "filter-ran")), false);
  });

  it("raises ProbeFailed, never stays silent, when the repository's config is broken", async () => {
    writeFileSync(join(tree, ".git", "config"), "[core\n\tthis is not config\n");
    await assert.rejects(judges.rm(words("rm -rf wip"), ctx()), judges.ProbeFailed);
    await assert.rejects(judges.git(words("git checkout -- ."), ctx()), judges.ProbeFailed);
  });

  it("raises ProbeFailed, never allows, when git cannot answer inside a repository", async () => {
    writeFileSync(join(tree, ".git", "index"), "this is not an index");
    await assert.rejects(judges.rm(words("rm -rf wip"), ctx()), judges.ProbeFailed);
  });
});

describe("judges: round 1 of review", () => {
  it("asks through a symlinked working directory", async () => {
    const link = join(tree, "..", "link");
    symlinkSync(tree, link);
    const through = { ...ctx(), base: link, resolve: (w) => resolveWord(w, { cwd: link }) };
    assert.equal((await judges.git(words("git checkout -- ."), through))?.decision, "ask");
  });

  it("judges where it runs when a git word cannot be read", async () => {
    const v1 = await judges.git(["git", "checkout", "--", "$(git diff --name-only)"], ctx());
    const v2 = await judges.git(["git", "-C", "$UNSET_ANYWHERE_X", "reset", "--hard"], ctx());
    assert.equal(v1?.decision, "ask");
    assert.equal(v2?.decision, "ask");
    assert.match(v1.reason, /a word this guard cannot read/);
  });

  it("judges a delete of several files on the main thread", async () => {
    writeFileSync(join(tree, "a.md"), "a");
    writeFileSync(join(tree, "b.md"), "b");
    assert.equal((await judges.rm(words("rm -f a.md b.md"), ctx()))?.decision, "ask");
  });

  it("judges the whole tree for a magic pathspec or a pathspec file", async () => {
    assert.equal((await judges.git(["git", "checkout", "--", ":!*.tmp"], ctx()))?.decision, "ask");
    assert.equal((await judges.git(words("git restore --pathspec-from-file=list.txt"), ctx()))?.decision, "ask");
  });

  it("counts commits on no remote and the stash when .git or the whole tree goes", async () => {
    gitIn(tree, "commit", "--allow-empty", "-qm", "only here");
    const git = await judges.rm(words("rm -rf .git"), ctx("agent-1"));
    assert.equal(git?.decision, "deny");
    assert.match(git.reason, /2 commits on no remote/);
    gitIn(tree, "stash", "push", "-q", "--", "src/mod.py");
    const whole = await judges.rm(["rm", "-rf", tree], ctx());
    assert.match(whole?.reason ?? "", /give back: 2 commits on no remote, the stash, and list\.txt, /);
  });

  it("treats -x beside -X as removing everything untracked", async () => {
    assert.equal((await judges.git(words("git clean -fXx"), ctx()))?.decision, "ask");
    assert.equal(await judges.git(words("git clean -fX"), ctx()), null);
  });

  it("counts a conflicted merge's paths as work in progress", async () => {
    gitIn(tree, "stash", "push", "-q", "--", "src/mod.py");
    gitIn(tree, "checkout", "-qb", "other");
    writeFileSync(join(tree, "src", "mod.py"), "x = 3\n");
    gitIn(tree, "commit", "-qam", "other side");
    gitIn(tree, "checkout", "-q", "main");
    writeFileSync(join(tree, "src", "mod.py"), "x = 4\n");
    gitIn(tree, "commit", "-qam", "this side");
    try {
      gitIn(tree, "merge", "-q", "other");
    } catch {
      // the conflict is the point
    }
    assert.equal((await judges.git(words("git checkout -- src/mod.py"), ctx()))?.decision, "ask");
  });
});

describe("judges: round 1b (the missing-lens seat)", () => {
  for (const argv of [
    ["git", "checkout", "--", "*.py"],
    ["git", "checkout", "HEAD", "--", "*.py"],
    ["git", "restore", "-SW", "*.py"],
    ["git", "rm", "-f", "*.py"],
  ]) {
    it(`judges the whole tree for a glob pathspec: ${argv.join(" ")}`, async () => {
      assert.equal((await judges.git(argv, ctx()))?.decision, "ask");
    });
  }

  for (const argv of [
    ["find", "wip", "-print", "-delete"],
    ["find", "wip", "-type", "f", "-print", "-delete"],
    ["find", "wip", "-printf", "%p\\n", "-delete"],
    ["find", "wip", "-ls", "-delete"],
  ]) {
    it(`dry-runs a find that also prints: ${argv.join(" ")}`, async () => {
      assert.equal((await judges.find(argv, ctx()))?.decision, "ask");
    });
  }

  it("dry-runs a printing feeder that formats its output", async () => {
    const feed = { kind: "find", argv: ["find", "wip", "-printf", "%p\\n"] };
    assert.equal((await judges.pipeFedRm(["rm", "-rf"], feed, ctx()))?.decision, "ask");
  });

  it("judges `git clean -d` without -f when the repository does not require -f", async () => {
    assert.equal(await judges.git(words("git clean -d"), ctx()), null);
    gitIn(tree, "config", "clean.requireForce", "false");
    assert.equal((await judges.git(words("git clean -d"), ctx()))?.decision, "ask");
    assert.equal((await judges.git(words("git clean -d"), ctx("agent-1")))?.decision, "deny");
    assert.equal(await judges.git(words("git -c clean.requireForce=true clean -d"), ctx()), null);
  });

  it("judges `git clean -d` when the command itself lifts the -f requirement", async () => {
    for (const cmd of [
      "git -c clean.requireForce=false clean -d",
      "git -c clean.requireforce=off clean",
      "git --config-env=clean.requireForce=V clean -d",
      "git --config-env clean.requireForce=V clean -d",
    ]) {
      assert.equal((await judges.git(words(cmd), ctx()))?.decision, "ask", cmd);
    }
  });

  it("counts a commit made on a detached HEAD, or kept only by a tag, as history on no remote", async () => {
    gitIn(tree, "update-ref", "refs/remotes/origin/main", "HEAD"); // every branch is pushed
    assert.equal(await judges.rm(words("rm -rf .git"), ctx()), null);
    gitIn(tree, "checkout", "-q", "--detach");
    gitIn(tree, "commit", "--allow-empty", "-qm", "made while detached");
    assert.match((await judges.rm(words("rm -rf .git"), ctx()))?.reason ?? "", /1 commit on no remote/);
    gitIn(tree, "tag", "kept");
    gitIn(tree, "checkout", "-q", "main");
    assert.match((await judges.rm(words("rm -rf .git"), ctx()))?.reason ?? "", /1 commit on no remote/);
  });

  it("names no lost history for a linked worktree, whose commits live in the main tree", async () => {
    gitIn(tree, "worktree", "add", "-q", "../wt");
    writeFileSync(join(tree, "..", "wt", "notes.md"), "mine");
    const v = await judges.rm(words("rm -rf ../wt"), ctx());
    assert.equal(v?.decision, "ask");
    assert.doesNotMatch(v.reason, /on no remote/);
    assert.match(v.reason, /notes\.md/);
    assert.match((await judges.rm(words("rm -rf .git"), ctx()))?.reason ?? "", /1 commit on no remote/);
  });

  it("judges `git worktree remove --force`, which deletes a dirty worktree whole", async () => {
    gitIn(tree, "worktree", "add", "-q", "../wt");
    assert.equal(await judges.git(words("git worktree remove --force ../wt"), ctx()), null); // clean
    writeFileSync(join(tree, "..", "wt", "notes.md"), "mine");
    for (const cmd of ["git worktree remove --force ../wt", "git worktree remove -f ../wt"]) {
      const v = await judges.git(words(cmd), ctx());
      assert.equal(v?.decision, "ask", cmd);
      assert.match(v.reason, /notes\.md/);
      assert.doesNotMatch(v.reason, /on no remote/);
    }
    assert.equal((await judges.git(words("git worktree remove -f ../wt"), ctx("agent-1")))?.decision, "deny");
    assert.equal(await judges.git(words("git worktree remove ../wt"), ctx()), null); // git itself refuses
  });

  describe("git's own data, inside .git", () => {
    for (const cmd of ["rm -f .git/index", "rm -rf .git/objects", "rm -rf .git/refs", "rm -f .git/HEAD"]) {
      it(`names it: ${cmd}`, async () => {
        const v = await judges.rm(words(cmd), ctx());
        assert.equal(v?.decision, "ask");
        assert.match(v.reason, new RegExp(`git's own data \\(${cmd.split(" ").at(-1).replace(".", "\\.")}\\)`));
        assert.equal((await judges.rm(words(cmd), ctx("agent-1")))?.decision, "deny");
      });
    }

    it("leaves a stale lock and the last fetch's record alone", async () => {
      writeFileSync(join(tree, ".git", "index.lock"), "");
      assert.equal(await judges.rm(words("rm -f .git/index.lock"), ctx()), null);
      assert.equal(await judges.rm(words("rm -f .git/FETCH_HEAD"), ctx()), null);
      assert.equal(await judges.find(words("find .git -name *.lock -delete"), ctx()), null);
    });

    it("names it when a find sweep reaches inside .git", async () => {
      assert.match((await judges.find(words("find . -name index -delete"), ctx()))?.reason ?? "", /git's own data \(\.git\/index\)/);
      assert.equal((await judges.find(words("find .git -delete"), ctx()))?.decision, "ask");
    });
  });

  describe("a git command that names its repository", () => {
    // The command runs from a clean directory outside the dirty tree.
    let away;
    const from = (extra = {}) => ({ ...ctx(), base: away, resolve: (w) => resolveWord(w, { cwd: away }), ...extra });
    beforeEach(() => {
      away = join(tree, "..", "away");
      mkdirSync(away);
    });

    for (const spell of [
      (t) => `git --work-tree=${t} --git-dir=${t}/.git clean -fd`,
      (t) => `git --git-dir=${t}/.git --work-tree=${t} checkout -- .`,
      (t) => `git --git-dir ${t}/.git --work-tree ${t} reset --hard`,
    ]) {
      it(`asks about the repository it names: ${spell("<tree>")}`, async () => {
        assert.equal((await judges.git(words(spell(tree)), from()))?.decision, "ask");
      });
    }

    it("reads GIT_DIR and GIT_WORK_TREE from the command's prefix", async () => {
      const prefix = [["GIT_DIR", `${tree}/.git`], ["GIT_WORK_TREE", tree]];
      assert.equal((await judges.git(words("git clean -fd"), from({ prefix })))?.decision, "ask");
      assert.equal((await judges.git(words("git clean -fd"), from({ prefix, agentId: "agent-1" })))?.decision, "deny");
    });

    it("treats the working directory as the work tree when only --git-dir is given, as git does", async () => {
      writeFileSync(join(away, "draft.md"), "mine");
      const v = await judges.git(words(`git --git-dir=${tree}/.git clean -fd`), from());
      assert.equal(v?.decision, "ask");
      assert.match(v.reason, /draft\.md/);
    });

    it("stays silent when the repository it names has nothing at stake", async () => {
      assert.equal(await judges.git(words(`git --git-dir=${tree}/.git --work-tree=${tree} clean -fdX`), from()), null);
    });
  });

  it("judges where it runs when a list file names something that does not resolve", async () => {
    writeFileSync(join(tree, "quoted.txt"), '"wip"\n');
    const v = await judges.pipeFedRm(["rm", "-rf"], { kind: "file", path: "quoted.txt" }, ctx());
    assert.equal(v?.decision, "ask");
  });
});

describe("the assembly, around a dispatcher that finds nothing", () => {
  const nothing = async () => null;
  const run = (command, { agentId = "", dispatch = nothing, cwd = tree } = {}) =>
    recoverable.judge(
      { tool_name: "Bash", tool_input: { command }, cwd, ...(agentId ? { agent_id: agentId } : {}) },
      { signal: new AbortController().signal, dispatch },
    );
  // Valid bash (it ran, and deleted wip/), that the grammar cannot parse.
  const unreadable = "cat <<EOF; rm -rf wip\nbody\nEOF";

  it("judges where the call runs when part of the command could not be parsed", async () => {
    const main = await run(unreadable);
    assert.equal(main?.decision, "ask");
    assert.match(main.reason, /^RECOVERABLE: a command this guard cannot fully parse would destroy/);
    assert.equal((await run(unreadable, { agentId: "agent-1" }))?.decision, "deny");
  });

  it("stays silent when the unparsed command runs outside any repository", async () => {
    const loose = join(tree, "..", "loose");
    mkdirSync(loose);
    assert.equal(await run(unreadable, { cwd: loose }), null);
  });

  it("stays silent when everything parsed and the dispatcher found nothing", async () => {
    assert.equal(await run("ls -la"), null);
  });

  it("returns the dispatcher's own verdict first", async () => {
    const verdict = { decision: "ask", reason: "RECOVERABLE: from the dispatcher" };
    assert.deepEqual(await run(unreadable, { dispatch: async () => verdict }), verdict);
  });

  it("turns a git that cannot answer into ask, and deny inside a subagent", async () => {
    const failing = async () => {
      throw new judges.ProbeFailed("git status: timed out");
    };
    assert.match((await run("ls", { dispatch: failing }))?.reason ?? "", /could not ask git .* timed out/);
    assert.equal((await run("ls", { dispatch: failing, agentId: "agent-1" }))?.decision, "deny");
  });
});

describe("the hook: a malformed payload", () => {
  it("asks when the payload carries no command, never stays silent", async () => {
    const result = await runHook("recoverable", { tool_name: "Bash", tool_input: {}, cwd: tree }, { cwd: tree });
    assert.equal(decisionOf(result.answer), "ask");
    assert.match(reasonOf(result.answer), /no tool_input\.command string/); // not the failure path
  });

  it("stays out of a call to another tool", async () => {
    const payload = { tool_name: "BashOutput", tool_input: { bash_id: "b1" }, cwd: tree };
    assert.equal(decisionOf((await runHook("recoverable", payload, { cwd: tree })).answer), "silent");
  });
});

// ─── The whole hook: the shapes the dispatcher must see through ─────────────────────────

async function hook(command, { agent = false, cwd = tree } = {}) {
  const payload = {
    session_id: "test",
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command },
    cwd,
    ...(agent ? { agent_id: "agent-1", agent_type: "general-purpose" } : {}),
  };
  const result = await runHook("recoverable", payload, { cwd });
  assert.equal(result.code, 0, result.stderr);
  return { decision: decisionOf(result.answer), reason: reasonOf(result.answer) };
}

const LOUD = [
  "rm -rf wip",
  "sh -c 'rm -rf wip'",
  "find $(echo wip) -delete",
  "git checkout -- src/mod.py",
  "cd wip && rm -rf deep",
  // Verifier round 2 on the fleet guard: every one of these walked past a regex segmenter.
  "( rm -rf wip )",
  "(rm -rf wip)",
  "find wip -exec env rm -rf {} +",
  "find wip -exec busybox rm -rf {} +",
  "find wip -exec sudo rm -rf {} ;",
  "find wip -type f -exec xargs rm {} +",
  "echo wip | xargs -I{} rm -rf {}",
  "echo wip | xargs -I % rm -rf %",
  "echo wip | xargs -i rm -rf {}",
  "git ls-files --others | xargs -I{} rm -f {}",
  "xargs rm -rf < list.txt",
  "xargs -a list.txt rm -rf",
  "if true; then rm -rf wip; fi",
  "for f in wip; do rm -rf $f; done",
  "while true; do rm -rf wip; break; done",
  "true && { rm -rf wip; }",
  "! rm -rf wip",
  "time rm -rf wip",
  "eval 'rm -rf wip'",
  "echo $(rm -rf wip)",
  "(cd /tmp && true); rm -rf wip",
  "S=build; S=wip; rm -rf $S",
  "rm -rf $S; S=build",
  'for f in notes.md; do rm -rf "wip/$f"; done',
  "bash <<'EOF'\nrm -rf wip\nEOF",
  "git switch --discard-changes -c other",
  "git switch -f -c other",
  "git checkout-index -f -a",
  "git rm -f src/mod.py",
  "git rm -rf src",
  // Round 1b: statements behind bash's reserved words, and commands a redirection runs.
  "time ( rm -rf wip )",
  "time { rm -rf wip; }",
  "coproc ( rm -rf wip )",
  "echo hi > $(rm -rf wip)",
  "cat <<EOF\n$(rm -rf wip)\nEOF",
  "cat <<EOF; rm -rf wip\nbody\nEOF", // valid bash the grammar cannot parse: judged where it runs
  "cd .. && git --git-dir=tree/.git --work-tree=tree checkout -- .",
  "cd .. && GIT_DIR=tree/.git GIT_WORK_TREE=tree git clean -fd", // the dispatcher hands the judge `prefix`
  // Within the floor, found by a fresh-context review: a command reached through a pipe-to-shell,
  // a here-string, xargs running git, a find -exec running a shell or git, a failed cd, and
  // wrappers (flock, builtin, env -C, a deep chain).
  "echo 'rm -rf wip' | bash",
  "bash <<< 'rm -rf wip'",
  "bash -ce 'rm -rf wip'",
  "git diff --name-only | xargs git checkout --",
  "find wip -exec sh -c 'rm -rf \"$0\"' {} ;",
  "find . -name '*.py' -exec git checkout -- {} +",
  "cd nope; rm -rf wip",
  "flock lock rm -rf wip",
  "builtin cd wip && rm -rf deep",
  "env -C wip rm -rf deep",
  "sudo env FOO=1 nice -n 19 ionice -c3 timeout 600 nohup stdbuf -oL rm -rf wip",
];

const QUIET = [
  "ls -la",
  "rm -rf build",
  "rm -f wip/notes.md",
  'find . -name "*.pyc" -delete',
  'find . -name "*.pyc" -print0 | xargs -0 rm -f',
  "git status --short",
  'echo "rm -rf wip"',
  'git commit -m "find wip -delete"',
  "command -v rm",
  "type rm",
  "which rm find git",
  "man rm",
  "cat <<'EOF'\nrm -rf wip\nfind wip -delete\nEOF",
  "python3 - <<'PY'\nimport shutil\n# rm -rf wip\nPY",
  'grep -rn "rm -rf" .',
  "((rm -rf wip))",
  "S=wip; S=build; rm -rf $S",
  "rm -rf $(mktemp -d)",
  "git switch -c other",
  "git rm --cached src/mod.py",
  "echo done > wip/notes.md.bak",
  "cat <<'EOF'\n$(rm -rf wip)\nEOF",
  // Harmless shapes the within-floor changes must not start asking about.
  "echo hello | bash",
  "echo 'ls -la' | bash",
  "git diff --name-only | xargs echo",
  "find . -name '*.log' -exec sh -c 'echo {}' ;",
  "flock -w 5 lock ls",
  "bash script.sh",
];

// A broken hook fails closed and asks on EVERYTHING, which would pass the loud list for the
// wrong reason. So each loud verdict must also come from a judge ("RECOVERABLE: …"), and the
// quiet list below is the half that no broken hook can pass.
const FROM_A_JUDGE = /^RECOVERABLE: /;

describe("the hook: loud shapes ask the main thread and are denied to a subagent", () => {
  for (const command of LOUD) {
    it(JSON.stringify(command), async () => {
      const main = await hook(command);
      const sub = await hook(command, { agent: true });
      assert.equal(main.decision, "ask", command);
      assert.match(main.reason, FROM_A_JUDGE, main.reason);
      assert.equal(sub.decision, "deny", command);
      assert.match(sub.reason, FROM_A_JUDGE, sub.reason);
    });
  }

  it("agrees on relative, cd-resolved and absolute spellings", async () => {
    const parent = join(tree, "..");
    for (const answer of [
      await hook("rm -rf wip"),
      await hook(`cd ${tree} && rm -rf wip`, { cwd: parent }),
      await hook(`rm -rf ${tree}/wip`, { cwd: parent }),
    ]) {
      // A judge's reason, as for every loud shape: a hook that fails closed asks too.
      assert.equal(answer.decision, "ask");
      assert.match(answer.reason, FROM_A_JUDGE, answer.reason);
    }
  });
});

describe("the hook: shapes a fresh-context review turned up", () => {
  // Each is valid bash that deletes (or the control that must not), driven through the real hook.
  const asks = [
    "[[ -n $(cat <<EOF; rm -rf wip\nbody\nEOF\n) ]]", // a command hidden in $( ) under [[ ]], not arithmetic
    "sh -c 'cat <<EOF; rm -rf wip\nbody\nEOF'",         // the unparsed span is in the nested payload
    "command rm -v -rf wip",                              // -v is rm's flag, not `command`'s lookup
    "exec rm -rf wip",
    "eval eval eval eval eval eval rm -rf wip",           // past the recursion cap: judged, not dropped
  ];
  for (const command of asks) {
    it(JSON.stringify(command), async () => {
      const main = await hook(command);
      assert.equal(main.decision, "ask", command);
      const sub = await hook(command, { agent: true });
      assert.equal(sub.decision, "deny", command);
    });
  }

  it("still stays silent on arithmetic and a genuine `command` lookup", async () => {
    assert.equal((await hook("((rm -rf wip))")).decision, "silent");
    assert.equal((await hook("command -v rm")).decision, "silent");
  });
});

describe("the hook: quiet shapes stay silent in a dirty tree", () => {
  for (const command of QUIET) {
    it(JSON.stringify(command), async () => {
      const { decision, reason } = await hook(command);
      assert.equal(decision, "silent", `${command} → ${decision}: ${reason}`);
    });
  }
});
