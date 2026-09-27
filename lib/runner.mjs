// The fail policy, in one place, for every hook in this repository.
//
// Claude Code treats a PreToolUse hook that crashes (any exit code but 2) as a non-blocking
// error: it logs it and runs the tool. So a guard that dies on a missing package, a bad payload
// or a bug of its own quietly becomes no guard at all. Everything that can go wrong goes wrong
// in here instead, where it becomes a decision:
//
//   PreToolUse guard  fault or crash  ->  ask on the main thread, deny inside a subagent
//   Stop hook         fault or crash  ->  let the stop through, and say so to the user
//
// The Stop direction is deliberately the opposite. A broken guard that asks costs a click; a
// broken Stop hook that refuses would hold the session in a loop it can never leave.
//
// The entry scripts import only this file. Everything with a dependency is loaded later, by
// dynamic import inside the try below, so even "the grammar package is not installed" lands
// here as a reason instead of killing the process before any of this code can run.

import { Fault, notice, permission, readPayload, stopFeedback } from "./io.mjs";

/** Leaves room inside the 10 s hook timeout for Node to start and the grammar to load. */
export const BUDGET_MS = 4000;

/**
 * @typedef {{ decision: "ask" | "deny", reason: string }} Verdict
 * @typedef {{ judge(payload: Record<string, unknown>, ctx: { signal: AbortSignal }): Promise<Verdict | null> }} Guard
 * @typedef {{ feedback?: string, notice?: string }} StopOutcome
 * @typedef {{ judge(payload: Record<string, unknown>, ctx: { signal: AbortSignal }): Promise<StopOutcome | null> }} StopHook
 */

/**
 * Run a PreToolUse guard and return what to print: a decision object, or null for silence.
 *
 * @param {string} name
 * @param {() => Promise<Guard>} load
 * @param {{ stdin?: NodeJS.ReadableStream, budgetMs?: number,
 *           onPayload?: (payload: Record<string, unknown>) => void }} [options]
 */
export async function runGuard(
  name,
  load,
  { stdin = process.stdin, budgetMs = BUDGET_MS, onPayload } = {},
) {
  const payload = await readPayload(stdin);
  if (payload instanceof Fault) {
    return permission(
      "ask",
      `${name} could not read its input (${payload.message}), so this command was not checked.`,
    );
  }
  onPayload?.(payload);
  const agentId = agentIdOf(payload);
  try {
    const guard = await load();
    const verdict = await withinBudget(budgetMs, (signal) => guard.judge(payload, { signal }));
    return verdict ? permission(verdict.decision, verdict.reason) : null;
  } catch (err) {
    return guardFailed(name, agentId, err);
  }
}

/**
 * Run a Stop hook and return what to print: feedback that keeps Claude working, a notice for
 * the user, or null to let the stop through without comment.
 *
 * @param {string} name
 * @param {() => Promise<StopHook>} load
 * @param {{ stdin?: NodeJS.ReadableStream, budgetMs?: number }} [options]
 */
export async function runStop(name, load, { stdin = process.stdin, budgetMs = BUDGET_MS } = {}) {
  const payload = await readPayload(stdin);
  if (payload instanceof Fault) {
    return notice(`${name} could not read its input (${payload.message}); this stop was not checked.`);
  }
  // Claude Code sets this when the turn is already continuing because a Stop hook refused.
  // Refusing again would only spend the session's continuation cap on the same complaint.
  if (payload.stop_hook_active === true) return null;
  try {
    const hook = await load();
    const outcome = await withinBudget(budgetMs, (signal) => hook.judge(payload, { signal }));
    if (outcome?.feedback) return stopFeedback(outcome.feedback);
    if (outcome?.notice) return notice(outcome.notice);
    return null;
  } catch (err) {
    return notice(`${name} failed (${describe(err)}); this stop was not checked.`);
  }
}

/**
 * The process entry for a guard: run it, print the answer, exit 0. A stray exception that
 * escapes every await still becomes the failure decision, never a silent crash.
 *
 * @param {string} name
 * @param {() => Promise<Guard>} load
 */
export async function guardMain(name, load) {
  let agentId = "";
  process.once("uncaughtException", (err) => emit(guardFailed(name, agentId, err)));
  const onPayload = (payload) => {
    agentId = agentIdOf(payload);
  };
  emit(await runGuard(name, load, { onPayload }));
}

/**
 * The process entry for a Stop hook.
 *
 * @param {string} name
 * @param {() => Promise<StopHook>} load
 */
export async function stopMain(name, load) {
  process.once("uncaughtException", (err) =>
    emit(notice(`${name} failed (${describe(err)}); this stop was not checked.`)),
  );
  emit(await runStop(name, load));
}

/**
 * Claude Code puts `agent_id` in the payload only when the tool call comes from a subagent.
 *
 * @param {Record<string, unknown>} payload
 */
export function agentIdOf(payload) {
  return typeof payload.agent_id === "string" ? payload.agent_id : "";
}

/** @param {object | null} answer */
function emit(answer) {
  if (answer === null) process.exit(0);
  process.stdout.write(`${JSON.stringify(answer)}\n`, () => process.exit(0));
}

/**
 * @param {string} name
 * @param {string} agentId
 * @param {unknown} err
 */
function guardFailed(name, agentId, err) {
  const why = describe(err);
  if (agentId) {
    return permission(
      "deny",
      `${name} failed (${why}) and cannot vouch for this command. Do not run it; ` +
        "report what you were about to do instead.",
    );
  }
  return permission("ask", `${name} failed (${why}), so this command was not checked.`);
}

/**
 * Run `work` with an abort signal that fires after `budgetMs`, and reject when it does, even
 * if `work` ignores the signal.
 *
 * @template T
 * @param {number} budgetMs
 * @param {(signal: AbortSignal) => Promise<T>} work
 * @returns {Promise<T>}
 */
async function withinBudget(budgetMs, work) {
  const controller = new AbortController();
  let timer;
  const expired = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`over its ${budgetMs} ms budget`));
    }, budgetMs);
  });
  try {
    return await Promise.race([work(controller.signal), expired]);
  } finally {
    clearTimeout(timer);
  }
}

/** @param {unknown} err */
export function describe(err) {
  if (err && typeof err === "object" && "code" in err && err.code === "ERR_MODULE_NOT_FOUND") {
    const missing = /Cannot find (?:package|module) '([^']+)'/.exec(String(err.message))?.[1];
    return (
      `a dependency is not installed${missing ? `: ${missing}` : ""}. ` +
      "Reinstall the plugin so Claude Code installs its npm dependencies"
    );
  }
  if (err instanceof Error) return err.message;
  return String(err);
}
