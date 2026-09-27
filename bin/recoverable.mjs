// RECOVERABLE (PreToolUse, Bash): asks before a delete or a git discard that would destroy work
// git cannot give back, and refuses it outright inside a subagent. Logic: lib/recoverable/.
import { guardMain } from "../lib/runner.mjs";

await guardMain("RECOVERABLE", () => import("../lib/recoverable/index.mjs"));
