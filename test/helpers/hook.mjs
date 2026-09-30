// Runs a hook the way Claude Code does: the exact command and arguments from hooks/hooks.json,
// with ${CLAUDE_PLUGIN_ROOT} substituted, the payload on stdin, and the answer read off stdout.
// Tests that go through here exercise the real entry script, not a function inside it.

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

const wiring = JSON.parse(readFileSync(join(ROOT, "hooks", "hooks.json"), "utf8")).hooks;

/**
 * The configured command for the hook whose entry script is `bin/<entry>.mjs`.
 *
 * @param {string} entry e.g. "recoverable"
 * @param {string} [root] plugin root to substitute (a copy, for the missing-dependency test)
 */
export function commandFor(entry, root = ROOT) {
  for (const groups of Object.values(wiring)) {
    for (const group of groups) {
      for (const hook of group.hooks) {
        if (hook.args?.some((arg) => arg.endsWith(`/bin/${entry}.mjs`))) {
          const sub = (text) => text.replaceAll("${CLAUDE_PLUGIN_ROOT}", root);
          return { command: sub(hook.command), args: hook.args.map(sub) };
        }
      }
    }
  }
  throw new Error(`hooks/hooks.json wires no bin/${entry}.mjs`);
}

/**
 * @param {string} entry
 * @param {object | string | null} payload an object is sent as JSON, a string raw, null sends nothing and keeps stdin open
 * @param {{ cwd?: string, env?: Record<string, string>, root?: string }} [options]
 * @returns {Promise<{ code: number | null, stdout: string, stderr: string, answer: any, ms: number }>}
 */
export function runHook(entry, payload, { cwd = ROOT, env = {}, root = ROOT } = {}) {
  const { command, args } = commandFor(entry, root);
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, CLAUDE_PLUGIN_ROOT: root, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      const text = stdout.trim();
      resolve({
        code,
        stdout,
        stderr,
        answer: text ? JSON.parse(text) : null,
        ms: Date.now() - started,
      });
    });
    if (payload === null) return;
    child.stdin.end(typeof payload === "string" ? payload : JSON.stringify(payload));
  });
}

/** The decision a PreToolUse answer carries, or "silent" when the hook said nothing. */
export function decisionOf(answer) {
  return answer?.hookSpecificOutput?.permissionDecision ?? "silent";
}

/** The reason a PreToolUse answer carries, or "". */
export function reasonOf(answer) {
  return answer?.hookSpecificOutput?.permissionDecisionReason ?? "";
}
