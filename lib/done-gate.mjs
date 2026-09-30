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
//   and a code file was edited                   (Edit / Write / MultiEdit / NotebookEdit, sed -i,
//                                                 `cat > app.py <<EOF`, tee, git apply)
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

import { basename, extname, join } from "node:path";

import { SHELLS, peel } from "./commands.mjs";
import { guards, listCommands } from "./shell.mjs";
import { readActivity } from "./transcript.mjs";

/** Set JORD0_DONE_GATE=0 to switch the hook off for one session or one shell. */
const OFF_SWITCH = "JORD0_DONE_GATE";

/**
 * Extra test commands, comma-separated, each matched as a prefix:
 * JORD0_DONE_GATE_COMMANDS="make ci,./verify.sh"
 */
const EXTRA_COMMANDS = "JORD0_DONE_GATE_COMMANDS";

/**
 * @param {Record<string, unknown>} payload the Stop hook payload
 * @param {{ env?: NodeJS.ProcessEnv }} [options]
 * @returns {Promise<import("./runner.mjs").StopOutcome | null>}
 */
export async function judge(payload, { env = process.env } = {}) {
  if (env[OFF_SWITCH] === "0") return null;
  // Claude Code sends the final text on every Stop. Without it there is nothing to check a
  // claim in, and a hook that went quiet over a renamed field would look exactly like one
  // that found nothing wrong. An empty string is a turn that said nothing, and claims nothing.
  if (typeof payload.last_assistant_message !== "string") {
    return {
      notice: "DONE-GATE: the payload carried no final message, so this stop was not checked.",
    };
  }
  const final = payload.last_assistant_message;
  const claim = completionClaim(final);
  if (!claim) return null;

  const path = typeof payload.transcript_path === "string" ? payload.transcript_path : "";
  if (!path)
    return { notice: "DONE-GATE: the payload named no transcript, so this stop was not checked." };
  const activity = await readActivity(path);
  if (!activity.readable) {
    return { notice: "DONE-GATE: the transcript could not be read, so this stop was not checked." };
  }
  const moments = await timeline(activity.uses, extraCommands(env));
  return verdictFor(claim, final, moments, activity.results);
}

