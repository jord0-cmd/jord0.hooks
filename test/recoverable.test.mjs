// RECOVERABLE, in two layers.
//
// The judges, called directly with commands that are already unwrapped: every verdict about
// WHAT is lost, and every hardening of HOW git is asked.
//
// The whole hook, through the real entry script: the command shapes the dispatcher has to see
// through. These lists are the acceptance for lib/recoverable/dispatch.mjs.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, it } from "node:test";
import { pathToFileURL } from "node:url";

import * as recoverable from "../lib/recoverable/index.mjs";
import * as judges from "../lib/recoverable/judges.mjs";
import { listDirectories } from "../lib/recoverable/paths.mjs";
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
    assert.match(v.reason, /whose input this guard cannot read/);
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
    const before = [{ argv: words("git stash -u"), certain: true, base: tree }];
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

  // A partial clone keeps some objects on its promisor remote, and git fetches one the moment
  // anything reads it, `git status` included. The fetch runs the transport the REPOSITORY's
  // config names. Round 2 drove both of these to a run on git 2.47 before the pins existed.
  for (const [transport, config] of [
    ["core.sshCommand over an ssh URL", (trap) => [["remote.origin.url", "ssh://example.invalid/x.git"], ["core.sshCommand", trap]]],
    ["remote.origin.uploadpack over a local URL", (trap) => [["remote.origin.url", join(tree, "..", "nowhere.git")], ["remote.origin.uploadpack", trap]]],
  ]) {
    it(`never runs the promisor transport a partial clone names: ${transport}`, async () => {
      const ran = join(tree, "..", "transport-ran");
      const trap = join(tree, "..", "transport.sh");
      writeFileSync(trap, `#!/bin/sh\necho "$@" > "${ran}"\nexit 1\n`);
      chmodSync(trap, 0o755);
      gitIn(tree, "config", "extensions.partialClone", "origin");
      gitIn(tree, "config", "remote.origin.promisor", "true");
      for (const [key, value] of config(trap)) gitIn(tree, "config", key, value);
      const head = gitIn(tree, "rev-parse", "HEAD^{tree}").trim();
      rmSync(join(tree, ".git", "objects", head.slice(0, 2), head.slice(2))); // HEAD's tree is now only promised
      await assert.rejects(judges.rm(words("rm -rf wip"), ctx()), judges.ProbeFailed);
      assert.equal(existsSync(ran), false, `the repository's transport ran: ${existsSync(ran) ? readFileSync(ran, "utf8") : ""}`);
    });
  }

  it("carries every pin on git's command line, where even git 2.30 honours it", async () => {
    // GIT_CONFIG_COUNT arrived in git 2.31, and git 2.30 was driven ignoring it. A shim ahead
    // of the real git records every call's arguments.
    const realGit = execFileSync("sh", ["-c", "command -v git"]).toString().trim();
    const shimDir = join(tree, "..", "shim");
    const log = join(tree, "..", "git-calls.log");
    mkdirSync(shimDir);
    writeFileSync(join(shimDir, "git"), `#!/bin/sh\nprintf '%s NO_LAZY=%s\\n' "$*" "$GIT_NO_LAZY_FETCH" >> "${log}"\nexec "${realGit}" "$@"\n`);
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
      assert.match(call, /-c protocol\.allow=never /, call);
      assert.match(call, /NO_LAZY=1$/, call);
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

  it("reads an unreadable pathspec as the whole tree after its flags, an unreadable repository where it runs", async () => {
    // Round 2: an unreadable pathspec used to fall back before the flags were read, so
    // `restore --staged` and `rm --cached` fed by xargs asked. Now the flags decide first, and
    // the reason names what the command itself loses, not everything dirty where it runs.
    const v1 = await judges.git(["git", "checkout", "--", "$(git diff --name-only)"], ctx());
    assert.equal(v1?.decision, "ask");
    assert.match(v1.reason, /^RECOVERABLE: `git checkout` would destroy .*src\/mod\.py/);
    assert.doesNotMatch(v1.reason, /wip\//, "checkout from the index cannot touch untracked files");
    assert.equal(await judges.git(["git", "restore", "--staged", "--", "$(git diff --name-only)"], ctx()), null);
    assert.equal(await judges.git(["git", "rm", "--cached", "--", "$(git ls-files)"], ctx()), null);
    const v2 = await judges.git(["git", "-C", "$UNSET_ANYWHERE_X", "reset", "--hard"], ctx());
    assert.equal(v2?.decision, "ask");
    assert.match(v2.reason, /in a repository this guard cannot read/);
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

async function hook(command, { agent = false, cwd = tree, env = {} } = {}) {
  const payload = {
    session_id: "test",
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command },
    cwd,
    ...(agent ? { agent_id: "agent-1", agent_type: "general-purpose" } : {}),
  };
  const result = await runHook("recoverable", payload, { cwd, env });
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
  "git switch --discard-changes main", // driven: discards the edit even to the branch it is on
  "git switch -f main",
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
  "find wip -exec sh -c 'rm -rf \"$0\"' {} ;",
  "flock lock rm -rf wip",
  "builtin cd wip && rm -rf deep",
  "env -C wip rm -rf deep",
  "sudo env FOO=1 nice -n 19 ionice -c3 timeout 600 nohup stdbuf -oL rm -rf wip",
  "bash -o pipefail -c 'rm -rf wip'",
  "taskset -c 0 rm -rf wip",
  "echo rm -rf wip | bash",
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
  "command -v rm -rf wip", // a lookup of three names; without the lookup rule it would be a delete
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
  "git switch -f -c other", // driven on git 2.47: a branch made at HEAD keeps the edit
  "git switch --discard-changes -c other",
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
  // Safe commands the routing must never start asking about (fresh-context review, round 2).
  "cd \"$(mktemp -d)\" && rm -rf *",
  "mkdir -p scratch && cd scratch && rm -rf *",
  "git ls-files --deleted | xargs git restore --staged",
  "git ls-files | xargs git rm --cached",
  "eval echo \"it's fine\"",
];

// A broken hook fails closed and asks on EVERYTHING, which would pass the loud list for the
// wrong reason. So each loud verdict must also come from a judge ("RECOVERABLE: …"), and the
// quiet list below is the half that no broken hook can pass.
const FROM_A_JUDGE = /^RECOVERABLE: /;

// And a judge's fallback (judging everything dirty where the command runs) names the right files
// too, on this fixture, for a command that really deletes wip. So each loud command also says
// what its reason must name and must NOT name: a delete of wip names wip/notes.md and never
// src/mod.py, which only the fallback would mention. A shape that is SUPPOSED to fall back says so.
const WIP = { names: /wip\/notes\.md/, not: /src\/mod\.py/ };
const EDIT = { names: /src\/mod\.py/, not: /wip\// };
const DEEP = { names: /wip\/deep\/plate\.png/, not: /notes\.md|src\/mod\.py/ };
const FALLBACK = { names: /this guard cannot read|cannot fully parse|more wrappers than this guard follows/ };
const TOO_DEEP = { names: /nested deeper than this guard follows/ };
const EXPECT = new Map([
  ["find $(echo wip) -delete", FALLBACK],
  ["git checkout -- src/mod.py", EDIT],
  ["cd wip && rm -rf deep", DEEP],
  ["git ls-files --others | xargs -I{} rm -f {}", FALLBACK],
  ["rm -rf $S; S=build", FALLBACK],
  ['for f in notes.md; do rm -rf "wip/$f"; done', { names: /wip\/notes\.md/, not: /plate|src\/mod\.py/ }],
  ["git switch --discard-changes main", EDIT],
  ["git switch -f main", EDIT],
  ["git checkout-index -f -a", EDIT],
  ["git rm -f src/mod.py", EDIT],
  ["git rm -rf src", EDIT],
  ["cat <<EOF; rm -rf wip\nbody\nEOF", FALLBACK],
  ["cd .. && git --git-dir=tree/.git --work-tree=tree checkout -- .", EDIT],
  ["builtin cd wip && rm -rf deep", DEEP],
  ["env -C wip rm -rf deep", DEEP],
]);

describe("the hook: loud shapes ask the main thread and are denied to a subagent", () => {
  for (const command of LOUD) {
    it(JSON.stringify(command), async () => {
      const main = await hook(command);
      const sub = await hook(command, { agent: true });
      assert.equal(main.decision, "ask", command);
      assert.match(main.reason, FROM_A_JUDGE, main.reason);
      const { names, not } = EXPECT.get(command) ?? WIP;
      assert.match(main.reason, names, main.reason);
      if (not) assert.doesNotMatch(main.reason, not, main.reason);
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
    "eval eval eval eval eval eval rm -rf wip",           // nested evals are followed to the rm
  ];
  for (const command of asks) {
    it(JSON.stringify(command), async () => {
      const main = await hook(command);
      assert.equal(main.decision, "ask", command);
      if (command.startsWith("eval")) assert.match(main.reason, /^RECOVERABLE: `rm` would destroy .*wip\/notes\.md/, main.reason);
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

// ── round 2 of review (a bench of five, Opus 5 alone, one Fable pass) ──────────────────────────
// Every shape below was driven against the hook before its fix: a silent loss, or a false alarm.

const LOUD_ROUND_2 = [
  // Wrappers the one shared table now sees through.
  ["env -S 'rm -rf wip'", WIP],
  ["env --split-string='rm -rf wip'", WIP],
  ["taskset 0x3 rm -rf wip", WIP],
  ["/usr/bin/time -o /dev/null rm -rf wip", WIP],
  ["env -u FOO -C wip rm -rf deep", DEEP],
  ["sudo env -C wip rm -rf deep", DEEP],
  [`${"nice ".repeat(11)}rm -rf wip`, WIP], // eleven wrapper words are peeled
  [`${"nice ".repeat(12)}rm -rf wip`, FALLBACK], // twelve, and it is judged where it runs
  // Shells fed a script every way the text shows it.
  ["bash --rcfile /dev/null -c 'rm -rf wip'", WIP],
  ["echo 'rm -rf wip' | bash -s -- x", WIP],
  ["echo -e 'rm -rf wip\\n' | bash", WIP],
  ["cat <<'EOF' | bash\nrm -rf wip\nEOF", WIP],
  ["cat <<'EOF' | tee /dev/null | sh\nrm -rf wip\nEOF", WIP],
  ["bash < <(echo 'rm -rf wip')", WIP],
  ["trap 'rm -rf wip' EXIT", WIP],
  ["f() { rm -rf wip; }; f", WIP],
  ["S=wip sh -c 'rm -rf $S'", WIP],
  // The directory and the variables, followed the way the shell follows them.
  ["eval 'cd wip'; rm -rf deep", DEEP],
  ["f() { cd wip; }; f; rm -rf deep", DEEP],
  ["cd /tmp | cat; rm -rf wip", WIP],
  ["cd /tmp & rm -rf wip", WIP],
  ["false && cd /tmp; rm -rf wip", WIP],
  ["if false; then cd /tmp; fi; rm -rf wip", WIP],
  ["cd cleandir && cd - && rm -rf wip", WIP],
  ["pushd cleandir && popd && rm -rf wip", WIP],
  ["S=build; unset S; rm -rf wip$S", WIP],
  ["cd nosuchdir || rm -rf wip", WIP], // the rm runs exactly when the cd FAILED, so here
  ["cd nosuchdir; rm -rf wip", WIP], // the cd fails, the shell stays, the rm runs here
  // The one-file exemption counts files, and counts them across the call.
  ["rm wip/*.md", { names: /wip\/notes\.md/ }],
  ["rm list.txt; rm wip/notes.md", { names: /list\.txt.*wip\/notes\.md/ }],
  ["for f in list.txt wip/notes.md; do rm $f; done", { names: /list\.txt.*wip\/notes\.md/ }],
  ["rm {list.txt,wip/notes.md}", { names: /list\.txt.*wip\/notes\.md/ }],
  ["DIRS='wip src'; rm -rf $DIRS", { names: /src\/mod\.py.*wip\// }],
  // A find or xargs feeding a shell or git.
  ["find wip -type f -exec sh -c 'rm \"$0\"' {} \;", { names: /wip\/notes\.md/, not: /src\/mod\.py/ }],
  ["find wip -type f | xargs -I{} sh -c 'rm \"{}\"'", { names: /wip\/notes\.md/, not: /src\/mod\.py/ }],
  ["find wip -type f -print0 | xargs -0 sh -c 'rm \"$@\"' _", { names: /wip\/notes\.md/, not: /src\/mod\.py/ }],
  ["git diff --name-only | xargs git checkout --", EDIT],
  ["find src -name '*.py' -exec git checkout -- {} +", EDIT],
  ["echo wip | xargs rm -rf", WIP],
  ["xargs rm -rf <<< wip", WIP],
  // Git, as git behaves.
  ["git clean -f wip", WIP],
  ["git clean -fde build", WIP],
  ["git read-tree -u --reset HEAD", EDIT],
  ["git add -A && git reset --hard", { names: /src\/mod\.py.*wip\/|wip\/.*src\/mod\.py/ }],
  // One reason names every loss in the call.
  ["rm -rf wip && git reset --hard", { names: /`rm`: .*wip\/notes\.md.*`git reset --hard`: .*src\/mod\.py/ }],
  // Wrapper options that take a value, a directory a wrapper names, and a name a wrapper gives.
  ["env -Cwip rm -rf deep", DEEP],
  ["env --chdir=wip rm -rf deep", DEEP],
  ["exec -a x rm -rf wip", WIP],
  ["timeout -k 5 10 rm -rf wip", WIP],
  ["flock -w 5 lock rm -rf wip", WIP],
  // A script on the shell's standard input, a value set at run time, a payload that will not parse.
  ["bash /dev/stdin <<'EOF'\nrm -rf wip\nEOF", WIP],
  ["S=build; read S <<< wip; rm -rf $S", FALLBACK],
  ["eval 'cat <<EOF; rm -rf wip\nbody\nEOF'", FALLBACK],
  ["git checkout-index --stdin --force < list.txt", EDIT],
  // Payloads within payloads are followed to the command, up to a depth, and judged where they run past it.
  [`${"eval ".repeat(15)}rm -rf wip`, WIP],
  [`${"eval ".repeat(16)}rm -rf wip`, TOO_DEEP],
  // A documented limit: a directory something other than mkdir makes in the call is not known to
  // be there, so the delete is judged there and where the call started. This one asks, and is safe.
  ["cp -r cleandir newdir; cd newdir; rm -rf *", { names: /src\/mod\.py.*wip\/notes\.md/ }],
  // What xargs is handed. An item that names nothing is nothing to lose, and the rest is judged;
  // an item under xargs' own quoting that names nothing here may name something there.
  ["echo wip does-not-exist | xargs rm -rf", WIP],
  ["echo \"'wi p'\" | xargs rm -rf", FALLBACK],
  ["echo 'wi\\ p' | xargs -I{} rm -rf {}", FALLBACK],
  // A program named by a variable the call set: the shell runs what the variable holds.
  ["R=rm; $R -rf wip", WIP],
  ["R=rm; ${R} -rf wip", WIP],
  ["export R=rm; $R -rf wip", WIP],
  ["R='rm -rf'; $R wip", WIP], // an unquoted expansion splits: the flags come with it
  ["R=rm; sudo $R -rf wip", WIP],
  ["W=sudo; $W rm -rf wip", WIP], // a wrapper in a variable is still a wrapper
  ["W=sudo; R=rm; $W $R -rf wip", WIP],
  ["G=git; $G checkout -- src/mod.py", EDIT],
  ["F=find; $F wip -delete", WIP],
  ["X=xargs; echo wip | $X rm -rf", WIP],
  ["S=bash; $S -c 'rm -rf wip'", WIP],
  ["if true; then R=rm; else R=ls; fi; $R -rf wip", WIP], // either may run: each is judged
  ["for p in ls rm; do $p -rf wip; done", WIP],
  // Round 3. A save that may not run saves nothing; a save's paths are read where it ran.
  ["false && git add -A; rm -rf wip", WIP],
  ["if false; then git add -A; fi\nrm -rf wip", WIP],
  ["true || git stash push -u -q; rm -rf wip", WIP],
  ["cd src; git add mod.py; cd ..; rm -rf wip src", { names: /wip\/notes\.md/, not: /src\/mod\.py/ }],
  ["f() { git add -A; }; false && f; rm -rf wip", WIP], // a function called behind `&&` may not run
  ["trap 'git add -A' EXIT; rm -rf wip", WIP], // a trap runs at the end, after the delete
  // `"$@"` in the program's place is every word it holds.
  ["sh -c 'exec \"$@\"' _ rm -rf wip", WIP],
  ["bash -c '\"$@\"' _ rm -rf wip", WIP],
  // A branch made from a start point takes the work tree to it (driven, git 2.47): the edits go.
  ["git switch -f -c hot HEAD", EDIT],
  ["git switch -f -C hot main", EDIT],
  // More values than the guard follows: judged where it runs, never dropped.
  ["for f in a b c d e f g h rm; do $f -rf wip; done", { names: /more values than this guard follows/ }],
  // Two expansions that multiply past the limit: a wrapper that may be one of three, a program one of five.
  ["if true; then W=sudo; else W=nice; fi; for f in a b c d rm; do $W $f -rf wip; done", { names: /more values than this guard follows/ }],
  // A stash that may run before a drop: the drop may take what it stashed.
  ["true && git stash push -u -q; git stash drop", { names: /src\/mod\.py/ }],
  // Opus 5, round 3. rm's flags are read after expansion; a later save does not reach back;
  // a file a find or xargs feeds is not a plainly named one; a directory it cannot read is judged.
  ["F=-rf; rm $F wip", WIP],
  ["rm list.txt; rm wip/notes.md; git add -A", { names: /list\.txt, wip\/notes\.md/ }],
  ["find wip -name notes.md -exec sh -c 'rm \"$1\"' _ {} \\;", { names: /wip\/notes\.md/ }],
  ["echo wip/notes.md | xargs -I{} sh -c 'rm \"{}\"'", { names: /wip\/notes\.md/ }],
  ["env -C $UNSET_IN_THIS_CALL rm -rf wip", { names: /whose directory this guard cannot read/ }],
];

const QUIET_ROUND_2 = [
  "git clean -fd does-not-exist",
  "git checkout-index -f -a --prefix=/tmp/export/",
  "git add -A && rm -rf wip", // the index holds it: `git restore` brings it back
  "git stash push -u -q && rm -rf wip", // the stash holds it
  "eval eval eval eval eval eval echo hi",
  "rm -rf .",
  "rm -rf wip/.",
  "rm -rf 'wi*'", // a quoted pattern is a literal name, and no file has it
  'rm -rf "build[z-a]"', // an invalid bracket is literal too, not a crash
  "rm -f .git/refs/heads/main.lock",
  "cd nosuchdir && rm -rf *", // the cd fails, so the rm never runs
  "mkdir -p scratch; cd scratch; rm -rf *", // the mkdir made it: the cd succeeds
  "echo build | xargs rm -rf",
  "echo does-not-exist | xargs rm -rf", // names nothing: rm -f would say nothing either
  "echo 'wi*' | xargs rm -rf", // xargs runs no shell: the `*` is a character, and no file has it
  "xargs -0 rm -rf <<< \"'wip'\"", // with -0 a quote is a character too
  'for d in build node_modules; do rm -rf "$d"; done',
  "R=ls; $R -rf wip",
  "R=rm; R=ls; $R -rf wip", // the value it holds when it runs
  "(R=rm); $R -rf wip", // set in a subshell, gone after it
  "R=rm; echo $R -rf wip", // a mention
  "R=rm; $R -f list.txt", // one file, plainly named, on the main thread
  "G=git; $G add -A && rm -rf wip", // the add, read through its variable, put the files in the index
  "C=command; $C -v rm -rf wip", // a lookup through a variable runs nothing
  "W=sudo; $W git add -A && rm -rf wip", // the add runs under the wrapper, and still saves the files
  "git add -A; rm -rf wip", // a save that certainly ran
  "git add -A; rm list.txt; rm wip/notes.md", // saved before the deletes
  "env -C $UNSET_IN_THIS_CALL ls", // a directory it cannot read, and a program that deletes nothing
];

describe("the hook: round 2 shapes ask, naming exactly what they lose", () => {
  for (const [command, { names, not }] of LOUD_ROUND_2) {
    it(JSON.stringify(command), async () => {
      const main = await hook(command);
      assert.equal(main.decision, "ask", `${command} → ${main.decision}`);
      assert.match(main.reason, FROM_A_JUDGE, main.reason);
      assert.match(main.reason, names, main.reason);
      if (not) assert.doesNotMatch(main.reason, not, main.reason);
      assert.equal((await hook(command, { agent: true })).decision, "deny", command);
    });
  }
});

describe("the hook: round 2 false alarms stay silent", () => {
  for (const command of QUIET_ROUND_2) {
    it(JSON.stringify(command), async () => {
      const { decision, reason } = await hook(command);
      assert.equal(decision, "silent", `${command} → ${decision}: ${reason}`);
    });
  }

  it("never counts a clean repository's commits for a target it cannot read", async () => {
    gitIn(tree, "stash", "push", "-u", "-q"); // nothing dirty left; one commit on no remote
    for (const command of ["rm -rf $UNSET_X/scratch", "ls | xargs rm -rf", "git checkout -- $(git diff --name-only)"]) {
      const { decision, reason } = await hook(command);
      assert.equal(decision, "silent", `${command} → ${decision}: ${reason}`);
    }
  });

  it("knows `git clean -f` without -d leaves an untracked directory alone", async () => {
    gitIn(tree, "add", "list.txt"); // the only untracked FILE; what is left untracked is wip/, a directory
    assert.equal((await hook("git clean -f")).decision, "silent");
    assert.match((await hook("git clean -fd")).reason, /wip\/notes\.md/);
  });

  it("judges a delete over a thousand ignored directories in well under its budget", async () => {
    for (let i = 0; i < 1500; i += 1) mkdirSync(join(tree, "node_modules", `pkg${i}`), { recursive: true });
    const started = Date.now();
    const { decision } = await hook("rm -rf node_modules/*");
    assert.equal(decision, "silent");
    assert.ok(Date.now() - started < 3000, `${Date.now() - started} ms`);
  });
});

// Shapes that need more than the tree: a symlink, a second directory, a HOME, a PATH. Each
// row is [command, where it runs (relative to the tree), what the reason names and must not
// name, the environment]. `<tree>` and `<parent>` in a command or a value are the fixture's paths.
//
//   <parent>/outside/into -> tree/wip/deep      so `into/..` is tree/wip
//   tree/wiplink          -> tree/wip
//   tree/build/link       -> tree/wip           an ignored link into the work
//   <parent>/linked                             a linked worktree holding scratch.txt
//   <parent>/home                               an empty HOME
const NOTES = { names: /back: wip\/notes\.md \(1 path/ }; // that file, once, by its name in its repository
const SWEPT = { names: /wip\/deep\/plate\.png, wip\/notes\.md/, not: /src\/mod\.py/ };
const LOUD_ELSEWHERE = [
  // `..` after a symlink is the parent of where the link points: the kernel resolves an operand.
  ["rm -rf outside/into/../notes.md", "..", NOTES],
  ["cd outside/into && rm -rf ../notes.md", "..", NOTES],
  ["cd wiplink/deep && cd .. && rm -rf deep", ".", DEEP],
  ["cd -P outside/into && cd .. && rm -rf notes.md", "..", NOTES], // -P: the shell goes where the link points
  ["cd -LP outside/into && cd .. && rm -rf notes.md", "..", NOTES], // the last of -L and -P wins
  // `set -P` makes every cd of that shell physical, for the shells that inherit it (driven, bash 5.2).
  ["set -P; cd outside/into && cd .. && rm -rf notes.md", "..", NOTES],
  ["set -o physical; cd outside/into && cd .. && rm -rf notes.md", "..", NOTES],
  ["set -eP; cd outside/into && cd .. && rm -rf notes.md", "..", NOTES],
  ["set -P; cd -L outside/into && cd .. && rm -rf notes.md", "..", NOTES],
  ["set -P; (cd outside/into && cd .. && rm -rf notes.md)", "..", NOTES],
  ["eval 'set -P'; cd outside/into && cd .. && rm -rf notes.md", "..", NOTES],
  ["f() { set -P; }; f; cd outside/into && cd .. && rm -rf notes.md", "..", NOTES],
  ["if true; then set -P; fi; cd outside/into && cd .. && rm -rf notes.md", "..", NOTES], // it may be on: both places
  ["set -P; f() { cd outside/into && cd .. && rm -rf notes.md; }; f", "..", NOTES], // a function runs in this shell
  ["set -P; eval 'cd outside/into && cd .. && rm -rf notes.md'", "..", NOTES], // and so does an eval
  ["rm -rf build/link/", ".", SWEPT], // a trailing slash names the directory behind the link
  // A find that walks through a link deletes what is behind it.
  ["find wiplink/ -type f -delete", ".", SWEPT],
  ["find -L wiplink -type f -delete", ".", SWEPT],
  ["find -H wiplink -type f -delete", ".", SWEPT],
  ["find .. -name notes.md -delete", "src", NOTES], // rooted at the tree, from inside it
  ["find .. -name notes.md -delete", ".", NOTES], // rooted above every repository: each victim is judged in its own
  // The repository is named by where the command points, not by where it runs.
  ["env GIT_DIR=tree/.git GIT_WORK_TREE=tree git clean -fd", "..", { names: /wip\/notes\.md/, not: /src\/mod\.py/ }],
  ["G=git; env GIT_DIR=tree/.git GIT_WORK_TREE=tree $G clean -fd", "..", { names: /wip\/notes\.md/, not: /src\/mod\.py/ }],
  ["git worktree remove --force linked", ".", { names: /scratch\.txt/, not: /wip\/|src\/mod\.py/ }],
  ["rm -rf <parent>", "src", { names: /back: 1 commit on no remote, and src\/mod\.py/ }],
  ["cd; rm -rf wip", "..", WIP, { HOME: "<tree>" }], // a bare cd goes HOME
];

const QUIET_ELSEWHERE = [
  ["cd; rm -rf wip", ".", { HOME: "<parent>/home" }], // HOME holds no wip: the rm runs there, not here
  ["cd outside/into && cd .. && rm -rf notes.md", ".."], // the shell's own `cd ..` is by name: it lands in outside
  ["cd -P -L outside/into && cd .. && rm -rf notes.md", ".."],
  ["set -P; set +P; cd outside/into && cd .. && rm -rf notes.md", ".."],
  ["set -P; set +o physical; cd outside/into && cd .. && rm -rf notes.md", ".."],
  ["(set -P); cd outside/into && cd .. && rm -rf notes.md", ".."], // a subshell's setting ends with it
  ["set -P; bash -c 'cd outside/into && cd .. && rm -rf notes.md'", ".."], // a new shell starts without it
  ["set -P; echo x | xargs sh -c 'cd outside/into && cd .. && rm -rf notes.md'", ".."],
  ["set -P; find outside -maxdepth 0 -exec sh -c 'cd outside/into && cd .. && rm -rf notes.md' \\;", ".."],
  ["set -e; cd outside/into && cd .. && rm -rf notes.md", ".."],
  ["find wiplink -type f -delete", "."], // find does not follow a link it is handed without a slash
  ["rm -rf outside/into", ".."], // removes the link, not what it points to
];

describe("the hook: shapes that need a link, another directory, a HOME or a PATH", () => {
  let parent;
  const placed = (text) => text.replaceAll("<tree>", tree).replaceAll("<parent>", parent);
  const envOf = (env = {}) => Object.fromEntries(Object.entries(env).map(([k, v]) => [k, placed(v)]));

  beforeEach(() => {
    parent = join(tree, "..");
    mkdirSync(join(parent, "outside"));
    mkdirSync(join(parent, "home"));
    symlinkSync(join(tree, "wip", "deep"), join(parent, "outside", "into"));
    symlinkSync(join(tree, "wip"), join(tree, "wiplink"));
    symlinkSync(join(tree, "wip"), join(tree, "build", "link"));
    gitIn(tree, "worktree", "add", "-q", join(parent, "linked"), "-b", "side");
    writeFileSync(join(parent, "linked", "scratch.txt"), "mine\n");
  });

  for (const [command, at, { names, not }, env] of LOUD_ELSEWHERE) {
    it(`asks: ${JSON.stringify(command)} in ${at}`, async () => {
      const where = { cwd: join(tree, at), env: envOf(env) };
      const main = await hook(placed(command), where);
      assert.equal(main.decision, "ask", `${command} → ${main.decision}`);
      assert.match(main.reason, FROM_A_JUDGE, main.reason);
      assert.match(main.reason, names, main.reason);
      if (not) assert.doesNotMatch(main.reason, not, main.reason);
      assert.equal((await hook(placed(command), { ...where, agent: true })).decision, "deny", command);
    });
  }

  for (const [command, at, env] of QUIET_ELSEWHERE) {
    it(`stays silent: ${JSON.stringify(command)} in ${at}`, async () => {
      const { decision, reason } = await hook(placed(command), { cwd: join(tree, at), env: envOf(env) });
      assert.equal(decision, "silent", `${command} → ${decision}: ${reason}`);
    });
  }

  it("names the file a find matched, not the files its name would match as a pattern", async () => {
    writeFileSync(join(tree, "wip", "[n]otes.md"), "named like a pattern\n");
    const { decision, reason } = await hook("find wip -name '[[]n]otes.md' -delete");
    assert.equal(decision, "ask");
    assert.match(reason, /wip\/\[n\]otes\.md \(1 path/, reason);
  });

  it("names the file xargs was handed: xargs runs no shell, so nothing expands an item", async () => {
    writeFileSync(join(tree, "wip", "[n]otes.md"), "named like a pattern\n");
    const { decision, reason } = await hook("echo 'wip/[n]otes.md' | xargs rm -f");
    assert.equal(decision, "ask");
    assert.match(reason, /wip\/\[n\]otes\.md \(1 path/, reason);
  });

  it("judges both places after a `set -P` that may not have run", async () => {
    // cleandir/lnk -> wip/deep. By name, `cd ..` lands in cleandir; on disk, in wip.
    symlinkSync(join(tree, "wip", "deep"), join(tree, "cleandir", "lnk"));
    writeFileSync(join(tree, "cleandir", "draft.md"), "in flight\n");
    const maybe = await hook("if false; then set -P; fi; cd cleandir/lnk && cd .. && rm -rf draft.md notes.md");
    assert.match(maybe.reason, /back: cleandir\/draft\.md, wip\/notes\.md \(2 paths/, maybe.reason);
    const on = await hook("set -P; cd cleandir/lnk && cd .. && rm -rf draft.md notes.md");
    assert.match(on.reason, /back: wip\/notes\.md \(1 path/, on.reason);
    const off = await hook("cd cleandir/lnk && cd .. && rm -rf draft.md notes.md");
    assert.match(off.reason, /back: cleandir\/draft\.md \(1 path/, off.reason);
  });

  it("never takes xargs' replacement token for a file of that name", async () => {
    writeFileSync(join(tree, "{}"), "a file named like the token\n");
    const { decision, reason } = await hook("echo build | xargs -I{} rm -rf {}");
    assert.equal(decision, "silent", reason);
  });

  it("asks when git is not on the PATH inside a repository, and denies a subagent", async () => {
    const bare = join(parent, "node-only");
    mkdirSync(bare);
    symlinkSync(process.execPath, join(bare, "node"));
    const main = await hook("rm -rf wip", { env: { PATH: bare } });
    assert.equal(main.decision, "ask");
    assert.match(main.reason, /could not ask git .*git is not installed/, main.reason);
    assert.equal((await hook("rm -rf wip", { agent: true, env: { PATH: bare } })).decision, "deny");
  });
});

// The documented floors (docs/hooks/recoverable.md, Limits): what this guard cannot know from the
// text, pinned SILENT. If one of these starts asking, the guard learned something and the Limits
// page is out of date; if a new floor appears, it belongs here and on that page.
const FLOORS = [
  "$(echo rm) -rf wip", // a program name the text does not spell
  "$(which rm) -rf wip",
  "read R <<< rm; $R -rf wip", // nor one a variable takes when the command runs
  "$UNSET_IN_THIS_CALL rm -rf wip", // nor a word that may or may not expand to nothing
  "bash script.sh", // a script file handed to a shell: it is on disk, holds `rm -rf wip`, and is not opened
  "bash < script.sh",
  "cat script.sh | bash",
  "source script.sh",
  "curl -s https://example.invalid/x | bash",
  "printf '%s\\n' 'rm -rf wip' | bash", // printf's format, interpreted at run time
];

describe("the hook: documented floors stay silent", () => {
  beforeEach(() => {
    writeFileSync(join(tree, "script.sh"), "rm -rf wip\n");
  });

  for (const command of FLOORS) {
    it(JSON.stringify(command), async () => {
      const { decision, reason } = await hook(command);
      assert.equal(decision, "silent", `${command} → ${decision}: ${reason}`);
    });
  }

});

// A repository inside the target: a submodule, a clone in an ignored directory, another
// repository below a directory above this one. The outer `git status` says nothing about work
// inside it, so each is found and asked as the repository it is.
describe("the hook: a repository inside the target is read", () => {
  /** A repository at `dir` with one commit and one untracked file, `name`. */
  const cloneAt = (dir, name) => {
    mkdirSync(dir, { recursive: true });
    gitIn(dir, "init", "-q", "-b", "main", ".");
    writeFileSync(join(dir, "a.txt"), "a\n");
    gitIn(dir, "add", "-A");
    gitIn(dir, "commit", "-q", "-m", "base");
    if (name) writeFileSync(join(dir, name), "in flight\n");
  };
  const submodule = (at, name) => {
    const source = join(tree, "..", `src-${at.replaceAll("/", "-")}`);
    cloneAt(source, null);
    gitIn(tree, "-c", "protocol.file.allow=always", "submodule", "add", "-q", source, at);
    gitIn(tree, "commit", "-q", "-m", `submodule ${at}`);
    if (name) writeFileSync(join(tree, at, name), "in flight\n");
  };

  it("a delete above a submodule names the work in the submodule", async () => {
    submodule("vendor/sub", "inflight.md");
    const main = await hook("rm -rf vendor");
    assert.equal(main.decision, "ask");
    assert.match(main.reason, /^RECOVERABLE: `rm` would destroy .*vendor\/sub\/inflight\.md \(1 path/, main.reason);
    assert.equal((await hook("rm -rf vendor", { agent: true })).decision, "deny");
    // Named itself, it is read once, as the repository it is.
    assert.match((await hook("rm -rf vendor/sub")).reason, /work git cannot give back: inflight\.md \(1 path/);
  });

  it("counts no history for a submodule: its commits live in the git directory around it", async () => {
    submodule("vendor/sub", null);
    writeFileSync(join(tree, "vendor", "sub", "b.txt"), "b\n");
    gitIn(join(tree, "vendor", "sub"), "add", "-A");
    gitIn(join(tree, "vendor", "sub"), "commit", "-q", "-m", "a commit on no remote");
    writeFileSync(join(tree, "vendor", "sub", "inflight.md"), "in flight\n");
    const { reason } = await hook("rm -rf vendor");
    assert.match(reason, /vendor\/sub\/inflight\.md/, reason);
    assert.doesNotMatch(reason, /on no remote/, reason);
  });

  it("finds a submodule past the walk's reach, from the index", async () => {
    for (let i = 0; i < 2100; i += 1) mkdirSync(join(tree, "third_party", "pad", `d${i}`), { recursive: true });
    submodule("third_party/deep/a/b/sub", "inflight.md");
    assert.match((await hook("rm -rf third_party")).reason, /third_party\/deep\/a\/b\/sub\/inflight\.md \(1 path/);
  });

  it("stays silent on a stray `.git` that git does not take for a repository", async () => {
    mkdirSync(join(tree, "cleandir", "inner", ".git"), { recursive: true });
    assert.equal((await hook("rm -rf cleandir")).decision, "silent");
  });

  it("stays silent above a submodule that is not checked out", async () => {
    submodule("vendor/sub", null);
    gitIn(tree, "submodule", "deinit", "-q", "-f", "vendor/sub");
    assert.equal((await hook("rm -rf vendor")).decision, "silent");
  });

  it("finds a submodule however deep it sits", async () => {
    submodule("third_party/a/b/c/sub", "inflight.md");
    assert.match((await hook("rm -rf third_party")).reason, /third_party\/a\/b\/c\/sub\/inflight\.md \(1 path/);
  });

  it("stays silent above a submodule with nothing of its own to lose", async () => {
    submodule("vendor/sub", null);
    assert.equal((await hook("rm -rf vendor")).decision, "silent");
  });

  it("a find that sweeps a submodule names what it matches there, and only that", async () => {
    submodule("vendor/sub", "inflight.md");
    const swept = await hook("find vendor -type f -delete");
    assert.match(swept.reason, /^RECOVERABLE: `find` .*vendor\/sub\/inflight\.md \(1 path/, swept.reason);
    assert.equal((await hook("find vendor -name a.txt -delete")).decision, "silent"); // committed: git gives it back
  });

  it("a delete of an ignored directory names the work in a clone inside it", async () => {
    cloneAt(join(tree, "build", "deps", "clone"), "patched.md");
    const main = await hook("rm -rf build");
    assert.equal(main.decision, "ask");
    assert.match(main.reason, /1 commit on no remote in build\/deps\/clone, and build\/deps\/clone\/patched\.md \(1 path/, main.reason);
  });

  it("a delete above the repository it runs in names the work in the others below it", async () => {
    const parent = join(tree, "..");
    cloneAt(join(parent, "other"), "theirs.md");
    gitIn(tree, "stash", "push", "-u", "-q"); // nothing dirty here, so the reason has room for the other's
    const swept = await hook(`rm -rf ${parent}`);
    assert.match(swept.reason, /^RECOVERABLE: `rm` would destroy /, swept.reason);
    assert.match(swept.reason, /1 commit on no remote, the stash, 1 commit on no remote in other/, swept.reason);
    assert.match(swept.reason, /other\/theirs\.md \(1 path/, swept.reason);
  });

  // The documented limit: the walk lists 2,000 directories below a target, nearest first.
  it("does not find a clone past the walk's reach", async () => {
    for (let i = 0; i < 2100; i += 1) mkdirSync(join(tree, "build", "pad", `d${i}`), { recursive: true });
    cloneAt(join(tree, "build", "deep", "a", "b", "clone"), "patched.md");
    assert.equal((await hook("rm -rf build")).decision, "silent");
    assert.match((await hook("rm -rf build/deep")).reason, /build\/deep\/a\/b\/clone\/patched\.md/); // within reach from here
  });

  it("reads a directory only up to its budget, and finds a `.git` without reading for it", () => {
    const wide = join(tree, "build", "wide");
    for (let i = 0; i < 30; i += 1) mkdirSync(join(wide, `d${i}`), { recursive: true });
    for (let i = 0; i < 5; i += 1) writeFileSync(join(wide, `f${i}`), "");
    symlinkSync(join(tree, "wip"), join(wide, "link")); // a link to a directory is not a directory to walk
    writeFileSync(join(wide, ".git"), "gitdir: elsewhere\n");
    const whole = listDirectories(wide, 1000);
    assert.equal(whole.read, 37);
    assert.equal(whole.dirs.length, 30);
    assert.equal(whole.git, true);
    const cut = listDirectories(wide, 10);
    assert.equal(cut.read, 10);
    assert.ok(cut.dirs.length <= 10);
    assert.equal(cut.git, true);
    // Read nothing, and the `.git` is still found: by name, whatever order the filesystem lists in.
    assert.deepEqual(listDirectories(wide, 0), { dirs: [], read: 0, git: true });
    assert.deepEqual(listDirectories(join(tree, "no-such-dir"), 10), { dirs: [], read: 0, git: false });
  });

  // The documented limit: the walk reads 20,000 entries in all, however they are spread.
  it("does not find a clone past the walk's entry budget", async () => {
    for (let i = 0; i < 20_100; i += 1) mkdirSync(join(tree, "build", "pad", `d${i}`), { recursive: true });
    cloneAt(join(tree, "build", "zdeep", "clone"), "patched.md");
    assert.equal((await hook("rm -rf build")).decision, "silent");
    assert.match((await hook("rm -rf build/zdeep")).reason, /build\/zdeep\/clone\/patched\.md/);
  });

  it("reads a repository in an untracked directory once, and never counts its directory as a loss", async () => {
    const clone = join(tree, "pkgs", "p1");
    cloneAt(clone, null);
    gitIn(clone, "remote", "add", "origin", clone);
    gitIn(clone, "fetch", "-q", "origin"); // every commit is on a remote: nothing here is lost
    assert.equal((await hook("rm -rf pkgs")).decision, "silent");
    assert.equal((await hook("rm -rf pkgs", { agent: true })).decision, "silent");
    writeFileSync(join(clone, "ndirty.txt"), "in flight\n");
    const { reason } = await hook("rm -rf pkgs");
    assert.match(reason, /back: pkgs\/p1\/ndirty\.txt \(1 path/, reason);
  });

  it("reads a repository git names in an untracked directory, past the walk's reach", async () => {
    for (let i = 0; i < 20_100; i += 1) mkdirSync(join(tree, "pkgs", "pad", `d${i}`), { recursive: true });
    cloneAt(join(tree, "pkgs", "zdeep", "clone"), "patched.md");
    assert.match((await hook("rm -rf pkgs")).reason, /pkgs\/zdeep\/clone\/patched\.md/);
  });

  it("reads past a submodule whose directory is gone, and names the real loss", async () => {
    submodule("vendor/sub", null);
    rmSync(join(tree, "vendor", "sub"), { recursive: true, force: true });
    const { reason } = await hook("rm -rf wip vendor");
    assert.match(reason, /^RECOVERABLE: `rm` would destroy .*wip\/notes\.md/, reason);
  });

  it("asks without naming when there are more repositories below the target than it reads", async () => {
    for (let i = 0; i < 33; i += 1) cloneAt(join(tree, "build", `clone${i}`), null);
    const main = await hook("rm -rf build");
    assert.equal(main.decision, "ask");
    assert.match(main.reason, /could not ask git .*more than 32 repositories below/, main.reason);
  });
});

// A tree with more dirty files than a function call can take as arguments. Slow to build, so once.
describe("the hook: a very large dirty tree", () => {
  it("names the loss instead of failing on the size of the list", async () => {
    const big = join(tree, "wip", "big");
    mkdirSync(big);
    for (let i = 0; i < 150_000; i += 1) writeFileSync(join(big, `f${i}`), "");
    const { decision, reason } = await hook("rm -rf wip");
    assert.equal(decision, "ask");
    assert.match(reason, /^RECOVERABLE: `rm` would destroy .*\(150002 paths/, reason);
  });
});
