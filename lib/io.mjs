// The wire format of a Claude Code hook: one JSON payload in on stdin, at most one JSON answer
// out on stdout.
//
// Reading never throws. An empty, late, or malformed payload comes back as a Fault, and the
// caller has to decide what that means. The tempting default, "I could not read the request, so
// I have nothing to object to", is the one that turns a broken guard into an open door.

export const STDIN_TIMEOUT_MS = 2000;

// Hook output strings are capped at 10,000 characters by Claude Code. A reason is a sentence
// or two, so this keeps a runaway message from being cut mid-thought by the harness instead.
const MAX_REASON = 2000;

export class Fault {
  /** @param {string} message what went wrong, phrased for the person who has to fix it */
  constructor(message) {
    this.message = message;
  }
}

/**
 * The hook payload as an object, or a Fault when it cannot be had.
 *
 * @param {NodeJS.ReadableStream & { isTTY?: boolean }} [stream]
 * @param {number} [timeoutMs]
 * @returns {Promise<Record<string, unknown> | Fault>}
 */
export function readPayload(stream = process.stdin, timeoutMs = STDIN_TIMEOUT_MS) {
  if (stream.isTTY) {
    return Promise.resolve(new Fault("no payload on stdin (it is a terminal, not a pipe)"));
  }
  return new Promise((resolve) => {
    const chunks = [];
    const finish = (result) => {
      clearTimeout(timer);
      stream.removeAllListeners("data");
      stream.removeAllListeners("end");
      stream.removeAllListeners("error");
      stream.pause();
      resolve(result);
    };
    const timer = setTimeout(
      () => finish(new Fault(`no complete payload on stdin within ${timeoutMs} ms`)),
      timeoutMs,
    );
    stream.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    stream.on("error", (err) => finish(new Fault(`stdin failed: ${err.message}`)));
    stream.on("end", () => finish(parse(Buffer.concat(chunks).toString("utf8"))));
  });
}

/** @param {string} text */
function parse(text) {
  if (!text.trim()) return new Fault("the payload on stdin was empty");
  let value;
  try {
    value = JSON.parse(text);
  } catch (err) {
    return new Fault(`the payload on stdin is not JSON (${err.message})`);
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return new Fault("the payload on stdin is not a JSON object");
  }
  return value;
}

/** @param {string} text */
function clip(text) {
  return text.length <= MAX_REASON ? text : `${text.slice(0, MAX_REASON - 1)}…`;
}

/**
 * A PreToolUse decision. Only "ask" and "deny" exist here on purpose: "allow" does not mean
 * "no objection" to Claude Code, it means "skip the user's permission prompt". A guard with no
 * objection says nothing at all and leaves the decision to the user's own settings.
 *
 * @param {"ask" | "deny"} decision
 * @param {string} reason shown to the user for ask, to Claude for deny
 */
export function permission(decision, reason) {
  if (decision !== "ask" && decision !== "deny") {
    throw new TypeError(`a guard may only ask or deny, not ${JSON.stringify(decision)}`);
  }
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: decision,
      permissionDecisionReason: clip(reason),
    },
  };
}

/**
 * Keep Claude working instead of stopping, with the reason as ordinary feedback. Claude Code
 * documents this channel for a Stop hook "working as designed": the same loop protection as a
 * block, without the hook-error banner a user did nothing to earn.
 *
 * @param {string} text
 */
export function stopFeedback(text) {
  return { hookSpecificOutput: { hookEventName: "Stop", additionalContext: clip(text) } };
}

/**
 * A message shown to the user and nothing else: how a hook that cannot do its job says so
 * without changing what happens next.
 *
 * @param {string} text
 */
export function notice(text) {
  return { systemMessage: clip(text) };
}
