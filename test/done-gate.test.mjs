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
    // Round 2 (Fable): with pipefail the pipeline's status IS pytest's, so a failure is reported
    // by its exit code. Before, the pipe rule was dead code and this read as a hidden status.
    const failing = [edit("/w/a.py"), bash("set -o pipefail; pytest | tail -1", { output: "Exit code 1\n1 failed", error: true })];
    const feedback = (await verdict(stop(failing, "Done.")))?.feedback ?? "";
    assert.match(feedback, /failed: `set -o pipefail; pytest \| tail -1` \(exit code 1\)/);
    assert.doesNotMatch(feedback, /hid the exit status/);
    const passing = [edit("/w/a.py"), bash("set -o pipefail; pytest | tail -1", { output: "3 passed" })];
    assert.equal(await verdict(stop(passing, "Done.")), null);
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

  it("with no final message in the payload", async () => {
    const out = await verdict({ transcript_path: transcript([edit("/w/a.py")]), stop_hook_active: false });
    assert.match(out?.notice ?? "", /carried no final message/);
  });

  it("but lets an empty final message through: it claims nothing", async () => {
    assert.equal(await verdict(stop([edit("/w/a.py")], "")), null);
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
    // Failing, with an exit status: pipefail read from the message would report "exit code 1";
    // the piped run's own status is hidden, so the tally is what speaks.
    const steps = [edit("/w/m.py"), bash('git commit -qm "add pipefail note" && pytest | tail -1', { output: "Exit code 1\n1 failed, 3 passed in 0.1s", error: true })];
    assert.match((await verdict(stop(steps, "Done.")))?.feedback ?? "", /“1 failed, 3 passed in 0\.1s”, and the command hid the exit status/);
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

  it("does not blame the tests for a failure in a command after them", async () => {
    const run = bash("pytest -q; git push", { error: true, output: "Exit code 1\n9 passed in 0.12s\nfatal: no upstream" });
    const out = await verdict(stop([edit("/w/a.py"), run], "Done, all tests pass."));
    assert.doesNotMatch(out.feedback, /the last test run after your edits failed/);
    assert.match(out.feedback, /`pytest -q; git push` ended with exit code 1 from a command after the tests/);
    assert.match(out.feedback, /Quote the test run's own result line/);
  });

  it("still reads a failure tally behind a hidden exit status", async () => {
    const run = bash("pytest -q; git push", { error: true, output: "Exit code 1\n2 failed, 7 passed in 0.12s" });
    const out = await verdict(stop([edit("/w/a.py"), run], "Done."));
    assert.match(out.feedback, /failed: `pytest -q; git push` \(its output says “2 failed, 7 passed in 0\.12s”/);
  });

  for (const file of [".gitignore", "LICENSE", ".gitattributes", ".editorconfig", "CODEOWNERS", "COPYING"]) {
    it(`lets the stop through after an edit to ${file}, which no test could check`, async () => {
      assert.equal(await verdict(stop([edit(`/w/${file}`)], "Done.")), null);
    });
  }

  for (const file of ["Dockerfile", ".env.example", "package.json", "Makefile"]) {
    it(`still counts an edit to ${file}, which changes what builds and runs`, async () => {
      assert.match((await verdict(stop([edit(`/w/${file}`)], "Done.")))?.feedback ?? "", /was edited and no test has run since/);
    });
  }

  const runners = ["pnpm vitest run", "yarn jest --ci", "bun vitest", "bazel test //...", "sbt clean test", "stack test", "cabal test", "meson test -C build"];
  for (const command of runners) {
    it(`recognises ${command}`, () => {
      assert.equal(isTestCommand(command.split(" ")), true);
    });
  }
  it("recognises sbt's quoted task, and not a build", () => {
    assert.equal(isTestCommand(["sbt", "testOnly com.x.Y"]), true);
    for (const command of ["npm vitest", "bazel build //...", "sbt compile", "pnpm install"]) {
      assert.equal(isTestCommand(command.split(" ")), false, command);
    }
  });

  it("names the variable for a test command it does not know", async () => {
    const out = await verdict(stop([edit("/w/a.py")], "Done."));
    assert.match(out.feedback, /can be named in JORD0_DONE_GATE_COMMANDS/);
  });

  for (const honest of [
    "Implemented the parser. The tests were not run.",
    "Implemented the parser. I was unable to run the tests.",
    "Implemented the parser. The tests have not been run.",
    "Implemented the parser. I wasn't able to run the tests.",
  ]) {
    it(`takes an honest admission: ${honest.split(". ")[1]}`, async () => {
      assert.equal(await verdict(stop([edit("/w/a.py")], honest)), null);
    });
  }

  for (const final of ["Fixed. I did not run into any issues.", "Done, and it did not run out of memory.", "Done. I was able to run the tests."]) {
    it(`is not fooled by a phrase that admits nothing: ${final}`, async () => {
      assert.match((await verdict(stop([edit("/w/a.py")], final)))?.feedback ?? "", /no test has run since/);
    });
  }

  it("hears contracted and everyday claims, and still not a negated or a questioning one", () => {
    for (const text of ["Everything's green.", "Everything’s green.", "It’s working now.", "It works now.", "All set.", "Good to go."]) {
      assert.notEqual(completionClaim(text), "", text);
    }
    for (const text of ["Check whether it works.", "Nothing is set up yet, so not good to go."]) {
      assert.equal(completionClaim(text), "", text);
    }
  });

  for (const [command, what] of [
    ["cat > app.py <<'EOF'\nx = 1\nEOF", "app.py was edited"],
    ["echo 'x' | tee src/a.ts", "a.ts was edited"],
    ["git apply fix.patch", "a patch was applied with `git apply`"],
    ["patch -p1 < fix.patch", "a patch was applied with `patch`"],
  ]) {
    it(`counts a source file written from the shell: ${command.split("\n")[0]}`, async () => {
      const out = await verdict(stop([bash(command)], "Done."));
      assert.match(out?.feedback ?? "", new RegExp(`${what.replace(/[.*+?^${}()|[\]\\`]/g, "\\$&")} and no test has run since`));
    });
  }

  // Each write comes AFTER a passing run, so reading it as an edit leaves an edit with no test
  // after it, and the stop is refused. (With the write in the same call as the run, as this test
  // once was, the run cleared it whatever it was called: round 2, Opus 5.)
  for (const command of ["cat out | tee test-output", "cat out > report.json", "echo hi > notes.md", "git apply --check fix.patch", "git am --abort"]) {
    it(`does not count an output or a dry run as an edit: ${command}`, async () => {
      const steps = [edit("/w/a.py"), bash("pytest -q", { output: "3 passed" }), bash(command)];
      assert.equal(await verdict(stop(steps, "Done.")), null);
    });
  }

  it("sees a test run behind bash's `time` reserved word", async () => {
    const steps = [edit("/w/a.py"), bash("time { pytest -q; }", { output: "3 passed" })];
    assert.equal(await verdict(stop(steps, "Done, all tests pass.")), null);
  });
});

describe("DONE-GATE, round 2 of review", () => {
  const refused = async (steps, final = "Done.") => (await verdict(stop(steps, final)))?.feedback ?? "";

  it("reads sed's script as a script, not a file", async () => {
    assert.equal(await refused([bash("sed -i 's/1.0/2.0/' README.md")]), "");
    assert.match(await refused([bash("sed -i 's/a/b/' app.py b.md")]), /app\.py was edited/);
    assert.equal(await refused([bash("perl -Mstrict -ne 'print' app.py")]), "", "-M is a module, not -i");
    assert.match(await refused([bash("perl -pi -e 's/a/b/' app.py")]), /app\.py was edited/);
  });

  it("counts a dependency list or a build script with a .txt name as code", async () => {
    assert.match(await refused([edit("/w/requirements.txt")]), /requirements\.txt was edited/);
    assert.match(await refused([edit("/w/CMakeLists.txt")]), /CMakeLists\.txt was edited/);
  });

  for (const command of ["pytest $(cat list.txt)", "pytest && echo ok"]) {
    it(`gives a test its own exit status when nothing after it can run on a failure: ${command}`, async () => {
      const feedback = await refused([edit("/w/a.py"), bash(command, { output: "Exit code 1\n1 failed", error: true })]);
      assert.match(feedback, /\(exit code 1\)/);
      assert.doesNotMatch(feedback, /hid the exit status/);
    });
  }

  for (const command of ["bash -c 'pytest -q'", "docker exec app bash -c 'npm test'", "env -S 'pytest -q'", "/usr/bin/time -o t.txt pytest", "pixi run test", "deno task test", "pdm run test"]) {
    it(`sees a test run: ${command}`, async () => {
      assert.equal(await refused([edit("/w/a.py"), bash(command, { output: "3 passed" })]), "");
    });
  }

  for (const command of ["pytest --collect-only", "cargo test --no-run", "mvn install -DskipTests", "gradle build -x test", "make -n test", "node app.js --test"]) {
    it(`does not count a run that tests nothing: ${command}`, async () => {
      assert.match(await refused([edit("/w/a.py"), bash(command, { output: "ok" })]), /no test has run since/);
    });
  }

  for (const final of ["The parser still needs to be fixed.", "This will be completed in the next step.", "Is it fixed?", "I committed nothing.", "Here is the loop:\n```\nfor f in x; do echo; done\n```"]) {
    it(`hears no claim in: ${JSON.stringify(final)}`, async () => {
      assert.equal(await refused([edit("/w/a.py")], final), "");
    });
  }

  it("takes a plain admission, and not a sentence about something else", async () => {
    assert.equal(await refused([edit("/w/a.py")], "Done. I haven't tested it."), "");
    assert.match(await refused([edit("/w/a.py")], "Done. I could not run the migration."), /no test has run since/);
  });
});

// Round 3's MINORs (Opus 5 alone, #13; the chair, #12), each driven through the hook first.
describe("DONE-GATE, round 3 MINORs", () => {
  const refused = async (steps, final = "Done.") => (await verdict(stop(steps, final)))?.feedback ?? "";

  // A claim word inside a name is part of the name: `DONE-GATE`, `fixed-width`, `done-gate.mjs`.
  for (const final of [
    "I updated the DONE-GATE hook to read the transcript in order.",
    "The table now uses a fixed-width font.",
    "See lib/done-gate.mjs for the logic.",
    "The completed_tasks table has a new column.",
    "Here is the complete list of wrappers.",
    "It is a complete rewrite of the parser.",
    "Run it with --fixed to keep the old layout.",
  ]) {
    it(`reads no claim in: ${final}`, async () => {
      assert.equal(await refused([edit("/w/lib/done-gate.mjs")], final), "");
    });
  }
  for (const final of ["Done.", "It's fixed.", "The migration is complete.", "The fix is done; the tests pass."]) {
    it(`still reads the claim in: ${final}`, async () => {
      assert.match(await refused([edit("/w/lib/done-gate.mjs")], final), /DONE-GATE: your final message says/);
    });
  }

  // `bash -o pipefail -c`: the status IS the test run's, so a failure is a failure, not "hidden".
  for (const command of ["bash -o pipefail -c 'pytest -q | tail -1'", "bash -euo pipefail -c 'pytest -q | tail -1'"]) {
    it(`reads the shell's own pipefail: ${command}`, async () => {
      const feedback = await refused([edit("/w/a.py"), bash(command, { output: "Exit code 1\n(trimmed)", error: true })]);
      assert.match(feedback, /the last test run after your edits failed/);
      assert.doesNotMatch(feedback, /hides the test run's own status/);
    });
  }
  it("still says a pipe hides the status when no pipefail is on", async () => {
    const feedback = await refused([edit("/w/a.py"), bash("bash -c 'pytest -q | tail -1'", { output: "Exit code 1\n(trimmed)", error: true })]);
    assert.match(feedback, /hides the test run's own status/);
  });

  // An edit is an edit however it lands: a dotenv file, and a copy or move over a source file.
  for (const [command, what] of [
    ["echo X=1 > .env", /\.env was edited/],
    ["echo X=1 >> .env.local", /\.env\.local was edited/],
    ["cp /tmp/new.py src/app.py", /app\.py was edited/],
    ["mv /tmp/new.py src/app.py", /app\.py was edited/],
    ["install -m 644 /tmp/new.py src/app.py", /app\.py was edited/],
    ["cp /tmp/new.py src/", /new\.py was edited/],
    ["cp -t src /tmp/a.py /tmp/b.md", /a\.py was edited/],
  ]) {
    it(`counts an edit: ${command}`, async () => {
      assert.match(await refused([bash(command)]), what);
    });
  }
  it("sees a test run behind a wrapper the table learned in round 3: strace -f pytest", async () => {
    assert.equal(await refused([edit("/w/a.py"), bash("strace -f -o /dev/null pytest -q", { output: "3 passed" })]), "");
  });

  for (const command of ["cp src/app.py /tmp/backup.bak", "mv notes.md old-notes.md", "cp -r src /tmp/snapshot", "install -m 644 new.py"]) {
    it(`counts no source edit: ${command}`, async () => {
      assert.equal(await refused([bash(command)]), "");
    });
  }
});
