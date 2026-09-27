// DONE-GATE: every acceptance criterion, judged on transcripts in Claude Code's own shape.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { admitsUnverified, completionClaim, isTestCommand, judge } from "../lib/done-gate.mjs";
import { runHook } from "./helpers/hook.mjs";
import { bash, edit, transcript } from "./helpers/transcript.mjs";

const stop = (steps, final, extra = {}) => ({
  hook_event_name: "Stop",
  stop_hook_active: false,
  transcript_path: transcript(steps),
  last_assistant_message: final,
  ...extra,
});
const verdict = (payload, env = {}) => judge(payload, { env });

describe("DONE-GATE refuses", () => {
  it("a completion claim after a code edit with no test run since", async () => {
    const out = await verdict(stop([edit("/w/src/app.py")], "Done. The parser is fixed."));
    assert.match(out.feedback, /“Done\.”/);
    assert.match(out.feedback, /app\.py was edited and no test has run since/);
    assert.match(out.feedback, /quote the result line, or say plainly/);
  });

  it("when the only test run came BEFORE the last edit", async () => {
    const steps = [edit("/w/a.ts"), bash("npm test"), edit("/w/b.ts")];
    const out = await verdict(stop(steps, "All tests pass, ready to merge."));
    assert.match(out.feedback, /b\.ts was edited and no test has run since/);
  });

  it("when the last test run after the edit failed", async () => {
    const steps = [edit("/w/lib.rs"), bash("cargo test", { error: true, output: "Exit code 101\n…" })];
    const out = await verdict(stop(steps, "Fixed and pushed."));
    assert.match(out.feedback, /the last test run after your edits failed: `cargo test` \(exit code 101\)/);
  });

  it("when a failing run was piped into tail, which hid its exit status", async () => {
    const steps = [edit("/w/m.py"), bash("pytest -q | tail -3", { output: "3 passed, 2 failed in 0.4s" })];
    const out = await verdict(stop(steps, "Done."));
    assert.match(out.feedback, /its output says “3 passed, 2 failed in 0\.4s”, and the command hid the exit status/);
  });

  it("an in-place sed edit counts as a code edit", async () => {
    const out = await verdict(stop([bash("sed -i 's/a/b/' src/config.toml")], "Done."));
    assert.match(out.feedback, /config\.toml was edited/);
  });

  it("with the real entry script, answering in the additionalContext channel", async () => {
    const result = await runHook("done-gate", stop([edit("/w/x.go")], "Shipped."));
    assert.equal(result.code, 0);
    assert.equal(result.answer.hookSpecificOutput.hookEventName, "Stop");
    assert.match(result.answer.hookSpecificOutput.additionalContext, /x\.go was edited/);
  });
});

describe("DONE-GATE lets the stop through", () => {
  it("when a test run after the last edit succeeded", async () => {
    const steps = [edit("/w/a.py"), bash("uv run pytest -q", { output: "12 passed" })];
    assert.equal(await verdict(stop(steps, "Done, 12 passed.")), null);
  });

  it("when the edit and a passing test run share one Bash call, in that order", async () => {
    assert.equal(await verdict(stop([bash("sed -i 's/a/b/' x.py && pytest")], "Fixed.")), null);
  });

  it("when a piped run's output shows no failures", async () => {
    const steps = [edit("/w/a.py"), bash("pytest | tail -1", { output: "8 passed in 0.2s" })];
    assert.equal(await verdict(stop(steps, "Done.")), null);
  });

  it("when pipefail makes the piped run's exit status real", async () => {
    const steps = [edit("/w/a.py"), bash("set -o pipefail; pytest | tail -1", { output: "0 failed" })];
    assert.equal(await verdict(stop(steps, "Done.")), null);
  });

  it("when the claim is negated", async () => {
    for (const final of ["Nothing is committed yet.", "I have not pushed.", "This isn't finished."]) {
      assert.equal(await verdict(stop([edit("/w/a.py")], final)), null, final);
    }
  });

  it("when the claim word is only quoted", async () => {
    assert.equal(await verdict(stop([edit("/w/a.py")], 'The button now reads `done`, not "finished".')), null);
  });

  it("when the final message already says the work is not verified", async () => {
    const final = "Done with the refactor, but it is not verified: I haven't run the tests.";
    assert.equal(await verdict(stop([edit("/w/a.py")], final)), null);
  });

  it("when only prose was edited", async () => {
    const steps = [edit("/w/README.md"), bash("sed -i 's/x/y/' docs/guide.md")];
    assert.equal(await verdict(stop(steps, "Done, the docs are updated.")), null);
  });

  it("when nothing claims completion", async () => {
    assert.equal(await verdict(stop([edit("/w/a.py")], "Here is what I found so far.")), null);
  });

  it("when switched off with JORD0_DONE_GATE=0", async () => {
    assert.equal(await verdict(stop([edit("/w/a.py")], "Done."), { JORD0_DONE_GATE: "0" }), null);
  });

  it("when Claude is already continuing because of a refusal (the real entry script)", async () => {
    const result = await runHook("done-gate", stop([edit("/w/a.py")], "Done.", { stop_hook_active: true }));
    assert.equal(result.code, 0);
    assert.equal(result.stdout, "");
  });
});

describe("DONE-GATE says so when it cannot check", () => {
  it("with no transcript in the payload", async () => {
    const out = await verdict({ last_assistant_message: "Done.", stop_hook_active: false });
    assert.match(out.notice, /named no transcript/);
  });

  it("with a transcript that cannot be read", async () => {
    const out = await verdict({ last_assistant_message: "Done.", transcript_path: "/no/such/file.jsonl" });
    assert.match(out.notice, /could not be read/);
  });
});