/** The claim against what ran since the last edit: no test, a failed one, or a hidden status. */
function verdictFor(claim, final, moments, results) {
  const lastEdit = moments.findLastIndex((m) => m.kind === "edit");
  if (lastEdit < 0) return null;
  const edited = moments[lastEdit].what;
  const since = moments.slice(lastEdit + 1);
  const gates = since.filter((m) => m.kind === "gate");
  if (gates.length === 0) return untested(claim, final, edited, since);
  const last = gates.at(-1);
  const outcome = outcomeOf(last, results.get(last.useId));
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

// No test since the edit. "It is not verified" is the honest answer this hook asks for, so it
// ends the question; it never excuses a run that failed (verdictFor).
function untested(claim, final, edited, since) {
  if (admitsUnverified(final)) return null;
  const unread = since.find((m) => m.kind === "unread");
  const nothing = unread
    ? `no test this hook can recognise has run since (it could not parse \`${unread.command}\`)`
    : "no test has run since";
  return {
    feedback:
      `DONE-GATE: your final message says “${claim}”, but ${edited} and ${nothing}. ` +
      "Run the project's tests now and quote the result line, or say plainly that this work " +
      "is not verified. A test command this hook does not know can be named in " +
      `${EXTRA_COMMANDS}.`,
  };
}

// ─── Reading the claim ──────────────────────────────────────────────────────────────────

const CLAIM = new RegExp(
  String.raw`\b(?:done|finished|complete(?:d)?|landed|shipped|pushed|committed|merged|fixed|` +
    String.raw`resolved|implemented|all green|all set|good to go|works now|` +
    String.raw`(?:it['’]s|it is|that['’]s|everything['’]s|everything is|all) ` +
    String.raw`(?:working|live|green)|` +
    String.raw`(?:all )?(?:the )?tests? (?:are |now |all )?pass(?:es|ed|ing)?|` +
    String.raw`ready (?:to (?:ship|merge|go)|for review))\b`,
  "gi",
);
// A negation governs the next few words of its own clause: whole words only ("now" and "note"
// are not "no"), never across ; : or , ("No failing tests remain; all tests pass" is a claim),
// and not the "not only" of an addition.
const NEGATION_BEFORE =
  /(?:\b(?:not(?!\s+only\b)|nothing|never|no|without)\b|n't\b)[^\w;:,]{0,3}(?:\w+[^\w;:,]+){0,3}$/i;
// "I committed nothing", "fixed none of them": a negation straight after the claim word.
const NEGATION_AFTER = /^[^\w;:,.]{0,3}(?:nothing|none|no\b|never)/i;
// A claim word inside a name is part of the name: `DONE-GATE`, `fixed-width`, `lib/done-gate.mjs`,
// `completed_tasks`. A full stop after it ends a sentence; one followed by a letter is a file name.
const IN_A_NAME_BEFORE = /[-_./\\]$/;
const IN_A_NAME_AFTER = /^(?:[-_/\\]|\.\w)/;
// "The complete list", "a complete rewrite": an article in front makes it an adjective.
const ARTICLE_BEFORE = /\b(?:the|a|an|this|that|its|our|my|your)\s+$/i;
// Work still to do is not work done: "needs to be fixed", "will be completed", "once it lands".
const NOT_YET_BEFORE = new RegExp(
  String.raw`\b(?:to be|will(?:\s+be)?|would(?:\s+be)?|needs?\s+to(?:\s+be)?|` +
    String.raw`going\s+to(?:\s+be)?|yet\s+to(?:\s+be)?|should(?:\s+be)?|` +
    String.raw`once|if|when|until|unless|before)\b[^\w;:,]{0,3}(?:\w+[^\w;:,]+){0,3}$`,
  "i",
);
// An admission about the work as a whole. "Not tested on Windows" qualifies itself to a corner
// of the work and admits nothing about the rest, and "I could not run the migration" admits
// nothing about the tests: the verb's object, when there is one, must be the work or its tests.
const OBJECT =
  String.raw`(?:\s+(?:it|them|this|that|anything|any tests?|tests?|` +
  String.raw`the (?:tests?|suite|specs?|code|change|changes|build|fix)))?`;
const CLAUSE_ENDS = String.raw`(?=\s*(?:[.!,;:)]|\byet\b|$))`;
const UNVERIFIED = new RegExp(
  String.raw`\b(?:unverified|untested|` +
    String.raw`not (?:yet )?(?:been )?(?:verified|tested|run)${OBJECT}${CLAUSE_ENDS}|` +
    String.raw`(?:haven['’]t|have not|hasn['’]t|has not|didn['’]t|did not|couldn['’]t|could not|` +
    String.raw`unable to|not able to|wasn['’]t able to|weren['’]t able to) ` +
    String.raw`(?:been )?(?:run|ran|verify|verified|test|tested)${OBJECT}${CLAUSE_ENDS}|` +
    String.raw`without (?:running|testing|verifying)\b` +
    String.raw`(?!\s+(?:on|in|into|out|over|with|against|for|under)\b))`,
  "im",
);

/**
 * The sentence of `text` that claims the work is complete, or "". A claim word that is negated
 * ("nothing is committed") or only quoted (`done`, "fixed") is not a claim.
 *
 * @param {string} text
 */
export function completionClaim(text) {
  // A fenced block is code or output (a loop ending in `done`), and a quote is someone's words.
  const scan = text
    .replace(/```[\s\S]*?(?:```|$)/g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/`[^`\n]*`|"[^"\n]*"|“[^”\n]*”/g, (m) => " ".repeat(m.length));
  for (const match of scan.matchAll(CLAIM)) {
    const start =
      Math.max(
        scan.lastIndexOf(".", match.index),
        scan.lastIndexOf("\n", match.index),
        scan.lastIndexOf("?", match.index),
      ) + 1;
    const ends = [
      scan.indexOf(".", match.index),
      scan.indexOf("\n", match.index),
      scan.indexOf("?", match.index),
    ].filter((i) => i >= 0);
    const end = ends.length ? Math.min(...ends) + 1 : scan.length;
    const before = scan.slice(start, match.index);
    const after = scan.slice(match.index + match[0].length, end);
    if (
      IN_A_NAME_BEFORE.test(scan.slice(0, match.index)) ||
      IN_A_NAME_AFTER.test(scan.slice(match.index + match[0].length))
    )
      continue;
    if (/^complete$/i.test(match[0]) && ARTICLE_BEFORE.test(before)) continue;
    if (NEGATION_BEFORE.test(before) || NOT_YET_BEFORE.test(before) || NEGATION_AFTER.test(after))
      continue;
    if (scan[end - 1] === "?") continue; // a question claims nothing
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
 * @typedef {{ kind: "edit", what: string }} EditMoment `what` reads "app.py was edited"
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
      if (isCodeFile(file)) moments.push(edited(basename(file) || file));
    } else if (use.name === "NotebookEdit") {
      moments.push(edited(basename(String(use.input?.notebook_path ?? "a notebook"))));
    } else if (use.name === "Bash" && typeof use.input?.command === "string") {
      const text = use.input.command;
      const { events, hasError } = await listCommands(text);
      const commands = events.filter((e) => e.kind === "command");
      for (const event of commands) {
        for (const what of shellWrites(event)) moments.push({ kind: "edit", what });
        const edit = inPlaceEdit(event.argv);
        if (edit) moments.push(edited(edit));
        const inner = isTestCommand(event.argv, extra)
          ? false
          : await testInShell(event.argv, extra);
        if (inner === false && !isTestCommand(event.argv, extra)) continue;
        const hidden = hides(event, commands) || inner === "hidden";
        moments.push({ kind: "gate", useId: use.id, command: firstLine(text), hidden });
      }
      if (hasError) moments.push({ kind: "unread", command: firstLine(text) });
    }
  }
  return moments;
}

/**
 * Is `event`'s exit status hidden from the Bash call's? It is when a command after it still runs
 * after it fails and so sets the status instead: anything after `;`, `||` or `&`, and a later
 * stage of its own pipeline unless `set -o pipefail` is on. A command it guards with `&&` does not
 * run when it fails, and one inside its own arguments (`pytest $(cat list)`) ran before it.
 *
 * @param {import("./shell.mjs").Command} event
 * @param {import("./shell.mjs").Command[]} commands
 */
function hides(event, commands, shellPipefail = false) {
  const pipefail =
    shellPipefail ||
    commands.some(
      (e) =>
        e.start < event.start && basename(e.argv[0] ?? "") === "set" && e.argv.includes("pipefail"),
    );
  return commands.some(
    (later) =>
      later.start >= event.end &&
      !guards(event.chain, later.chain) &&
      !(pipefail && fedBy(later, event)),
  );
}

/** Is `later` a later stage of `event`'s own pipeline? */
function fedBy(later, event) {
  for (let c = later.feederCommand, n = 0; c && n < 64; c = c.feederCommand, n += 1)
    if (c === event) return true;
  return false;
}

/**
 * A test run inside a shell this command starts (`bash -c 'pytest -q'`, `docker exec app sh -c
 * 'npm test'`): "shown" when its status reaches this command, "hidden" when something after it in
 * the script hides it, false when there is none.
 *
 * @param {string[]} argv
 * @param {string[]} extra
 * @returns {Promise<"shown" | "hidden" | false>}
 */
async function testInShell(argv, extra, depth = 0) {
  if (depth > 4) return false;
  const words = peelRunners(peel(argv)?.argv ?? argv);
  if (!SHELLS.has(basename(words[0] ?? ""))) return false;
  const c = words.findIndex((w, i) => i > 0 && /^-[a-zA-Z]*c[a-zA-Z]*$/.test(w));
  const script = c > 0 ? words[c + 1] : undefined;
  if (script === undefined) return false;
  // `bash -o pipefail -c` and `bash -euo pipefail -c`: the option is on before the script runs.
  const pipefail = words
    .slice(1, c)
    .some((w, j, before) => /^-[a-zA-Z]*o$/.test(w) && before[j + 1] === "pipefail");
  const { events } = await listCommands(script);
  const inner = events.filter((e) => e.kind === "command");
  let found = false;
  for (const e of inner) {
    const nested = isTestCommand(e.argv, extra)
      ? "shown"
      : await testInShell(e.argv, extra, depth + 1);
    if (!nested) continue;
    if (nested === "hidden" || hides(e, inner, pipefail)) return "hidden";
    found = true;
  }
  return found ? "shown" : false;
}

const PROSE = new Set([
  ".md", ".markdown", ".mdx", ".rst", ".txt", ".adoc", ".org", ".csv", ".tsv", ".log",
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".svg", ".pdf",
]); // prettier-ignore

// Repository furniture: nothing runs it, and no test could check it. A Dockerfile, an
// .env.example and JSON are not on this list: an edit to them changes what builds and runs.
const FURNITURE = new RegExp(
  String.raw`^(?:\.gitignore|\.gitattributes|\.editorconfig|\.mailmap|CODEOWNERS|` +
    String.raw`(?:LICEN[CS]E|COPYING|NOTICE|AUTHORS|CONTRIBUTORS)(?:\.\w+)?)$`,
  "i",
);

// Text files that a build reads: a dependency list or a build script with a .txt name.
const BUILD_TEXT = /^(?:requirements[\w.-]*|constraints[\w.-]*|CMakeLists)\.txt$/i;

/** Code is all that is not prose, an image or furniture, extensionless files (Makefile) too. */
function isCodeFile(path) {
  if (path === "") return false;
  if (BUILD_TEXT.test(basename(path))) return true;
  return !PROSE.has(extname(path).toLowerCase()) && !FURNITURE.test(basename(path));
}

// Source files, by extension. A shell write counts as an edit only into one of these:
// `npm test | tee test-output` and `pytest > report.json` write outputs, and counting those
// would refuse a stop right after a passing run.
const SOURCE = new Set([
  ".py", ".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".mts", ".cts", ".rs", ".go", ".java", ".kt",
  ".kts", ".scala", ".rb", ".php", ".c", ".h", ".cc", ".cpp", ".hpp", ".cs", ".swift", ".m", ".sh",
  ".bash", ".zsh", ".ps1", ".lua", ".pl", ".ex", ".exs", ".erl", ".hs", ".ml", ".dart", ".vue",
  ".svelte", ".zig", ".jl",
]); // prettier-ignore
// Flags of git apply / git am / patch that change nothing: a dry run, or `am` ending a session.
const PATCH_DRY_RUN = new Set([
  "--check", "--stat", "--numstat", "--summary", "--dry-run",
  "--abort", "--skip", "--continue", "--quit", "--show-current-patch",
]); // prettier-ignore

// A dotenv file (`.env`, `.env.local`) changes what runs, as an Edit of one already counts.
const DOTENV = /^\.env(?:\..+)?$/;
// cp, mv and install write their destination; these options take the next word as their value.
const COPIERS = new Map([
  ["cp", new Set(["-t", "-S", "--target-directory", "--suffix"])],
  ["mv", new Set(["-t", "-S", "--target-directory", "--suffix"])],
  ["install", new Set([
    "-t", "-S", "-m", "-o", "-g", "--target-directory", "--suffix", "--mode", "--owner", "--group",
  ])],
]); // prettier-ignore

/**
 * What a `cp`, `mv` or `install` writes: each source's name inside `-t DIR`, else the destination.
 * A destination with no extension may be a directory the text cannot show (`cp new.py src`,
 * `cp new.py src/`), so the sources' names inside it are counted too.
 *
 * @param {string} tool
 * @param {string[]} argv
 * @returns {string[]}
 */
function copiedOnto(tool, argv) {
  const valued = COPIERS.get(tool);
  if (!valued) return [];
  const operands = [];
  let dir = null;
  let literal = false;
  for (let i = 1; i < argv.length; i += 1) {
    const word = argv[i];
    if (!literal && word === "--") literal = true;
    else if (!literal && word.startsWith("-") && word !== "-") {
      const eq = word.startsWith("--") ? word.indexOf("=") : -1;
      const option = eq > 0 ? word.slice(0, eq) : word;
      const value = eq > 0 ? word.slice(eq + 1) : valued.has(option) ? argv[i + 1] : undefined;
      if ((option === "-t" || option === "--target-directory") && value !== undefined) dir = value;
      if (eq < 0 && valued.has(option)) i += 1;
    } else operands.push(word);
  }
  if (dir !== null) return operands.map((source) => join(dir, basename(source)));
  if (operands.length < 2) return [];
  const dest = operands.at(-1);
  const into = operands.slice(0, -1).map((source) => join(dest, basename(source)));
  return extname(dest) === "" ? [dest, ...into] : [dest];
}

/** @param {string} file */
function edited(file) {
  return { kind: /** @type {const} */ ("edit"), what: `${file} was edited` };
}

/**
 * What a shell command changed in source: "app.py was edited" for `cat > app.py <<EOF` and
 * `tee lib/a.ts`, and "a patch was applied" for `git apply`, `git am` and `patch`, whose files
 * are named inside the patch.
 *
 * @param {import("./shell.mjs").Command} event
 * @returns {string[]}
 */
function shellWrites(event) {
  const tool = basename(event.argv[0] ?? "");
  const targets = [...event.writes];
  if (tool === "tee")
    for (const item of event.argv.slice(1).filter((a) => !a.startsWith("-"))) targets.push(item);
  for (const item of copiedOnto(tool, event.argv)) targets.push(item);
  const written = targets
    .filter((t) => SOURCE.has(extname(t).toLowerCase()) || DOTENV.test(basename(t)))
    .map((t) => `${basename(t)} was edited`);
  const dry = event.argv.some((a) => PATCH_DRY_RUN.has(a));
  const sub =
    tool === "git"
      ? event.argv
          .slice(1)
          .find((a, i, rest) => !a.startsWith("-") && rest[i - 1] !== "-C" && rest[i - 1] !== "-c")
      : "";
  if (!dry && (tool === "patch" || sub === "apply" || sub === "am")) {
    written.push(`a patch was applied with \`${tool === "git" ? `git ${sub}` : "patch"}\``);
  }
  return written;
}

