// The repository itself, checked like code: nothing private leaks, every count agrees with the
// wiring, every source file says what it is, and every commit carries the right author.

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, it } from "node:test";

import { ROOT } from "./helpers/hook.mjs";

const tracked = execFileSync("git", ["ls-files"], { cwd: ROOT })
  .toString("utf8")
  .split("\n")
  .filter(Boolean);
const text = (file) => readFileSync(join(ROOT, file), "utf8");
const TEXT_FILES = tracked.filter(
  (f) =>
    /\.(?:mjs|js|json|md|yml|yaml|css|html|txt)$|^LICENSE$|Dockerfile$|^\.gitignore$/.test(f) &&
    f !== "package-lock.json",
);

// Words from the machines and the people this was built beside. None belongs in a public repo, and
// neither does a list of them: a readable list is the leak it exists to stop. So each word is kept
// as a SHA-256 digest. Every word in a tracked file, and every two neighbouring words run together
// (so a dotted address or an underscored name is caught whole), is lowercased with its digits
// folded to "#" and hashed; a digest in this set is a leak. A digest cannot be read or searched
// for, but anyone who already knows a word can confirm it. This keeps the words out of casual
// reading and search results. It is not secrecy.
const PRIVATE_WORDS = new Set([
  "0930f017a7b49e0fe2177d2150c03e437f520fa42bf91f459f4cb87a299671f0",
  "2fec25192a9ff014fc3ed2fd3b824ddbebe76a94a51a9e35e38a957731a83a3e",
  "540d65804fe3af93b15e57b8f56a788e4d6d5be29cb7fd1e22539530a80d0b80",
  "92a4d079f816921e64ac1af23d272eae3190f94a57603b08cac18605f8136193",
  "a1abef611f2399049e141a55a46cc844641ba3c76c1dae917cb7bc1d0549c688",
  "a885bd3d15a135670ccdfc0bb9921eb29c53e73a366008f9f047bd5c871b56cf",
  "b25461a1cb2cc16680a7916a6bd131b5743114b5056603616742dc60bc7bc9d0",
  "dae9acb1cd1776b0df960c0e8175fa65671dcb7699c727fbb6d57140f83c94f1",
  "decde78e848fec751925e32fd825b9979b9281b4548c157d21449c4b2f37135e",
  "ecc9bddb65dc44516ca3eae954eb6d06cbfe4c250cae103f68d5cf346a7cf703",
]);

// Shapes that are private whoever they name: a home directory, a LAN address, a tailnet host.
const PRIVATE_SHAPES = [/\/home\/(?!tester\b)[a-z]\w*/, /\b192\.168\.\d+\.\d+/, /\.ts\.net\b/i];

const digestOf = new Map();
function isPrivateWord(word) {
  if (!digestOf.has(word))
    digestOf.set(word, PRIVATE_WORDS.has(createHash("sha256").update(word).digest("hex")));
  return digestOf.get(word);
}

/**
 * The private words and shapes in one line of text, as short labels (never the word itself). The
 * line is read twice: as written, and with each backslash-letter pair read as a gap, so a word in
 * a regex (`\bname\b`) is still the word. The first reading keeps `C:\Users\name`, where the gap
 * would eat the name's first letter. (The list this test once published was written as regexes:
 * read only as written it gave 2 hits, read both ways 10.)
 */
