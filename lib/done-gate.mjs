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
// It cannot tell a subset from the whole suite: a run counts whatever it covered, and which
// tests ran is in the runner's own result line.
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
  if (!claim) return null;

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
  const since = moments.slice(lastEdit + 1);
  const gates = since.filter((m) => m.kind === "gate");
  if (gates.length === 0) {
    // "It is not verified" is the honest answer this hook asks for, so it ends the question.
    // It never excuses a run that failed (below).
    if (admitsUnverified(final)) return null;
    const unread = since.find((m) => m.kind === "unread");
    const nothing = unread
      ? `no test this hook can recognise has run since (it could not parse \`${unread.command}\`)`
      : "no test has run since";
    return {
      feedback:
        `DONE-GATE: your final message says “${claim}”, but ${edited} was edited and ${nothing}. ` +
        "Run the project's tests now and quote the result line, or say plainly that this work " +
        "is not verified.",
    };
  }
  const last = gates.at(-1);
  const outcome = outcomeOf(last, activity.results.get(last.useId));
  if (outcome?.failed) {
    return {
      feedback:
        `DONE-GATE: your final message says “${claim}”, but the last test run after your ` +
        `edits failed: \`${last.command}\` (${outcome.why}). Fix it and run it again, or say ` +
        "plainly that the work is not done.",
    };
  }
  if (outcome) {
    return {
      feedback:
        `DONE-GATE: your final message says “${claim}”, but \`${last.command}\` ${outcome.why}. ` +
        "Quote the test run's own result line, or say plainly that the work is not verified.",
    };
  }
  return null;
}

// ─── Reading the claim ──────────────────────────────────────────────────────────────────