/**
 * `sed -i` / `perl -i` editing something other than prose: the first code file it edits, or "".
 * The script is not a file: sed's first operand is its script unless `-e`/`-f` gave one, and
 * perl's comes with `-e`. `s/1.0/2.0/` has an "extension", and was once read as a code file.
 */
function inPlaceEdit(argv) {
  const tool = basename(argv[0] ?? "");
  const files =
    tool === "sed" || tool === "gsed" ? sedFiles(argv) : tool === "perl" ? perlFiles(argv) : null;
  if (files === null) return "";
  if (files.length > 0 && files.every((f) => !isCodeFile(f))) return "";
  const code = files.find(isCodeFile);
  return code ? basename(code) : `a file (\`${tool} -i\`)`;
}

/** The files `sed -i` edits, or null when it is not editing in place. */
function sedFiles(argv) {
  let inPlace = false;
  let script = false;
  const operands = [];
  for (let i = 1; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--") {
      for (const item of argv.slice(i + 1)) operands.push(item);
      break;
    }
    if (a.startsWith("--")) {
      if (a.startsWith("--in-place")) inPlace = true;
      if (a === "--expression" || a === "--file") ((script = true), (i += 1));
      else if (a.startsWith("--expression=") || a.startsWith("--file=")) script = true;
      else if (a === "--line-length") i += 1;
      continue;
    }
    if (a.startsWith("-") && a.length > 1) {
      // A cluster: `-i`, `-i.bak` (the rest is the suffix), `-ne`, `-e` taking the next word.
      for (let j = 1; j < a.length; j += 1) {
        const letter = a[j];
        if (letter === "i") {
          inPlace = true;
          break; // anything after it is the backup suffix
        }
        if (letter === "e" || letter === "f") {
          script = true;
          if (j === a.length - 1) i += 1;
          break;
        }
        if (letter === "l") {
          if (j === a.length - 1) i += 1;
          break;
        }
      }
      continue;
    }
    operands.push(a);
  }
  if (!inPlace) return null;
  return script ? operands : operands.slice(1);
}

