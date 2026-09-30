// The fail policy: every way a hook can fail to do its job must still produce a decision.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { Readable } from "node:stream";
import { describe, it } from "node:test";
import { pathToFileURL } from "node:url";

import { Fault, notice, permission, readPayload, stopFeedback } from "../lib/io.mjs";
import { runGuard, runStop } from "../lib/runner.mjs";
import { ROOT, decisionOf, reasonOf, runHook } from "./helpers/hook.mjs";

const stdinOf = (text) => Readable.from([Buffer.from(text)]);
const MAIN = { tool_name: "Bash", tool_input: { command: "ls" }, cwd: "/tmp" };
const SUBAGENT = { ...MAIN, agent_id: "agent-1", agent_type: "general-purpose" };

const guardThat = (judge) => async () => ({ judge });

describe("reading the payload", () => {
  it("returns the object when stdin carries a JSON object", async () => {
    assert.deepEqual(await readPayload(stdinOf('{"a":1}')), { a: 1 });
  });

  for (const [label, text] of [
    ["empty", ""],
    ["whitespace", "  \n"],
    ["not JSON", "{nope"],
    ["a JSON array", "[1,2]"],
    ["JSON null", "null"],
  ]) {
    it(`returns a Fault, never throws, when stdin is ${label}`, async () => {
      assert.ok((await readPayload(stdinOf(text))) instanceof Fault);
    });
  }

  it("gives up with a Fault when stdin never finishes", async () => {
    const never = new Readable({ read() {} });
    const started = Date.now();
    const result = await readPayload(never, 50);
    assert.ok(result instanceof Fault);
    assert.match(result.message, /within 50 ms/);
    assert.ok(Date.now() - started < 1000);
  });
});

describe("answers", () => {
  it("refuses to build an allow, because allow skips the user's permission prompt", () => {
    assert.throws(() => permission("allow", "fine"), TypeError);
  });

  it("builds ask and deny in the shape Claude Code reads", () => {
    assert.deepEqual(permission("deny", "no"), {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: "no",
      },
    });
  });

  it("clips a runaway reason well inside the harness's 10,000-character cap", () => {
    const long = permission("ask", "x".repeat(50_000));
    assert.ok(long.hookSpecificOutput.permissionDecisionReason.length <= 2000);
    assert.ok(stopFeedback("y".repeat(50_000)).hookSpecificOutput.additionalContext.length <= 2000);
    assert.ok(notice("z".repeat(50_000)).systemMessage.length <= 2000);
  });
});

describe("a PreToolUse guard that cannot do its job", () => {
  it("asks when the payload cannot be read", async () => {
    const answer = await runGuard(
      "TEST",
      guardThat(async () => null),
      { stdin: stdinOf("") },
    );
    assert.equal(decisionOf(answer), "ask");
    assert.match(reasonOf(answer), /TEST could not read its input/);
  });

  it("asks on the main thread and denies in a subagent when the guard throws", async () => {
    const boom = guardThat(async () => {
      throw new Error("kaboom");
    });
    const main = await runGuard("TEST", boom, { stdin: stdinOf(JSON.stringify(MAIN)) });
    const sub = await runGuard("TEST", boom, { stdin: stdinOf(JSON.stringify(SUBAGENT)) });
    assert.equal(decisionOf(main), "ask");
    assert.equal(decisionOf(sub), "deny");
    assert.match(reasonOf(main), /kaboom/);
    assert.match(reasonOf(sub), /kaboom/);
  });

  it("asks, naming the package, when a dependency is not installed", async () => {
    const missing = () => import("jord0-hooks-no-such-package");
    const answer = await runGuard("TEST", missing, { stdin: stdinOf(JSON.stringify(MAIN)) });
    assert.equal(decisionOf(answer), "ask");
    assert.match(reasonOf(answer), /dependency is not installed: jord0-hooks-no-such-package/);
    assert.match(reasonOf(answer), /Reinstall the plugin/);
  });

  it("asks when the guard runs past its budget, and does not wait for it", async () => {
    const slow = guardThat(() => new Promise(() => {}));
    const started = Date.now();
    const answer = await runGuard("TEST", slow, {
      stdin: stdinOf(JSON.stringify(MAIN)),
      budgetMs: 50,
    });
    assert.equal(decisionOf(answer), "ask");
    assert.match(reasonOf(answer), /over its 50 ms budget/);
    assert.ok(Date.now() - started < 1000);
  });

  it("stays silent when the guard has no objection", async () => {
    const quiet = guardThat(async () => null);
    assert.equal(await runGuard("TEST", quiet, { stdin: stdinOf(JSON.stringify(MAIN)) }), null);
  });

  it("passes the guard's own verdict through unchanged", async () => {
    const denies = guardThat(async () => ({ decision: "deny", reason: "because" }));
    const answer = await runGuard("TEST", denies, { stdin: stdinOf(JSON.stringify(MAIN)) });
    assert.deepEqual(answer, permission("deny", "because"));
  });
});

