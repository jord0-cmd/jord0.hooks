// The lister: what runs, where, and fed by what, for the shapes a splitter gets wrong.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { listCommands, resolveWord } from "../lib/shell.mjs";

const commands = async (text) =>
  (await listCommands(text)).events.filter((e) => e.kind === "command");
const argvs = async (text) => (await commands(text)).map((c) => c.argv.join(" "));

describe("listing commands", () => {
  it("splits a plain sequence in source order", async () => {
    assert.deepEqual(await argvs("cd /tmp && ls -la; echo hi || true"), [
      "cd /tmp",
      "ls -la",
      "echo hi",
      "true",
    ]);
  });

  it("keeps a quoted string whole, whatever operators it contains", async () => {
    assert.deepEqual(await argvs('git commit -m "fix; rm -rf wip && done"'), [
      "git commit -m fix; rm -rf wip && done",
    ]);
  });

  it("finds commands inside groups, conditionals, loops and substitutions", async () => {
    const found = await argvs(
      "( rm -rf a ); { rm -rf b; }; if true; then rm -rf c; fi; " +
        "for f in x; do rm -rf d; done; echo $(rm -rf e)",
    );
    for (const target of ["a", "b", "c", "d", "e"]) {
      assert.ok(found.includes(`rm -rf ${target}`), `missed rm -rf ${target} in ${found}`);
    }
  });

  it("gives a subshell its own scope and leaves a brace group in the caller's", async () => {
    const [sub, group] = await commands("(cd /x); { cd /y; }");
    assert.equal(sub.scope.length, 1);
    assert.equal(group.scope.length, 0);
  });

  it("removes quoting and escapes the way bash does", async () => {
    const [cmd] = await commands(`r\\m -rf 'a b' "c\\"d" $'\\x72m' e\\ f`);
    assert.deepEqual(cmd.argv, ["rm", "-rf", "a b", 'c"d', "rm", "e f"]);
  });

  it("keeps expansions exactly as written for the caller to resolve", async () => {
    const [cmd] = await commands('rm -rf "$HOME/x" ${D}/y $(pwd)/z');
    assert.deepEqual(cmd.argv, ["rm", "-rf", "$HOME/x", "${D}/y", "$(pwd)/z"]);
  });

  it("tells each pipeline stage what feeds it", async () => {
    const [left, right] = await commands("find . -name '*.tmp' | xargs rm -f");
    assert.equal(left.pipeIndex, 0);
    assert.equal(left.feeder, null);
    assert.equal(right.pipeIndex, 1);
    assert.deepEqual(right.feeder, ["find", ".", "-name", "*.tmp"]);
  });

  it("records stdin redirection and the file it reads", async () => {
    const [cmd] = await commands("xargs rm -rf < 'list of files.txt'");
    assert.equal(cmd.stdinRedirected, true);
    assert.equal(cmd.stdinFile, "list of files.txt");
  });

  it("does not mistake an output redirect for stdin", async () => {
    const [cmd] = await commands("echo hi > out.txt 2>&1");
    assert.equal(cmd.stdinRedirected, false);
  });

  it("gives a trailing heredoc to the LAST stage of a pipeline, as bash does", async () => {
    const [first, last] = await commands("cat a | bash <<'EOF'\nrm -rf wip\nEOF");
    assert.equal(first.heredoc, null);
    assert.equal(last.heredoc, "rm -rf wip\n");
    assert.equal(last.stdinRedirected, true);
  });

  it("never lists a heredoc body as commands of its own", async () => {
    assert.deepEqual(await argvs("cat <<'EOF'\nrm -rf wip\nEOF"), ["cat"]);
  });

  it("lists bare assignments in order with the commands", async () => {
    const { events } = await listCommands("S=build; S=wip; rm -rf $S");
    assert.deepEqual(
      events.map((e) => (e.kind === "assignment" ? `${e.name}=${e.value}` : e.argv.join(" "))),
      ["S=build", "S=wip", "rm -rf $S"],
    );
  });

  it("keeps prefix assignments with their command", async () => {
    const [cmd] = await commands("GIT_DIR=x git status");
    assert.deepEqual(cmd.prefix, [["GIT_DIR", "x"]]);
    assert.deepEqual(cmd.argv, ["git", "status"]);
  });

  it("treats (( … )) as arithmetic, which runs no command", async () => {
    assert.deepEqual(await argvs("((rm -rf wip))"), []);
  });

  it("reports an unparseable span instead of pretending the text was clean", async () => {
    assert.equal((await listCommands("echo 'unterminated")).hasError, true);
    assert.equal((await listCommands("echo fine")).hasError, false);
  });
});

describe("resolving words", () => {
  const context = { cwd: "/work", home: "/home/me", env: { TMPDIR: "/tmp", X: "from-env" } };

  it("substitutes what can be known", () => {
    const vars = new Map([["S", "$X/sub"]]);
    assert.deepEqual(resolveWord("$S/${X}/$PWD", { ...context, vars }), {
      text: "from-env/sub/from-env//work",
      unknown: false,
    });
    assert.equal(resolveWord("~/notes", context).text, "/home/me/notes");
    assert.equal(resolveWord("$(pwd)/x", context).text, "/work/x");
    assert.equal(resolveWord("$(mktemp -d)", context).text, "/tmp/mktemp-not-yet-created");
  });

  it("says so when a word still depends on run time", () => {
    assert.equal(resolveWord("$UNSET_ANYWHERE/wip", context).unknown, true);
    assert.equal(resolveWord("$(ls)", context).unknown, true);
    assert.equal(resolveWord("{wip,build}", context).unknown, true);
    assert.equal(resolveWord("`date`", context).unknown, true);
  });
});

describe("the lister on arbitrary input", () => {
  it("never throws, whatever the string", async () => {
    // Deterministic generator: a failure here names its seed and reproduces exactly.
    const alphabet = [..."ab /$'\"`\\;&|<>(){}[]#*?!=~-\n\t0"];
    let seed = 20260926;
    const next = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31);
    for (let i = 0; i < 400; i += 1) {
      const start = seed;
      const text = Array.from({ length: next() % 40 }, () => alphabet[next() % alphabet.length]).join("");
      const listing = await listCommands(text).catch((err) => {
        throw new Error(`seed ${start}: ${JSON.stringify(text)} threw ${err.message}`);
      });
      assert.ok(Array.isArray(listing.events));
      assert.equal(typeof listing.hasError, "boolean");
    }
  });
});