/** The files `perl -i` edits, or null when it is not editing in place. */
function perlFiles(argv) {
  let inPlace = false;
  let script = false;
  const operands = [];
  for (let i = 1; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--") {
      for (const item of argv.slice(i + 1)) operands.push(item);
      break;
    }
    if (a.startsWith("-") && a.length > 1) {
      // Perl's switches are single letters; -M, -m, -I, -x, -d, -D, -l, -0, -C take the rest of
      // the word, and -e/-E take the next word when nothing follows them.
      for (let j = 1; j < a.length; j += 1) {
        const letter = a[j];
        if (letter === "i") {
          inPlace = true;
          break;
        }
        if (letter === "e" || letter === "E") {
          script = true;
          if (j === a.length - 1) i += 1;
          break;
        }
        if ("MmIxdDl0C".includes(letter)) break;
      }
      continue;
    }
    operands.push(a);
  }
  if (!inPlace) return null;
  return script ? operands : operands.slice(1);
}

// ─── Recognising a test run ─────────────────────────────────────────────────────────────

// Words that run the word after them, and the options of theirs that take a value.
// Test-specific runners. The shell's own wrappers (env, sudo, nice, time, timeout, …) are peeled
// first by ../commands.mjs, the table all three hooks share.
const RUNNERS = new Map(
  [
    ["npx", ["-p", "--package"]], ["bunx", []],
    ["xvfb-run", ["-s", "-n", "-f"]], ["dotenv", ["-e"]],
  ].map(([name, valued]) => [name, new Set(valued)]),
); // prettier-ignore
const RUNNER_PAIRS = new Set([
  "uv run", "poetry run", "pdm run", "hatch run", "pipenv run", "rye run", "pixi run",
  "bundle exec", "pnpm exec", "pnpm dlx", "yarn dlx", "npm exec", "mise exec", "devbox run",
  "deno task",
]); // prettier-ignore
// Pairs that run a project task by name, so `pixi run test` is the project's test task.
const TASK_PAIRS = new Set([
  "pdm run",
  "hatch run",
  "pixi run",
  "deno task",
  "mise run",
  "rye run",
]);
// Flags that make a test runner print, list or build and run no test: a run that tests nothing.
const VOIDS = new Map([
  ["pytest", /^(?:--collect-only|--co|--help|-h|--version|-V|--fixtures|--markers|--setup-plan)$/],
  ["jest", /^(?:--listTests|--showConfig|--help|--version)$/],
  ["vitest", /^(?:list|--help|-h|--version|-v)$/],
  ["cargo", /^(?:--no-run|--help|-h|--list)$/],
  ["go", /^(?:-list|-run=^$|-h|-help)$/],
  ["mvn", /^(?:-DskipTests(?:=true)?|-Dmaven\.test\.skip(?:=true)?|--help|-h|--version|-v)$/],
  ["mvnw", /^(?:-DskipTests(?:=true)?|-Dmaven\.test\.skip(?:=true)?|--help|-h|--version|-v)$/],
  ["make", /^(?:-n|--dry-run|--just-print|--recon)$/],
  ["npm", /^(?:--help|-h)$/],
]);
// Container runners: skip their options, then the service, container or image, and the
// command after that is what runs.
const CONTAINER_RUNS = new Map(
  [
    [
      "docker compose run",
      [
        "-e",
        "-w",
        "-u",
        "-v",
        "--env",
        "--workdir",
        "--user",
        "--volume",
        "--name",
        "--entrypoint",
      ],
    ],
    ["docker compose exec", ["-e", "-w", "-u", "--env", "--workdir", "--user", "--index"]],
    [
      "docker-compose run",
      [
        "-e",
        "-w",
        "-u",
        "-v",
        "--env",
        "--workdir",
        "--user",
        "--volume",
        "--name",
        "--entrypoint",
      ],
    ],
    ["docker-compose exec", ["-e", "-w", "-u", "--env", "--workdir", "--user", "--index"]],
    ["docker exec", ["-e", "-w", "-u", "--env", "--workdir", "--user"]],
    [
      "docker run",
      [
        "-e",
        "-w",
        "-u",
        "-v",
        "-p",
        "--env",
        "--workdir",
        "--user",
        "--volume",
        "--name",
        "--network",
        "--entrypoint",
      ],
    ],
  ].map(([words, valued]) => [words, new Set(valued)]),
);