describe("a Stop hook that cannot do its job", () => {
  const STOP = {
    hook_event_name: "Stop",
    stop_hook_active: false,
    last_assistant_message: "Done.",
  };

  it("lets the stop through and tells the user when the payload cannot be read", async () => {
    const answer = await runStop(
      "TEST",
      guardThat(async () => null),
      { stdin: stdinOf("{") },
    );
    assert.match(answer.systemMessage, /TEST could not read its input/);
    assert.equal(answer.hookSpecificOutput, undefined);
  });

  it("lets the stop through and tells the user when the hook throws", async () => {
    const boom = guardThat(async () => {
      throw new Error("kaboom");
    });
    const answer = await runStop("TEST", boom, { stdin: stdinOf(JSON.stringify(STOP)) });
    assert.match(answer.systemMessage, /TEST failed \(kaboom\)/);
  });

  it("never refuses twice in a row", async () => {
    let called = false;
    const refuses = guardThat(async () => {
      called = true;
      return { feedback: "run the tests" };
    });
    const again = { ...STOP, stop_hook_active: true };
    assert.equal(await runStop("TEST", refuses, { stdin: stdinOf(JSON.stringify(again)) }), null);
    assert.equal(called, false);
  });

  it("turns feedback into additionalContext, the channel for a hook working as designed", async () => {
    const refuses = guardThat(async () => ({ feedback: "run the tests" }));
    const answer = await runStop("TEST", refuses, { stdin: stdinOf(JSON.stringify(STOP)) });
    assert.deepEqual(answer, stopFeedback("run the tests"));
  });
});

describe("the real entry scripts, spawned as hooks.json configures them", () => {
  for (const entry of ["recoverable", "flag-probe"]) {
    it(`${entry}: asks on an empty payload, exit 0, one JSON object`, async () => {
      const result = await runHook(entry, "");
      assert.equal(result.code, 0);
      assert.equal(decisionOf(result.answer), "ask");
      assert.equal(result.stdout.trim().split("\n").length, 1);
    });

    it(`${entry}: asks within its stdin timeout when the payload never arrives`, async () => {
      const result = await runHook(entry, null);
      assert.equal(result.code, 0);
      assert.equal(decisionOf(result.answer), "ask");
      assert.ok(result.ms < 5000, `took ${result.ms} ms`);
    });
  }

  it("done-gate: lets the stop through with a notice on a malformed payload", async () => {
    const result = await runHook("done-gate", "not json");
    assert.equal(result.code, 0);
    assert.match(result.answer.systemMessage, /DONE-GATE could not read its input/);
  });
});

describe("a stray error after the answer", () => {
  // Claude Code reads a hook's JSON only on exit 0. Two unhandled rejections once crashed the
  // process with exit 1 after the answer was printed, which throws the answer away.
  const runner = pathToFileURL(join(ROOT, "lib", "runner.mjs")).href;
  const straying = (entry, answer) => `
    import { ${entry} } from ${JSON.stringify(runner)};
    await ${entry}("TEST", async () => ({
      judge: async () => {
        // Rejected only once the answer is on its way out: the case the title names. (Round 2,
        // Fable: these once fired before the return, so the failure path answered instead.)
        setTimeout(() => Promise.reject(new Error("stray one")), 0);
        setTimeout(() => Promise.reject(new Error("stray two")), 5);
        return ${answer};
      },
    }));`;
  const spawn = (script, payload) =>
    spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      input: JSON.stringify(payload),
      encoding: "utf8",
    });

  it("a guard still exits 0 with exactly one answer", () => {
    const ran = spawn(straying("guardMain", '{ decision: "ask", reason: "judged" }'), MAIN);
    assert.equal(ran.status, 0, ran.stderr);
    const lines = ran.stdout.trim().split("\n");
    assert.equal(lines.length, 1, ran.stdout);
    assert.equal(decisionOf(JSON.parse(lines[0])), "ask");
    assert.match(lines[0], /judged/, "the judge's own answer, not the failure path's");
  });

  it("a Stop hook still exits 0 with exactly one answer", () => {
    const stop = {
      hook_event_name: "Stop",
      stop_hook_active: false,
      last_assistant_message: "Done.",
    };
    const ran = spawn(straying("stopMain", '{ feedback: "judged" }'), stop);
    assert.equal(ran.status, 0, ran.stderr);
    assert.equal(ran.stdout.trim().split("\n").length, 1, ran.stdout);
    assert.match(ran.stdout, /judged/, "the judge's own answer, not a notice that it failed");
  });
});
