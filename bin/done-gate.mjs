// DONE-GATE (Stop): keeps Claude working when its final message claims the work is done but no
// test has run since the last code edit, or the last one failed. Logic: lib/done-gate.mjs.
import { stopMain } from "../lib/runner.mjs";

await stopMain("DONE-GATE", () => import("../lib/done-gate.mjs"));
