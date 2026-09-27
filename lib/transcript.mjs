// Reads what a session DID from its transcript: the tools it called, in order, and what each
// call returned.
//
// The transcript is a JSONL file Claude Code writes for its own use. Its shape is not a public
// contract. So this reader is strict about what it accepts, forgiving about everything else,
// and honest about how much it understood: a transcript that is present but yields nothing is
// reported as unreadable, never as "the session did nothing".

import { open } from "node:fs/promises";

/** Only the tail matters (the edits and test runs near the end), and sessions get large. */
export const TAIL_BYTES = 3_000_000;

/**
 * @typedef {{ id: string, name: string, input: Record<string, any>, cwd: string | null }} ToolUse
 *   `cwd` is the directory the session was in when it made the call, where the transcript says
 * @typedef {{ isError: boolean, text: string }} ToolResult
 * @typedef {{ uses: ToolUse[], results: Map<string, ToolResult>, readable: boolean }} Activity
 */

/**
 * @param {string} path
 * @param {number} [tailBytes]
 * @returns {Promise<Activity>}
 */
export async function readActivity(path, tailBytes = TAIL_BYTES) {
  let text;
  let handle;
  try {
    handle = await open(path, "r");
    const { size } = await handle.stat();
    const start = Math.max(0, size - tailBytes);
    const buffer = Buffer.alloc(size - start);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
    text = buffer.subarray(0, bytesRead).toString("utf8");
  } catch {
    return { uses: [], results: new Map(), readable: false };
  } finally {
    await handle?.close();
  }
  return parseActivity(text);
}

/**
 * @param {string} text JSONL. A first line cut by the tail window is skipped like any bad line
 * @returns {Activity}
 */
export function parseActivity(text) {
  /** @type {ToolUse[]} */
  const uses = [];
  /** @type {Map<string, ToolResult>} */
  const results = new Map();
  let entries = 0;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    // Older versions interleaved subagent messages into the parent's file. They are not the
    // main thread's work and must not count as its edits or its test runs.
    if (entry?.isSidechain === true) continue;
    const content = entry?.message?.content;
    if (!Array.isArray(content)) continue;
    entries += 1;
    for (const block of content) {
      if (entry.type === "assistant" && block?.type === "tool_use" && typeof block.id === "string") {
        const cwd = typeof entry.cwd === "string" ? entry.cwd : null;
        uses.push({ id: block.id, name: String(block.name ?? ""), input: block.input ?? {}, cwd });
      } else if (entry.type === "user" && block?.type === "tool_result") {
        results.set(String(block.tool_use_id), {
          isError: block.is_error === true,
          text: resultText(block.content),
        });
      }
    }
  }
  return { uses, results, readable: entries > 0 };
}

/** A tool result's content is a string, or a list of blocks of which the text ones matter. */
function resultText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b) => b?.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("\n");
}