function leaksIn(line) {
  const found = PRIVATE_SHAPES.filter((re) => re.test(line)).map(String);
  for (const [how, variant] of [
    ["", line],
    [" in a regex", line.replace(/\\[A-Za-z]/g, " ")],
  ]) {
    const words = variant
      .toLowerCase()
      .replace(/[0-9]/g, "#")
      .split(/[^a-z#]+/)
      .filter(Boolean);
    words.forEach((word, i) => {
      if (isPrivateWord(word)) found.push(`private word ${i + 1}${how}`);
      else if (i > 0 && isPrivateWord(words[i - 1] + word))
        found.push(`private words ${i}-${i + 1}${how}`);
    });
  }
  return [...new Set(found)];
}

describe("nothing private leaks", () => {
  it("no tracked file names a private machine, path, or person", () => {
    const hits = [];
    for (const file of TEXT_FILES) {
      text(file)
        .split("\n")
        .forEach((line, i) => {
          for (const what of leaksIn(line)) hits.push(`${file}:${i + 1}  ${what}`);
        });
    }
    assert.deepEqual(hits, [], `every hit, not just the first:\n${hits.join("\n")}`);
  });

  // A commit message is as public as a file, and no file scan reads it. One was once written with
  // a private word in it, while describing this very test.
  it("no commit message names one either", () => {
    const log = execFileSync("git", ["log", "--format=%h%x00%B%x01"], { cwd: ROOT }).toString(
      "utf8",
    );
    const hits = [];
    for (const entry of log.split("\x01")) {
      const [sha, body = ""] = entry.trim().split("\0");
      body.split("\n").forEach((line, i) => {
        for (const what of leaksIn(line)) hits.push(`${sha} line ${i + 1}  ${what}`);
      });
    }
    assert.deepEqual(hits, [], `every hit, not just the first:\n${hits.join("\n")}`);
  });
});

describe("the suite cleans up after itself", () => {
  it("removes a test's git work tree when its process exits", () => {
    const helper = pathToFileURL(join(ROOT, "test", "helpers", "repo.mjs")).href;
    const script = `import { makeTree } from ${JSON.stringify(helper)}; console.log(makeTree());`;
    const tree = execFileSync(process.execPath, ["--input-type=module", "-e", script])
      .toString("utf8")
      .trim();
    assert.ok(tree.endsWith("tree"), tree);
    assert.equal(existsSync(tree), false, `${tree} outlived the process that made it`);
  });
});

describe("the wiring starts on this Node", () => {
  // `--liftoff-only` is a V8 flag, not a Node API. A Node that dropped it would refuse to
  // start (exit 9, "bad option"), and Claude Code runs the tool when a hook exits like that.
  // The quiet-list tests would pass on that silence, so this asks Node directly.
  it("node accepts every flag hooks.json gives it", () => {
    const hooks = Object.values(JSON.parse(text("hooks/hooks.json")).hooks).flatMap((groups) =>
      groups.flatMap((g) => g.hooks),
    );
    for (const hook of hooks) {
      const flags = hook.args.slice(0, -1);
      const started = spawnSync(hook.command, [...flags, "-e", "0"], { encoding: "utf8" });
      assert.equal(
        started.status,
        0,
        `${hook.command} ${flags.join(" ")}: ${started.stderr.trim()}`,
      );
    }
  });
});

describe("every count agrees with the wiring", () => {
  const wiring = JSON.parse(text("hooks/hooks.json")).hooks;
  const entries = Object.values(wiring).flatMap((groups) => groups.flatMap((g) => g.hooks));
  const count = entries.length;
  const WORDS = [
    "zero",
    "one",
    "two",
    "three",
    "four",
    "five",
    "six",
    "seven",
    "eight",
    "nine",
    "ten",
  ];

  it("hooks.json wires exactly the scripts in bin/", () => {
    const scripts = tracked
      .filter((f) => f.startsWith("bin/"))
      .map((f) => f.slice(4))
      .sort();
    const wired = entries.map((h) => h.args.at(-1).split("/bin/")[1]).sort();
    assert.deepEqual(wired, scripts);
  });

  it(`every "N hooks" in the docs and manifests says ${WORDS[count]}`, () => {
    const wrong = [];
    for (const file of TEXT_FILES.filter((f) => /\.(?:md|json|yml)$/.test(f))) {
      for (const m of text(file).matchAll(/\b(\w+) (?:Claude Code )?hooks\b/gi)) {
        const said = m[1].toLowerCase();
        const n =
          WORDS.indexOf(said) >= 0 ? WORDS.indexOf(said) : /^\d+$/.test(said) ? Number(said) : null;
        if (n !== null && n !== count) wrong.push(`${file}: "${m[0]}"`);
      }
    }
    assert.deepEqual(wrong, []);
  });
});

describe("every source file explains itself", () => {
  const sources = tracked.filter((f) => /\.mjs$/.test(f));

  it("opens with a comment saying what it is", () => {
    const bare = sources.filter((f) => !text(f).startsWith("//"));
    assert.deepEqual(bare, []);
  });

  // Prettier formats code at a width of 100 and leaves comments, and strings it cannot break, as
  // written. So comments are held to that width everywhere, and every line is held to it outside
  // test/, where a long shell command is kept whole because it is the thing under test.
  it("keeps every comment, and every line outside test/, within 100 columns", () => {
    const wide = [];
    for (const file of tracked.filter((f) => /\.(?:mjs|css)$/.test(f))) {
      text(file)
        .split("\n")
        .forEach((line, i) => {
          const comment = /^\s*(?:\/\/|\/?\*)/.test(line);
          if (line.length > 100 && (comment || !file.startsWith("test/"))) {
            wide.push(`${file}:${i + 1} (${line.length})`);
          }
        });
    }
    assert.deepEqual(wide, [], `every line, not just the first:\n${wide.join("\n")}`);
  });

  // This file has to spell out the markers it bans, so the marker scan skips it. The em-dash
  // scan does not need to: the character is written here as an escape.
  const scanned = TEXT_FILES.filter((f) => f !== "test/hygiene.test.mjs");

  it("carries no TODO, FIXME or XXX", () => {
    const marked = scanned.filter((f) => /\b(?:TODO|FIXME|XXX)\b/.test(text(f)));
    assert.deepEqual(marked, []);
  });

  it("contains no em-dash anywhere, in code or prose", () => {
    assert.deepEqual(
      TEXT_FILES.filter((f) => text(f).includes("\u2014")),
      [],
    );
  });

  it("never builds a permissionDecision of allow", () => {
    const allowing = sources.filter(
      (f) => f.startsWith("lib/") && /permissionDecision:\s*["']allow/.test(text(f)),
    );
    assert.deepEqual(allowing, []);
  });
});

describe("history", () => {
  // Contributors are welcome, so this checks WHAT an identity says, not who it is: no author or
  // committer carries a private word (a machine's name, a personal address). It once required
  // one fixed author, which every contributor's pull request and every merge in GitHub's UI
  // would fail.
  it("no author or committer names a private machine or address", () => {
    const people = execFileSync("git", ["log", "--format=%an <%ae>%n%cn <%ce>"], { cwd: ROOT })
      .toString("utf8")
      .split("\n")
      .filter(Boolean);
    const leaking = [...new Set(people)].filter((who) => leaksIn(who).length > 0);
    assert.deepEqual(
      leaking.map((who) => leaksIn(who)),
      [],
    );
  });
});