describe("reading the claim", () => {
  it("finds the sentence that claims completion", () => {
    assert.equal(completionClaim("I looked around.\nAll tests pass now. Bye"), "All tests pass now.");
    assert.equal(completionClaim("The fix has landed on main."), "The fix has landed on main.");
    assert.equal(completionClaim("Here is a plan."), "");
  });

  it("recognises an admission that the work is unverified", () => {
    assert.ok(admitsUnverified("I didn't run the tests."));
    assert.ok(admitsUnverified("This is untested."));
    assert.ok(!admitsUnverified("Tests pass."));
  });
});

describe("recognising a test run", () => {
  const cases = {
    "pytest -q": true,
    "python3 -m pytest tests/": true,
    "uv run --frozen pytest": true,
    "timeout -k 5 60 go test ./...": true,
    "env CI=1 npm test": true,
    "npm run test:unit": true,
    "pnpm test:e2e": true,
    "yarn check": true,
    "npx --yes vitest run": true,
    "node --test test/": true,
    "cargo nextest run": true,
    "make check": true,
    "./gradlew test": true,
    "zig build test": true,
    "npm run build": false,
    "zig build": false,
    "make": false,
    "echo pytest": false,
    "cat pytest.ini": false,
    "git commit -m 'npm test passes'": false,
  };
  for (const [command, expected] of Object.entries(cases)) {
    it(`${expected ? "counts" : "ignores"} \`${command}\``, async () => {
      const { listCommands } = await import("../lib/shell.mjs");
      const [first] = (await listCommands(command)).events;
      assert.equal(isTestCommand(first.argv), expected);
    });
  }

  it("accepts a project's own commands from JORD0_DONE_GATE_COMMANDS", async () => {
    const steps = [edit("/w/a.py"), bash("./scripts/verify.sh --all")];
    const env = { JORD0_DONE_GATE_COMMANDS: "make ci, ./scripts/verify.sh" };
    assert.equal(await verdict(stop(steps, "Done."), env), null);
  });
});

describe("round 1 of review: DONE-GATE", () => {
  const edited = [edit("/w/src/app.py")];

  for (const final of ["Now all tests pass.", "Note: all tests pass.", "No failing tests remain; all tests pass.", "The tests are passing."]) {
    it(`reads ${JSON.stringify(final)} as a claim`, async () => {
      assert.match((await verdict(stop(edited, final)))?.feedback ?? "", /no test has run since/);
    });
  }

  it("does not read a traffic light that is green as a claim", async () => {
    assert.equal(await verdict(stop(edited, "The traffic light is green.")), null);
  });

  it("does not let a qualified admission excuse the whole piece of work", async () => {
    const final = "Fixed and all tests pass. I have not tested on Windows.";
    assert.match((await verdict(stop(edited, final)))?.feedback ?? "", /no test has run since/);
  });

  it("never lets an admission excuse a run that failed", async () => {
    const steps = [edit("/w/lib.rs"), bash("cargo test", { error: true, output: "Exit code 101\n" })];
    const out = await verdict(stop(steps, "Done. I haven't run the full suite."));
    assert.match(out?.feedback ?? "", /failed: `cargo test` \(exit code 101\)/);
  });

  for (const command of ["pytest; echo finished", "pytest || true"]) {
    it(`reads the output when \`${command}\` hides the exit status`, async () => {
      const steps = [edit("/w/m.py"), bash(command, { output: "==== 2 failed, 8 passed in 0.3s ====\nfinished" })];
      assert.match((await verdict(stop(steps, "Done.")))?.feedback ?? "", /2 failed, 8 passed/);
    });
  }

  it("does not take pipefail from a commit message", async () => {
    const steps = [edit("/w/m.py"), bash('git commit -qm "add pipefail note" && pytest | tail -1', { output: "1 failed, 3 passed in 0.1s" })];
    assert.match((await verdict(stop(steps, "Done.")))?.feedback ?? "", /1 failed, 3 passed/);
  });

  it("does not read a number in a log line as a failure tally", async () => {
    const steps = [edit("/w/m.py"), bash("pytest | tail -2", { output: "Reproducing issue 5 failed to trigger\n12 passed in 0.2s" })];
    assert.equal(await verdict(stop(steps, "Done.")), null);
  });

  const counted = [
    "env -u HOME pytest",
    "cargo +nightly test",
    "mvn clean test",
    "make -j 4 test",
    "pnpm --filter web test",
    "python manage.py test",
    "docker compose run app pytest",
  ];
  for (const command of counted) {
    it(`counts \`${command}\` as a test run`, async () => {
      const { listCommands } = await import("../lib/shell.mjs");
      const [first] = (await listCommands(command)).events;
      assert.equal(isTestCommand(first.argv), true);
    });
  }

  it("does not count `npm run test-data-generator` as a test run", () => {
    assert.equal(isTestCommand(["npm", "run", "test-data-generator"]), false);
  });
});

describe("round 1b: DONE-GATE", () => {
  it("says so when a command since the edit could not be parsed", async () => {
    // Valid bash that runs pytest; the grammar cannot parse a heredoc opened before `;`.
    const steps = [edit("/w/a.py"), bash("cat <<EOF; pytest -q\nbody\nEOF", { output: "3 passed" })];
    const out = await verdict(stop(steps, "Done."));
    assert.match(out.feedback, /no test this hook can recognise has run since \(it could not parse `cat <<EOF; pytest -q`\)/);
  });

  it("sees a test run behind bash's `time` reserved word", async () => {
    const steps = [edit("/w/a.py"), bash("time { pytest -q; }", { output: "3 passed" })];
    assert.equal(await verdict(stop(steps, "Done, all tests pass.")), null);
  });
});
