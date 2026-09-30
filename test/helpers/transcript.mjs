// Builds transcripts in the shape Claude Code writes them (one JSON object per line), so the
// DONE-GATE tests can describe a session as a list of steps instead of hand-written JSONL.

import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { scratchDir } from "./scratch.mjs";

let counter = 0;

/**
 * @typedef {object} ToolStep a tool call and what came back
 * @property {string} tool
 * @property {object} input
 * @property {boolean} [error]
 * @property {string} [output]
 * @property {string} [cwd]
 *
 * @typedef {ToolStep | { say: string } | { human: string }} Step
 */

/**
 * @param {Step[]} steps
 * @returns {string} path of a JSONL transcript file
 */
export function transcript(steps) {
  const lines = [];
  for (const step of steps) {
    if ("human" in step) {
      lines.push({
        type: "user",
        isSidechain: false,
        message: { role: "user", content: step.human },
      });
    } else if ("say" in step) {
      lines.push({
        type: "assistant",
        isSidechain: false,
        message: { role: "assistant", content: [{ type: "text", text: step.say }] },
      });
    } else {
      counter += 1;
      const id = `toolu_test_${counter}`;
      lines.push({
        type: "assistant",
        isSidechain: false,
        ...(step.cwd ? { cwd: step.cwd } : {}),
        message: {
          role: "assistant",
          content: [{ type: "tool_use", id, name: step.tool, input: step.input }],
        },
      });
      const output = step.output ?? (step.error ? "Exit code 1\n" : "ok");
      lines.push({
        type: "user",
        isSidechain: false,
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: id,
              content: output,
              ...(step.error ? { is_error: true } : {}),
            },
          ],
        },
      });
    }
  }
  const dir = scratchDir("jord0-hooks-transcript-");
  const path = join(dir, "session.jsonl");
  writeFileSync(path, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
  return path;
}

export const edit = (file_path) => ({
  tool: "Edit",
  input: { file_path, old_string: "a", new_string: "b" },
});
export const bash = (command, extra = {}) => ({ tool: "Bash", input: { command }, ...extra });
