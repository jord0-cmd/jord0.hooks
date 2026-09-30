// FLAG-PROBE (PreToolUse, Bash): refuses `<script> --help` on a script that does not parse the flag
// and has not been read this session, because such a script simply runs. Logic: lib/flag-probe.mjs.
import { guardMain } from "../lib/runner.mjs";

await guardMain("FLAG-PROBE", () => import("../lib/flag-probe.mjs"));
