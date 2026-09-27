// The repository itself, checked like code: nothing private leaks, every count agrees with the
// wiring, every source file says what it is, and every commit carries the right author.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

import { ROOT } from "./helpers/hook.mjs";

const tracked = execFileSync("git", ["ls-files"], { cwd: ROOT }).toString("utf8").split("\n").filter(Boolean);
const text = (file) => readFileSync(join(ROOT, file), "utf8");
const TEXT_FILES = tracked.filter((f) => /\.(?:mjs|js|json|md|yml|yaml|css|html|txt)$|^LICENSE$|Dockerfile$|^\.gitignore$/.test(f) && f !== "package-lock.json");

// Names and paths from the machines this was built on. None of them belongs in a public repo.
// This list named the machines and the people this was built beside. It was taken out of the
// history before the repository was published, because a readable list is the leak it exists to
// stop; the test that replaced it keeps each word as a SHA-256 digest.
const BANNED = [/\/home\/(?!tester\b)[a-z]\w*/, /\b192\.168\.\d+\.\d+/, /\.ts\.net\b/i];

describe("nothing private leaks", () => {
  it("no tracked file names a private machine, path, or person", () => {
    const hits = [];
    for (const file of TEXT_FILES) {
      text(file)
        .split("\n")
        .forEach((line, i) => {
          for (const re of BANNED) if (re.test(line)) hits.push(`${file}:${i + 1}  ${re}  ${line.trim().slice(0, 100)}`);
        });
    }
    assert.deepEqual(hits, [], `every hit, not just the first:\n${hits.join("\n")}`);
  });
});

describe("every count agrees with the wiring", () => {
  const wiring = JSON.parse(text("hooks/hooks.json")).hooks;
  const entries = Object.values(wiring).flatMap((groups) => groups.flatMap((g) => g.hooks));
  const count = entries.length;
  const WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];

  it("hooks.json wires exactly the scripts in bin/", () => {
    const scripts = tracked.filter((f) => f.startsWith("bin/")).map((f) => f.slice(4)).sort();
    const wired = entries.map((h) => h.args.at(-1).split("/bin/")[1]).sort();
    assert.deepEqual(wired, scripts);
  });

  it(`every "N hooks" in the docs and manifests says ${WORDS[count]}`, () => {
    const wrong = [];
    for (const file of TEXT_FILES.filter((f) => /\.(?:md|json|yml)$/.test(f))) {
      for (const m of text(file).matchAll(/\b(\w+) (?:Claude Code )?hooks\b/gi)) {
        const said = m[1].toLowerCase();
        const n = WORDS.indexOf(said) >= 0 ? WORDS.indexOf(said) : /^\d+$/.test(said) ? Number(said) : null;
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

  // This file has to spell out the markers it bans, so the marker scan skips it. The em-dash
  // scan does not need to: the character is written here as an escape.
  const scanned = TEXT_FILES.filter((f) => f !== "test/hygiene.test.mjs");

  it("carries no TODO, FIXME or XXX", () => {
    const marked = scanned.filter((f) => /\b(?:TODO|FIXME|XXX)\b/.test(text(f)));
    assert.deepEqual(marked, []);
  });

  it("contains no em-dash anywhere, in code or prose", () => {
    assert.deepEqual(TEXT_FILES.filter((f) => text(f).includes("\u2014")), []);
  });

  it("never builds a permissionDecision of allow", () => {
    const allowing = sources.filter((f) => f.startsWith("lib/") && /permissionDecision:\s*["']allow/.test(text(f)));
    assert.deepEqual(allowing, []);
  });
});

describe("history", () => {
  it("every commit is authored and committed as Jordo <jordo@jord0.net>", () => {
    const people = execFileSync("git", ["log", "--format=%an <%ae>|%cn <%ce>"], { cwd: ROOT })
      .toString("utf8")
      .split("\n")
      .filter(Boolean);
    const strangers = [...new Set(people.flatMap((p) => p.split("|")))].filter((p) => p !== "Jordo <jordo@jord0.net>");
    assert.deepEqual(strangers, []);
  });
});
