// RECOVERABLE, assembled: list the commands in a Bash call, hand them to the dispatcher, and
// turn a probe failure into a decision naming it.
//
// The dispatcher (./dispatch.mjs) walks the listing: it sees through wrapper words, `find
// -exec`, `xargs`, `eval`, `bash -c` and heredocs fed to a shell, tracks `cd` and variables,
// and hands each command that really runs to the judge for its program:
//
//   export async function dispatch(listing, ctx): Promise<Verdict | null>
//     listing   { events, hasError } from listCommands(command)
//     ctx.cwd   the session's working directory
//     ctx.agentId, ctx.signal
//     ctx.shell   { listCommands, resolveWord }   for payloads it has to list in turn
//     ctx.judges  { rm, pipeFedRm, find, git, whereItRuns }   see ./judges.mjs for the contract
//
// It returns the first verdict any judge gives, or null. It judges the commands that WERE
// listed. A command the grammar could not read (`hasError`, as in `cat <<EOF; rm -rf wip`,
// which bash runs) is this file's business: when the dispatcher finds nothing, the question
// moves to where the call runs, because a command this guard cannot read is not a command
// that destroys nothing.

import { agentIdOf } from "../runner.mjs";
import { listCommands, resolveWord } from "../shell.mjs";
import * as judges from "./judges.mjs";

/**
 * @param {Record<string, any>} payload the PreToolUse payload
 * @param {{ signal: AbortSignal, dispatch?: Function }} options `dispatch` replaces
 *   ./dispatch.mjs, which is otherwise loaded here, inside the runner's fail policy
 * @returns {Promise<import("../runner.mjs").Verdict | null>}
 */
export async function judge(payload, { signal, dispatch }) {
  const command = payload.tool_input?.command;
  if (typeof command !== "string") throw new Error("the payload carries no tool_input.command string");
  const cwd = typeof payload.cwd === "string" ? payload.cwd : process.cwd();
  const agentId = agentIdOf(payload);
  const walk = dispatch ?? (await import("./dispatch.mjs")).dispatch;
  const listing = await listCommands(command);
  try {
    const verdict = await walk(listing, { cwd, agentId, signal, shell: { listCommands, resolveWord }, judges });
    if (verdict || !listing.hasError) return verdict;
    return await judges.whereItRuns("a command this guard cannot fully parse", { base: cwd, agentId, signal });
  } catch (err) {
    if (!(err instanceof judges.ProbeFailed)) throw err;
    const what = `RECOVERABLE could not ask git whether this command destroys uncommitted work (${err.message})`;
    return agentId
      ? { decision: "deny", reason: `${what}. Refused inside a subagent: report what you were about to run.` }
      : { decision: "ask", reason: `${what}.` };
  }
}
