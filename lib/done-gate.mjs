// DONE-GATE: a Stop hook that will not let "done" stand on edits nobody tested.
//
// The failure it exists for: code is edited, and the turn ends on "Done, all fixed" with no test
// run after the last edit. Sometimes a test ran BEFORE the last edit, sometimes a subset ran,
// sometimes the run failed and the output was piped into `tail`, which exited 0. The claim reads
// exactly the same in every case, and the person reading it has no way to tell.
//
// So when Claude is about to stop, this reads what the session actually did, in order:
//
//   the final message claims completion         ("done", "fixed", "all tests pass", …)
//   and a code file was edited                   (Edit / Write / MultiEdit / NotebookEdit, sed -i)
//   and after the LAST such edit, either
//     no test command ran                        -> keep working: run it, or say it is unverified
//     or the last one failed                     -> keep working: it failed
//
// It refuses at most once per stop. Claude Code's own `stop_hook_active` flag sees to that.
// A final message that already says the work is not verified is left alone: that is the honest
// answer this hook asks for, and asking again would only nag.

import { basename, extname } from "node:path";

import { listCommands } from "./shell.mjs";
import { readActivity } from "./transcript.mjs";

/** Set JORD0_DONE_GATE=0 to switch the hook off for one session or one shell. */
export const OFF_SWITCH = "JORD0_DONE_GATE";

/** Extra test commands, comma-separated, matched as a prefix: JORD0_DONE_GATE_COMMANDS="make ci,./verify.sh" */
export const EXTRA_COMMANDS = "JORD0_DONE_GATE_COMMANDS";

/**
 * @param {Record<string, unknown>} payload the Stop hook payload
 * @param {{ env?: NodeJS.ProcessEnv }} [options]
 * @returns {Promise<import("./runner.mjs").StopOutcome | null>}
 */
export async function judge(payload, { env = process.env } = {}) {
  if (env[OFF_SWITCH] === "0") return null;
  const final = typeof payload.last_assistant_message === "string" ? payload.last_assistant_message : "";
  const claim = completionClaim(final);
  if (!claim || admitsUnverified(final)) return null;

  const path = typeof payload.transcript_path === "string" ? payload.transcript_path : "";
  if (!path) return { notice: "DONE-GATE: the payload named no transcript, so this stop was not checked." };
  const activity = await readActivity(path);
  if (!activity.readable) {
    return { notice: "DONE-GATE: the transcript could not be read, so this stop was not checked." };
  }

  const moments = await timeline(activity.uses, extraCommands(env));
  const lastEdit = moments.findLastIndex((m) => m.kind === "edit");
  if (lastEdit < 0) return null;
  const edited = moments[lastEdit].file;
  const gates = moments.slice(lastEdit + 1).filter((m) => m.kind === "gate");
  if (gates.length === 0) {
    return {
      feedback:
        `DONE-GATE: your final message says “${claim}”, but ${edited} was edited and no test ` +
        "has run since. Run the project's tests now and quote the result line, or say plainly " +
        "that this work is not verified.",
    };
  }
  const last = gates.at(-1);
  const failure = failureOf(last, activity.results.get(last.useId));
  if (failure) {
    return {
      feedback:
        `DONE-GATE: your final message says “${claim}”, but the last test run after your ` +
        `edits failed: \`${last.command}\` (${failure}). Fix it and run it again, or say ` +
        "plainly that the work is not done.",
    };
  }
  return null;
}

// ─── Reading the claim ──────────────────────────────────────────────────────────────────