const TEST_SCRIPT = /^(?:test|tests|check|verify|ci|gate)(?::[\w:.-]*)?$/;
const SINGLE = new Set([
  "pytest", "py.test", "tox", "nox", "vitest", "jest", "mocha", "ava", "tap", "rspec", "phpunit",
  "pest", "ctest", "bats", "busted", "karma", "jasmine", "nextest",
]); // prettier-ignore
// One subcommand decides: `cargo test`, `go test`. Valued options are skipped to find it.
const SUBCOMMAND = new Map(
  [
    [
      "cargo",
      [
        /^(?:test|nextest)$/,
        ["-p", "--package", "--manifest-path", "-j", "--jobs", "--target", "-Z"],
      ],
    ],
    ["go", [/^test$/, []]],
    ["deno", [/^test$/, []]],
    ["bun", [/^test$/, []]],
    ["dotnet", [/^test$/, []]],
    ["swift", [/^test$/, []]],
    ["mix", [/^test$/, []]],
    ["flutter", [/^test$/, []]],
    ["dart", [/^test$/, []]],
    ["rails", [/^test$/, []]],
    ["hatch", [/^test$/, []]],
    ["playwright", [/^test$/, []]],
    ["cypress", [/^run$/, []]],
    ["bazel", [/^(?:test|coverage)$/, []]],
    ["bazelisk", [/^(?:test|coverage)$/, []]],
    ["stack", [/^test$/, []]],
    ["cabal", [/^test$/, []]],
    ["meson", [/^test$/, ["-C"]]],
    ["composer", [/^test$/, ["-d", "--working-dir"]]],
    ["xcodebuild", [/^test$/, ["-scheme", "-project", "-workspace", "-destination"]]],
    // prettier-ignore
  ].map(([tool, [pattern, valued]]) => [tool, { pattern, valued: new Set(valued) }]),
);
// Any of several goals decides: `mvn clean test`, `make -j 4 check`.
const GOALS = new Map(
  [
    [
      "make",
      [
        /^(?:test|tests|check|verify|ci|gate)$/,
        ["-j", "-C", "-f", "-l", "--jobs", "--directory", "--file"],
      ],
    ],
    ["just", [TEST_SCRIPT, ["-f", "-d", "--justfile", "--working-directory"]]],
    ["task", [TEST_SCRIPT, ["-d", "-t", "--dir", "--taskfile"]]],
    ["rake", [/^(?:test|spec)(?::\S*)?$/, ["-f", "-C"]]],
    ["sbt", [/^(?:test|testOnly|testQuick)(?:\s.*)?$/, []]], // `sbt "testOnly x.Y"` is one word
    [
      "mvn",
      [/^(?:test|verify|install)$/, ["-P", "-pl", "-f", "-D", "-T", "-s", "--projects", "--file"]],
    ],
    [
      "mvnw",
      [/^(?:test|verify|install)$/, ["-P", "-pl", "-f", "-D", "-T", "-s", "--projects", "--file"]],
    ],
    ["gradle", [/^(?:test|check|build)$|:test$/, ["-p", "-x", "--project-dir", "--exclude-task"]]],
    ["gradlew", [/^(?:test|check|build)$|:test$/, ["-p", "-x", "--project-dir", "--exclude-task"]]],
    // prettier-ignore
  ].map(([tool, [pattern, valued]]) => [tool, { pattern, valued: new Set(valued) }]),
);
// Package managers: the first operand is a script name or `run <script>`.
const PACKAGE_VALUED = new Set([
  "--filter",
  "-F",
  "--prefix",
  "-C",
  "--dir",
  "--cwd",
  "-w",
  "--workspace",
]);