const CLAIM = new RegExp(
  String.raw`\b(?:done|finished|complete(?:d)?|landed|shipped|pushed|committed|merged|fixed|` +
    String.raw`resolved|implemented|all green|(?:it's|it is|that's|everything is|all|now) (?:working|live|green)|` +
    String.raw`(?:all )?(?:the )?tests? (?:are |now |all )?pass(?:es|ed|ing)?|ready (?:to (?:ship|merge|go)|for review))\b`,
  "gi",
);
// A negation governs the next few words of its own clause: whole words only ("now" and "note"
// are not "no"), never across ; : or , ("No failing tests remain; all tests pass" is a claim),
// and not the "not only" of an addition.
const NEGATION_BEFORE =
  /(?:\b(?:not(?!\s+only\b)|nothing|never|no|without)\b|n't\b)[^\w;:,]{0,3}(?:\w+[^\w;:,]+){0,3}$/i;
// An admission about the work as a whole. "Not tested on Windows" qualifies itself to a corner
// of the work and admits nothing about the rest.
const UNVERIFIED = new RegExp(
  String.raw`\b(?:unverified|untested|not (?:yet )?(?:been )?(?:verified|tested)|` +
    String.raw`(?:haven't|have not|didn't|did not|couldn't|could not) (?:run|verify|test)(?:\s+(?:it|them|this|the tests?|anything))?|` +
    String.raw`without (?:running|testing|verifying))\b(?!\s+(?:on|in|with|against|for|under)\b)`,
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
 * @typedef {{ kind: "gate", useId: string, command: string, hidden: boolean }} GateMoment
 *   `hidden` when the Bash call's exit status is not this test run's own
 * @typedef {{ kind: "unread", command: string }} UnreadMoment a Bash call the grammar could not
 *   fully parse, which may hold a test run this hook cannot see
 */

/**
 * Edits and test runs in the order they happened, down to the order inside one Bash call, so
 * `sed -i … && pytest` counts as a test run after the edit.
 *
 * @param {import("./transcript.mjs").ToolUse[]} uses
 * @param {string[]} extra
 * @returns {Promise<Array<EditMoment | GateMoment | UnreadMoment>>}
 */
async function timeline(uses, extra) {
  /** @type {Array<EditMoment | GateMoment | UnreadMoment>} */
  const moments = [];
  for (const use of uses) {
    if (use.name === "Edit" || use.name === "Write" || use.name === "MultiEdit") {
      const file = String(use.input?.file_path ?? "");
      if (isCodeFile(file)) moments.push({ kind: "edit", file: basename(file) || file });
    } else if (use.name === "NotebookEdit") {
      moments.push({ kind: "edit", file: basename(String(use.input?.notebook_path ?? "a notebook")) });
    } else if (use.name === "Bash" && typeof use.input?.command === "string") {
      const text = use.input.command;
      const { events, hasError } = await listCommands(text);
      const commands = events.filter((e) => e.kind === "command");
      const pipefail = commands.some((e) => basename(e.argv[0] ?? "") === "set" && e.argv.includes("pipefail"));
      commands.forEach((event, index) => {
        const edit = inPlaceEdit(event.argv);
        if (edit) moments.push({ kind: "edit", file: edit });
        if (isTestCommand(event.argv, extra)) {
          // The Bash call's exit status is its last command's. A test piped onward without
          // pipefail, or followed by anything (`; echo done`, `|| true`), does not own it.
          const piped = isFeeder(event, commands) && !pipefail;
          const hidden = piped || index < commands.length - 1;
          moments.push({ kind: "gate", useId: use.id, command: firstLine(text), hidden });
        }
      });
      if (hasError) moments.push({ kind: "unread", command: firstLine(text) });
    }
  }
  return moments;
}

/**
 * A command whose output is piped onward, so its exit status is not the pipeline's. The lister
 * hands each stage its feeder's own argv array, so identity names the stage exactly.
 */
function isFeeder(event, commands) {
  return commands.some((e) => e.feeder === event.argv);
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

// Words that run the word after them, and the options of theirs that take a value.
const RUNNERS = new Map(
  [
    ["time", []], ["nice", ["-n", "--adjustment"]], ["nohup", []], ["command", []], ["exec", []],
    ["env", ["-u", "--unset", "-C", "--chdir", "-S"]], ["sudo", ["-u", "-g", "--user", "--group"]],
    ["npx", ["-p", "--package"]], ["bunx", []], ["xvfb-run", ["-s", "-n", "-f"]], ["dotenv", ["-e"]],
  ].map(([name, valued]) => [name, new Set(valued)]),
); // prettier-ignore
const RUNNER_PAIRS = new Set([
  "uv run", "poetry run", "pdm run", "hatch run", "pipenv run", "rye run", "pixi run",
  "bundle exec", "pnpm exec", "pnpm dlx", "yarn dlx", "npm exec", "mise exec", "devbox run",
]); // prettier-ignore
// Options of `timeout` that take a value of their own.
const TIMEOUT_VALUED = new Set(["-k", "-s", "--kill-after", "--signal"]);
// Container runners: skip their options, then the service, container or image, and the
// command after that is what runs.
const CONTAINER_RUNS = new Map([
  ["docker compose run", ["-e", "-w", "-u", "-v", "--env", "--workdir", "--user", "--volume", "--name", "--entrypoint"]],
  ["docker compose exec", ["-e", "-w", "-u", "--env", "--workdir", "--user", "--index"]],
  ["docker-compose run", ["-e", "-w", "-u", "-v", "--env", "--workdir", "--user", "--volume", "--name", "--entrypoint"]],
  ["docker-compose exec", ["-e", "-w", "-u", "--env", "--workdir", "--user", "--index"]],
  ["docker exec", ["-e", "-w", "-u", "--env", "--workdir", "--user"]],
  ["docker run", ["-e", "-w", "-u", "-v", "-p", "--env", "--workdir", "--user", "--volume", "--name", "--network", "--entrypoint"]],
].map(([words, valued]) => [words, new Set(valued)]));

const TEST_SCRIPT = /^(?:test|tests|check|verify|ci|gate)(?::[\w:.-]*)?$/;
const SINGLE = new Set([
  "pytest", "py.test", "tox", "nox", "vitest", "jest", "mocha", "ava", "tap", "rspec", "phpunit",
  "pest", "ctest", "bats", "busted", "karma", "jasmine", "nextest",
]); // prettier-ignore
// One subcommand decides: `cargo test`, `go test`. Valued options are skipped to find it.
const SUBCOMMAND = new Map([
  ["cargo", [/^(?:test|nextest)$/, ["-p", "--package", "--manifest-path", "-j", "--jobs", "--target", "-Z"]]],
  ["go", [/^test$/, []]], ["deno", [/^test$/, []]], ["bun", [/^test$/, []]],
  ["dotnet", [/^test$/, []]], ["swift", [/^test$/, []]], ["mix", [/^test$/, []]],
  ["flutter", [/^test$/, []]], ["dart", [/^test$/, []]], ["rails", [/^test$/, []]],
  ["hatch", [/^test$/, []]], ["playwright", [/^test$/, []]], ["cypress", [/^run$/, []]],
  ["composer", [/^test$/, ["-d", "--working-dir"]]], ["xcodebuild", [/^test$/, ["-scheme", "-project", "-workspace", "-destination"]]],
].map(([tool, [pattern, valued]]) => [tool, { pattern, valued: new Set(valued) }])); // prettier-ignore
// Any of several goals decides: `mvn clean test`, `make -j 4 check`.
const GOALS = new Map([
  ["make", [/^(?:test|tests|check|verify|ci|gate)$/, ["-j", "-C", "-f", "-l", "--jobs", "--directory", "--file"]]],
  ["just", [TEST_SCRIPT, ["-f", "-d", "--justfile", "--working-directory"]]],
  ["task", [TEST_SCRIPT, ["-d", "-t", "--dir", "--taskfile"]]],
  ["rake", [/^(?:test|spec)(?::\S*)?$/, ["-f", "-C"]]],
  ["mvn", [/^(?:test|verify|install)$/, ["-P", "-pl", "-f", "-D", "-T", "-s", "--projects", "--file"]]],
  ["mvnw", [/^(?:test|verify|install)$/, ["-P", "-pl", "-f", "-D", "-T", "-s", "--projects", "--file"]]],
  ["gradle", [/^(?:test|check|build)$|:test$/, ["-p", "-x", "--project-dir", "--exclude-task"]]],
  ["gradlew", [/^(?:test|check|build)$|:test$/, ["-p", "-x", "--project-dir", "--exclude-task"]]],
].map(([tool, [pattern, valued]]) => [tool, { pattern, valued: new Set(valued) }])); // prettier-ignore
// Package managers: the first operand is a script name or `run <script>`.
const PACKAGE_VALUED = new Set(["--filter", "-F", "--prefix", "-C", "--dir", "--cwd", "-w", "--workspace"]);

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

  if (SINGLE.has(tool)) return true;
  if (/^python(?:\d(?:\.\d+)?)?$|^py$/.test(tool)) {
    const m = rest.indexOf("-m");
    if (m >= 0) return /^(?:pytest|unittest|tox|nox)$/.test(rest[m + 1] ?? "");
    const [script, sub] = operands(rest, new Set(["-W", "-X"]));
    return /(?:^|\/)manage\.py$/.test(script ?? "") && sub === "test"; // Django
  }
  if (tool === "node") return rest.includes("--test");
  if (tool === "zig") return rest[0] === "build" && rest[1] === "test";
  if (tool === "npm" || tool === "pnpm" || tool === "yarn" || tool === "bun") {
    const [first, second] = operands(rest, PACKAGE_VALUED);
    if (/^(?:test|t|tst)$/.test(first ?? "")) return true;
    if (first === "run" || first === "run-script") return TEST_SCRIPT.test(second ?? "");
    return tool !== "npm" && TEST_SCRIPT.test(first ?? ""); // `pnpm test:unit`, `yarn check`
  }
  const goals = GOALS.get(tool);
  if (goals) return operands(rest, goals.valued).some((w) => goals.pattern.test(w));
  const sub = SUBCOMMAND.get(tool);
  if (sub) {
    const [first] = operands(rest.filter((w) => !w.startsWith("+")), sub.valued); // `cargo +nightly test`
    return sub.pattern.test(first ?? "");
  }
  return false;
}

/** The non-option words, skipping the values of options that take one. */
function operands(words, valued) {
  const out = [];
  for (let i = 0; i < words.length; i += 1) {
    const w = words[i];
    if (w.startsWith("-")) {
      if (valued.has(w)) i += 1;
      continue;
    }
    out.push(w);
  }
  return out;
}

/** The command a chain of runner words finally runs. */
function peelRunners(argv) {
  let words = argv;
  for (let depth = 0; depth < 6 && words.length > 0; depth += 1) {
    const tool = basename(words[0]);
    const pair = `${tool} ${words[1] ?? ""}`;
    const triple = `${pair} ${words[2] ?? ""}`;
    const container = CONTAINER_RUNS.get(triple) ? [triple, 3] : CONTAINER_RUNS.get(pair) ? [pair, 2] : null;
    if (container) {
      const valued = CONTAINER_RUNS.get(container[0]);
      let i = container[1];
      while (i < words.length && words[i].startsWith("-")) i += valued.has(words[i]) ? 2 : 1;
      words = words.slice(i + 1); // past the service, container or image
    } else if (RUNNER_PAIRS.has(pair)) {
      words = skipOptions(words.slice(2), new Set());
    } else if (tool === "timeout") {
      let i = 1;
      while (i < words.length && words[i].startsWith("-")) i += TIMEOUT_VALUED.has(words[i]) ? 2 : 1;
      words = words.slice(i + 1); // past the duration
    } else if (RUNNERS.has(tool)) {
      words = skipOptions(words.slice(1), RUNNERS.get(tool));
    } else {
      break;
    }
  }
  return words;
}

/** Past leading options (and their values) and `NAME=value` words (`env -i FOO=1 cmd`). */
function skipOptions(words, valued) {
  let i = 0;
  while (i < words.length && (words[i].startsWith("-") || /^[A-Za-z_]\w*=/.test(words[i]))) {
    i += valued.has(words[i]) ? 2 : 1;
  }
  return words.slice(i);
}

// ─── Did it fail? ───────────────────────────────────────────────────────────────────────

// Summary lines that mean "some tests failed", from the runners people actually use. Read only
// when the Bash call's exit status is not the test run's own. Otherwise the exit status is the
// truth. Each is anchored to a summary line, so "step 5 failed to start" in a log is not a tally.
const FAILURE_TALLIES = [
  /^[\s=|]*(?:Tests?:?\s+)?[1-9]\d* (?:failed|failing|errors?)\b(?!\s+to\b)/m, // pytest, mocha, jest
  /\b[1-9]\d* failed\b[^\n]*\bpassed\b|\bpassed\b[^\n]*\b[1-9]\d* failed\b/, // "3 passed, 2 failed"
  /^\s*ℹ fail [1-9]/m, // node --test
  /^# fail [1-9]/m, // TAP
  /\btest result: FAILED\b/, // cargo
  /^(?:--- )?FAIL\b/m, // go, jest per-file
  /\bFAILED \((?:failures|errors)=/, // unittest
  /\bBUILD (?:FAILURE|FAILED)\b/, // maven, gradle
];

/**
 * What the test run's result says: it failed, it cannot be told, or (null) it passed.
 *
 * When the exit status is the test run's own, it is the truth. When it is not (`pytest | tail`,
 * `pytest; git push`), the status belongs to whatever ran after the tests: only a failure tally
 * in the output says the tests failed, and a non-zero exit with none says only that something
 * after them failed.
 *
 * @param {GateMoment} gate
 * @param {import("./transcript.mjs").ToolResult | undefined} result
 * @returns {{ failed: boolean, why: string } | null}
 */
function outcomeOf(gate, result) {
  if (!result) return null;
  const code = /^Exit code (\d+)/.exec(result.text)?.[1];
  const exited = code ? `exit code ${code}` : "an error";
  if (!gate.hidden) return result.isError ? { failed: true, why: exited } : null;
  const line = FAILURE_TALLIES.map((re) => summaryLine(result.text, re)).find(Boolean);
  if (line) return { failed: true, why: `its output says “${line}”, and the command hid the exit status` };
  if (result.isError) {
    return {
      failed: false,
      why: `ended with ${exited} from a command after the tests, which hides the test run's own status`,
    };
  }
  return null;
}

/** The whole output line a tally matched on, trimmed, so the quote reads as the runner wrote it. */
function summaryLine(text, re) {
  const m = re.exec(text);
  if (!m) return "";
  const start = text.lastIndexOf("\n", m.index) + 1;
  const end = text.indexOf("\n", m.index);
  const line = text.slice(start, end < 0 ? text.length : end).trim();
  return line.length > 100 ? `${line.slice(0, 99)}…` : line;
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