const CLAIM = new RegExp(
  String.raw`\b(?:done|finished|complete(?:d)?|landed|shipped|pushed|committed|merged|fixed|` +
    String.raw`resolved|implemented|all green|(?:is|are|it's|that's|now) (?:working|live|green)|` +
    String.raw`(?:all )?tests? (?:now )?pass(?:es|ed|ing)?|ready (?:to (?:ship|merge|go)|for review))\b`,
  "gi",
);
const NEGATION_BEFORE = /(?:\b(?:not|nothing|never|no|without)|n't)\W{0,3}(?:\w+\W+){0,3}$/i;
const UNVERIFIED = new RegExp(
  String.raw`\b(?:unverified|untested|not (?:yet )?(?:been )?(?:verified|tested)|` +
    String.raw`(?:haven't|have not|didn't|did not|couldn't|could not) (?:run|verify|test)|` +
    String.raw`without (?:running|testing|verifying))\b`,
  "i",
);

/**
 * The sentence of `text` that claims the work is complete, or "". A claim word that is negated
 * ("nothing is committed") or only quoted (`done`, "fixed") is not a claim.
 *
 * @param {string} text
 */
export function completionClaim(text) {
  const scan = text.replace(/`[^`\n]*`|"[^"\n]*"|“[^”\n]*”/g, (m) => " ".repeat(m.length));
  for (const match of scan.matchAll(CLAIM)) {
    const start = Math.max(scan.lastIndexOf(".", match.index), scan.lastIndexOf("\n", match.index)) + 1;
    if (NEGATION_BEFORE.test(scan.slice(start, match.index))) continue;
    const ends = [scan.indexOf(".", match.index), scan.indexOf("\n", match.index)].filter((i) => i >= 0);
    const end = ends.length ? Math.min(...ends) + 1 : scan.length;
    return text.slice(start, end).split(/\s+/).filter(Boolean).join(" ").slice(0, 160);
  }
  return "";
}

/** @param {string} text */
export function admitsUnverified(text) {
  return UNVERIFIED.test(text);
}

// ─── What the session did ───────────────────────────────────────────────────────────────

/**
 * @typedef {{ kind: "edit", file: string }} EditMoment
 * @typedef {{ kind: "gate", useId: string, command: string, piped: boolean, pipefail: boolean }} GateMoment
 */

/**
 * Edits and test runs in the order they happened, down to the order inside one Bash call, so
 * `sed -i … && pytest` counts as a test run after the edit.
 *
 * @param {import("./transcript.mjs").ToolUse[]} uses
 * @param {string[]} extra
 * @returns {Promise<Array<EditMoment | GateMoment>>}
 */
async function timeline(uses, extra) {
  const moments = [];
  for (const use of uses) {
    if (use.name === "Edit" || use.name === "Write" || use.name === "MultiEdit") {
      const file = String(use.input?.file_path ?? "");
      if (isCodeFile(file)) moments.push({ kind: "edit", file: basename(file) || file });
    } else if (use.name === "NotebookEdit") {
      moments.push({ kind: "edit", file: basename(String(use.input?.notebook_path ?? "a notebook")) });
    } else if (use.name === "Bash" && typeof use.input?.command === "string") {
      const text = use.input.command;
      const { events } = await listCommands(text);
      const pipefail = /\bpipefail\b/.test(text);
      for (const event of events) {
        if (event.kind !== "command") continue;
        const edit = inPlaceEdit(event.argv);
        if (edit) moments.push({ kind: "edit", file: edit });
        if (isTestCommand(event.argv, extra)) {
          const piped = event.pipeIndex > 0 || isFeeder(event, events);
          moments.push({ kind: "gate", useId: use.id, command: firstLine(text), piped, pipefail });
        }
      }
    }
  }
  return moments;
}

/**
 * A command whose output is piped onward, so its exit status is not the pipeline's. The lister
 * hands each stage its feeder's own argv array, so identity names the stage exactly.
 */
function isFeeder(event, events) {
  return events.some((e) => e.kind === "command" && e.feeder === event.argv);
}

const PROSE = new Set([
  ".md", ".markdown", ".mdx", ".rst", ".txt", ".adoc", ".org", ".csv", ".tsv", ".log",
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".svg", ".pdf",
]); // prettier-ignore

/** Code is everything that is not prose or an image, extensionless files (Makefile) included. */
function isCodeFile(path) {
  return path !== "" && !PROSE.has(extname(path).toLowerCase());
}

/** `sed -i` / `perl -pi` editing something other than prose; the edited file's name, or "". */
function inPlaceEdit(argv) {
  const tool = basename(argv[0] ?? "");
  const inPlace =
    ((tool === "sed" || tool === "gsed") && argv.some((a) => /^-[a-zA-Z]*i|^--in-place/.test(a))) ||
    (tool === "perl" && argv.some((a) => /^-[a-zA-Z]*i/.test(a)));
  if (!inPlace) return "";
  const files = argv.slice(1).filter((a) => !a.startsWith("-") && extname(a) !== "");
  if (files.length > 0 && files.every((f) => !isCodeFile(f))) return "";
  return files.length ? basename(files.at(-1)) : `a file (\`${tool} -i\`)`;
}

// ─── Recognising a test run ─────────────────────────────────────────────────────────────

// Words that run the word after them: `timeout 60 pytest`, `uv run pytest`, `npx vitest`.
const RUNNERS = new Set(["time", "nice", "nohup", "command", "exec", "env", "sudo", "npx", "bunx", "xvfb-run", "dotenv"]);
const RUNNER_PAIRS = new Set([
  "uv run", "poetry run", "pdm run", "hatch run", "pipenv run", "rye run", "pixi run",
  "bundle exec", "pnpm exec", "pnpm dlx", "yarn dlx", "npm exec", "mise exec", "devbox run",
]); // prettier-ignore
// Options of `timeout` that take a value of their own.
const TIMEOUT_VALUED = new Set(["-k", "-s", "--kill-after", "--signal"]);

const TEST_SCRIPT = /^(?:test|tests|check|verify|ci|gate)(?:$|[:._-])/;
const SINGLE = new Set([
  "pytest", "py.test", "tox", "nox", "vitest", "jest", "mocha", "ava", "tap", "rspec", "phpunit",
  "pest", "ctest", "bats", "busted", "karma", "jasmine", "nextest",
]); // prettier-ignore
const SUBCOMMAND = {
  cargo: /^(?:test|nextest)$/, go: /^test$/, deno: /^test$/, bun: /^test$/, dotnet: /^test$/,
  swift: /^test$/, mix: /^test$/, flutter: /^test$/, dart: /^test$/, rake: /^(?:test|spec)$/,
  rails: /^test$/, hatch: /^test$/, playwright: /^test$/, cypress: /^run$/, composer: /^test$/,
  xcodebuild: /^test$/, mvn: /^(?:test|verify)$/, mvnw: /^(?:test|verify)$/,
  gradle: /^(?:test|check)$/, gradlew: /^(?:test|check)$/,
}; // prettier-ignore

/**
 * Does this simple command run a project's tests?
 *
 * @param {string[]} argv
 * @param {string[]} [extra] user-supplied command prefixes
 */
export function isTestCommand(argv, extra = []) {
  const words = peelRunners(argv);
  if (words.length === 0) return false;
  const joined = words.join(" ");
  if (extra.some((prefix) => joined === prefix || joined.startsWith(`${prefix} `))) return true;
  const tool = basename(words[0]);
  const rest = words.slice(1);
  const firstArg = rest.find((w) => !w.startsWith("-")) ?? "";

  if (SINGLE.has(tool)) return true;
  if (/^python(?:\d(?:\.\d+)?)?$|^py$/.test(tool)) {
    const m = rest.indexOf("-m");
    return m >= 0 && /^(?:pytest|unittest|tox|nox)$/.test(rest[m + 1] ?? "");
  }
  if (tool === "node") return rest.includes("--test");
  if (tool === "make" || tool === "just" || tool === "task") return TEST_SCRIPT.test(firstArg);
  if (tool === "npm" || tool === "pnpm" || tool === "yarn" || tool === "bun") {
    if (/^(?:test|t|tst)$/.test(firstArg)) return true;
    if (firstArg === "run" || firstArg === "run-script") {
      return TEST_SCRIPT.test(rest[rest.indexOf(firstArg) + 1] ?? "");
    }
    return tool !== "npm" && TEST_SCRIPT.test(firstArg); // `pnpm test:unit`, `yarn check`
  }
  if (tool === "zig") return rest[0] === "build" && rest[1] === "test";
  const pattern = SUBCOMMAND[tool];
  return pattern ? pattern.test(firstArg) : false;
}

/** The command a chain of runner words finally runs. */
function peelRunners(argv) {
  let words = argv;
  for (let depth = 0; depth < 6 && words.length > 0; depth += 1) {
    const tool = basename(words[0]);
    if (RUNNER_PAIRS.has(`${tool} ${words[1] ?? ""}`)) {
      words = skipOptions(words.slice(2));
    } else if (tool === "timeout") {
      let i = 1;
      while (i < words.length && words[i].startsWith("-")) i += TIMEOUT_VALUED.has(words[i]) ? 2 : 1;
      words = words.slice(i + 1); // past the duration
    } else if (RUNNERS.has(tool)) {
      words = skipOptions(words.slice(1));
    } else {
      break;
    }
  }
  return words;
}

/** Past leading options and `NAME=value` words (`env -i FOO=1 cmd`). */
function skipOptions(words) {
  let i = 0;
  while (i < words.length && (words[i].startsWith("-") || /^[A-Za-z_]\w*=/.test(words[i]))) i += 1;
  return words.slice(i);
}

// ─── Did it fail? ───────────────────────────────────────────────────────────────────────

// Summary lines that mean "some tests failed", from the runners people actually use. Read only
// when a pipe hid the exit status. Otherwise the exit status is the truth.
const FAILURE_TALLIES = [
  /\b[1-9]\d* (?:failed|failing|failures?|errors?)\b/i, // pytest, mocha, jest, vitest
  /^\s*ℹ fail [1-9]/m, // node --test
  /^# fail [1-9]/m, // TAP
  /\btest result: FAILED\b/, // cargo
  /^(?:--- )?FAIL\b/m, // go, jest per-file
  /\bFAILED \((?:failures|errors)=/, // unittest
  /\bBUILD (?:FAILURE|FAILED)\b/, // maven, gradle
];

/**
 * Why the test run failed, or "" when it did not (or cannot be told).
 *
 * @param {GateMoment} gate
 * @param {import("./transcript.mjs").ToolResult | undefined} result
 */
function failureOf(gate, result) {
  if (!result) return "";
  if (result.isError) {
    const code = /^Exit code (\d+)/.exec(result.text)?.[1];
    return code ? `exit code ${code}` : "it returned an error";
  }
  if (gate.piped && !gate.pipefail) {
    const tally = FAILURE_TALLIES.map((re) => re.exec(result.text)?.[0]).find(Boolean);
    if (tally) return `its output says “${tally.trim()}”, and the pipe hid the exit status`;
  }
  return "";
}

function extraCommands(env) {
  return (env[EXTRA_COMMANDS] ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function firstLine(text) {
  const line = text.trim().split("\n")[0];
  return line.length > 120 ? `${line.slice(0, 119)}…` : line;
}