/**
 * Does this simple command run a project's tests?
 *
 * @param {string[]} argv
 * @param {string[]} [extra] user-supplied command prefixes
 */
export function isTestCommand(argv, extra = []) {
  const shell = peel(argv)?.argv ?? argv;
  const words = peelRunners(shell);
  if (words.length === 0) return false;
  const joined = words.join(" ");
  if (extra.some((prefix) => joined === prefix || joined.startsWith(`${prefix} `))) return true;
  const tool = basename(words[0]);
  const rest = words.slice(1);
  const voids = VOIDS.get(tool === "py.test" ? "pytest" : tool);
  if (voids && rest.some((w) => voids.test(w))) return false;
  // `gradle build -x test`: the test task excluded by name.
  if (
    (tool === "gradle" || tool === "gradlew") &&
    rest.some(
      (w, i) => (w === "-x" || w === "--exclude-task") && /(?:^|:)test$/.test(rest[i + 1] ?? ""),
    )
  ) {
    return false;
  }
  // `pixi run test`, `deno task test`: a task pair followed by the project's test task.
  if (
    TASK_PAIRS.has(`${basename(shell[0] ?? "")} ${shell[1] ?? ""}`) &&
    TEST_SCRIPT.test(words[0] ?? "")
  )
    return true;

  if (SINGLE.has(tool)) return true;
  if (/^python(?:\d(?:\.\d+)?)?$|^py$/.test(tool)) {
    const m = rest.indexOf("-m");
    if (m >= 0) return /^(?:pytest|unittest|tox|nox)$/.test(rest[m + 1] ?? "");
    const [script, sub] = operands(rest, new Set(["-W", "-X"]));
    return /(?:^|\/)manage\.py$/.test(script ?? "") && sub === "test"; // Django
  }
  // `node --test` is node's own flag, before the script; `node app.js --test` hands it to app.js.
  if (tool === "node") {
    const script = rest.findIndex((w) => !w.startsWith("-"));
    return rest.slice(0, script < 0 ? rest.length : script).includes("--test");
  }
  if (tool === "zig") return rest[0] === "build" && rest[1] === "test";
  if (tool === "npm" || tool === "pnpm" || tool === "yarn" || tool === "bun") {
    const [first, second] = operands(rest, PACKAGE_VALUED);
    if (/^(?:test|t|tst)$/.test(first ?? "")) return true;
    if (first === "run" || first === "run-script") return TEST_SCRIPT.test(second ?? "");
    // `pnpm test:unit`, `yarn check`, and `pnpm vitest run`: pnpm, yarn and bun run a package's
    // own binary by name. npm does not.
    return tool !== "npm" && (TEST_SCRIPT.test(first ?? "") || SINGLE.has(first ?? ""));
  }
  const goals = GOALS.get(tool);
  if (goals) return operands(rest, goals.valued).some((w) => goals.pattern.test(w));
  const sub = SUBCOMMAND.get(tool);
  if (sub) {
    const [first] = operands(
      rest.filter((w) => !w.startsWith("+")),
      sub.valued,
    ); // `cargo +nightly test`
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
    const container = CONTAINER_RUNS.get(triple)
      ? [triple, 3]
      : CONTAINER_RUNS.get(pair)
        ? [pair, 2]
        : null;
    if (container) {
      const valued = CONTAINER_RUNS.get(container[0]);
      let i = container[1];
      while (i < words.length && words[i].startsWith("-")) i += valued.has(words[i]) ? 2 : 1;
      words = words.slice(i + 1); // past the service, container or image
    } else if (RUNNER_PAIRS.has(pair)) {
      words = skipOptions(words.slice(2), new Set());
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
  // pytest, mocha, jest
  /^[\s=|]*(?:Tests?:?\s+)?[1-9]\d* (?:failed|failing|errors?)\b(?!\s+to\b)/m,
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
  if (line)
    return { failed: true, why: `its output says “${line}”, and the command hid the exit status` };
  if (result.isError) {
    return {
      failed: false,
      why:
        `ended with ${exited} from a command after the tests, ` +
        "which hides the test run's own status",
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
