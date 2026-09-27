// Every simple command inside a shell string, found by a real bash grammar.
//
// A guard that inspects Bash commands has to answer one question before any other: where are
// the commands? Splitting on `;`, `&&` and `|` answers it wrongly in both directions. It cuts a
// quoted commit message into "commands" that were only ever prose, and it walks straight past a
// command inside `( … )`, `if … then`, `$( … )` or a heredoc fed to a shell. Every fix to a
// splitter adds one more spelling it knows about, and there is always another.
//
// tree-sitter's bash grammar has no spellings to miss. A `command` node IS a command position,
// a quoted string IS one argument whatever it contains, and a span it cannot parse becomes an
// ERROR node that `hasError` reports, so a caller can treat exactly that part as unreadable.
//
// This module interprets nothing. It lists what would run and where. What a command MEANS is
// the caller's business.

import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Language, Parser } from "web-tree-sitter";

/**
 * @typedef {object} Command one simple command, as the shell would see it after quote removal
 * @property {"command"} kind
 * @property {string[]} argv words with quoting removed; `$X`, `${X}`, `$(…)` kept as written
 * @property {Array<[string, string]>} prefix `NAME=value` words written before the command name
 * @property {number[]} scope ids of the enclosing subshells and substitutions, outermost first
 * @property {number} pipeIndex position in its pipeline, 0 when it is not piped
 * @property {string[] | null} feeder argv of the simple command piped into this one, if any
 * @property {boolean} stdinRedirected stdin comes from `<`, `<<<` or a heredoc
 * @property {string | null} stdinFile the file named by `< file`, unquoted
 * @property {string | null} heredoc the body of a heredoc on this command
 *
 * @typedef {object} Assignment a bare `NAME=value` statement, in order with the commands
 * @property {"assignment"} kind
 * @property {string} name
 * @property {string} value
 * @property {number[]} scope
 *
 * @typedef {{ events: Array<Command | Assignment>, hasError: boolean }} Listing
 */

const require = createRequire(import.meta.url);

/** @type {Promise<Parser> | null} */
let parserPromise = null;

/** The bash parser, loaded once per process. */
export function loadParser() {
  parserPromise ??= (async () => {
    await Parser.init();
    const bash = await Language.load(require.resolve("tree-sitter-bash/tree-sitter-bash.wasm"));
    const parser = new Parser();
    parser.setLanguage(bash);
    return parser;
  })();
  return parserPromise;
}

/**
 * Every simple command and bare assignment in `text`, in source order.
 *
 * @param {string} text
 * @returns {Promise<Listing>}
 */
export async function listCommands(text) {
  const parser = await loadParser();
  const tree = parser.parse(text);
  if (!tree) throw new Error("the bash parser returned no tree");
  try {
    const events = [];
    walk(tree.rootNode, [], events, []);
    return { events, hasError: tree.rootNode.hasError };
  } finally {
    tree.delete();
  }
}

// Node types whose text is one argument of a command.
const ARGUMENT_TYPES = new Set([
  "word",
  "number",
  "string",
  "raw_string",
  "ansi_c_string",
  "translated_string",
  "concatenation",
  "simple_expansion",
  "expansion",
  "command_substitution",
  "process_substitution",
  "arithmetic_expansion",
  "brace_expression",
]);

const REDIRECT_TYPES = new Set(["file_redirect", "heredoc_redirect", "herestring_redirect"]);
const SCOPE_TYPES = new Set(["subshell", "command_substitution", "process_substitution"]);

/**
 * @param {import("web-tree-sitter").Node} node
 * @param {number[]} scope
 * @param {Array<Command | Assignment>} out
 * @param {import("web-tree-sitter").Node[]} redirects redirections that apply to every command below
 */
function walk(node, scope, out, redirects) {
  switch (node.type) {
    case "command":
      out.push(command(node, scope, 0, null, redirects));
      descendIntoArguments(node, scope, out);
      return;

    case "pipeline":
      walkPipeline(node, scope, out, [], redirects);
      return;

    case "redirected_statement": {
      const own = node.namedChildren.filter((c) => c && REDIRECT_TYPES.has(c.type));
      for (const child of node.namedChildren) {
        if (!child || REDIRECT_TYPES.has(child.type)) continue;
        // `a | b <<EOF` parses as a redirect on the whole pipeline, but bash gives it to `b`.
        if (child.type === "pipeline") walkPipeline(child, scope, out, own, redirects);
        else walk(child, scope, out, [...redirects, ...own]);
      }
      return;
    }

    case "variable_assignment": {
      const [name, value] = assignment(node);
      out.push({ kind: "assignment", name, value, scope });
      descendIntoArguments(node, scope, out);
      return;
    }

    default: {
      const inner = SCOPE_TYPES.has(node.type) ? [...scope, node.id] : scope;
      for (const child of node.namedChildren) if (child) walk(child, inner, out, redirects);
    }
  }
}

/**
 * The stages of a pipeline, each told what feeds it. `lastStage` redirections belong to the
 * final stage only; `enclosing` ones (from a compound around the pipeline) belong to all.
 */
function walkPipeline(node, scope, out, lastStage, enclosing) {
  const stages = node.namedChildren.filter(Boolean);
  let feeder = null;
  stages.forEach((stage, index) => {
    const isLast = index === stages.length - 1;
    const redirects = isLast ? [...enclosing, ...lastStage] : enclosing;
    let inner = stage;
    let own = [];
    if (stage.type === "redirected_statement") {
      own = stage.namedChildren.filter((c) => c && REDIRECT_TYPES.has(c.type));
      inner = stage.namedChildren.find((c) => c && !REDIRECT_TYPES.has(c.type)) ?? stage;
    }
    if (inner.type === "command") {
      const cmd = command(inner, scope, index, feeder, [...redirects, ...own]);
      out.push(cmd);
      descendIntoArguments(inner, scope, out);
      feeder = cmd.argv;
    } else {
      walk(stage, scope, out, redirects);
      feeder = null; // a compound stage's output is not one command's output
    }
  });
}

/** A `$( … )` inside an argument runs too; list the commands nested in it. */
function descendIntoArguments(node, scope, out) {
  for (const child of node.namedChildren) {
    if (!child) continue;
    if (child.type === "command_substitution" || child.type === "process_substitution") {
      walk(child, scope, out, []);
    } else if (child.type !== "command_name") {
      descendIntoArguments(child, scope, out);
    }
  }
}

/** @returns {Command} */
function command(node, scope, pipeIndex, feeder, redirects) {
  const argv = [];
  const prefix = [];
  const all = [...redirects];
  for (const child of node.namedChildren) {
    if (!child) continue;
    if (child.type === "variable_assignment") prefix.push(assignment(child));
    else if (child.type === "command_name") argv.push(child.namedChildren.map(unquote).join(""));
    else if (ARGUMENT_TYPES.has(child.type)) argv.push(unquote(child));
    else if (REDIRECT_TYPES.has(child.type)) all.push(child);
  }
  let stdinRedirected = false;
  let stdinFile = null;
  let heredoc = null;
  for (const redirect of all) {
    if (redirect.type === "heredoc_redirect" || redirect.type === "herestring_redirect") {
      stdinRedirected = true;
      const body = redirect.namedChildren.find((c) => c?.type === "heredoc_body");
      if (body) heredoc = body.text;
      continue;
    }
    const operator = redirect.children.find((c) => c && !c.isNamed)?.text ?? "";
    const descriptor = redirect.namedChildren.find((c) => c?.type === "file_descriptor")?.text;
    if (operator === "<" && (descriptor === undefined || descriptor === "0")) {
      stdinRedirected = true;
      const target = redirect.namedChildren.find((c) => c && ARGUMENT_TYPES.has(c.type));
      stdinFile = target ? unquote(target) : null;
    }
  }
  return { kind: "command", argv, prefix, scope, pipeIndex, feeder, stdinRedirected, stdinFile, heredoc };
}

/** @returns {[string, string]} */
function assignment(node) {
  let name = "";
  let value = "";
  for (const child of node.namedChildren) {
    if (!child) continue;
    if (child.type === "variable_name" && !name) name = child.text;
    else if (ARGUMENT_TYPES.has(child.type)) value = unquote(child);
  }
  return [name, value];
}

/**
 * An argument as the shell passes it, minus what only the shell can compute: quotes and
 * backslash escapes are removed, expansions and substitutions are left exactly as written.
 *
 * @param {import("web-tree-sitter").Node} node
 * @returns {string}
 */
export function unquote(node) {
  const raw = node.text;
  switch (node.type) {
    case "raw_string":
      return raw.slice(1, -1);
    case "string":
    case "translated_string": {
      const body = node.type === "translated_string" ? raw.slice(2, -1) : raw.slice(1, -1);
      return body.replace(/\\([$`"\\\n])/g, (_, c) => (c === "\n" ? "" : c));
    }
    case "ansi_c_string":
      return decodeAnsiC(raw.slice(2, -1));
    case "concatenation":
      return node.children.map((c) => (c ? unquote(c) : "")).join("");
    case "word":
      return raw.replace(/\\\n/g, "").replace(/\\(.)/gs, "$1");
    default:
      return raw;
  }
}

const SIMPLE_ESCAPES = {
  a: "\x07", b: "\b", e: "\x1b", E: "\x1b", f: "\f", n: "\n", r: "\r", t: "\t", v: "\v",
  "\\": "\\", "'": "'", '"': '"', "?": "?",
}; // prettier-ignore

/** `$'…'` as bash decodes it, so `$'\x72m'` is the two letters r and m. */
function decodeAnsiC(body) {
  return body.replace(
    /\\(x[0-9a-fA-F]{1,2}|u[0-9a-fA-F]{1,4}|U[0-9a-fA-F]{1,8}|[0-7]{1,3}|c.|.)/gs,
    (whole, esc) => {
      const head = esc[0];
      if (head === "x" || head === "u" || head === "U") {
        return String.fromCodePoint(Number.parseInt(esc.slice(1), 16));
      }
      if (/[0-7]/.test(head)) return String.fromCharCode(Number.parseInt(esc, 8) & 0xff);
      if (head === "c") return String.fromCharCode(esc.charCodeAt(1) & 0x1f);
      return SIMPLE_ESCAPES[head] ?? whole;
    },
  );
}

/**
 * A word with what CAN be known substituted in, and whether anything still cannot.
 *
 * Knows `~`, `$NAME` / `${NAME}` from `vars` then the environment, `$PWD`, `$(pwd)`, and a
 * bare `$(mktemp …)`, which always names something fresh under the temp directory.
 * Anything else that expands at run time leaves `unknown` true: a caller must not treat a word
 * it cannot read as a word that names nothing.
 *
 * @param {string} word
 * @param {{ cwd: string, vars?: Map<string, string>, env?: NodeJS.ProcessEnv, home?: string }} context
 * @returns {{ text: string, unknown: boolean }}
 */
export function resolveWord(word, { cwd, vars = new Map(), env = process.env, home = env.HOME ?? "" }) {
  let text = word;
  if (home && (text === "~" || text.startsWith("~/"))) text = home + text.slice(1);
  const fresh = join(env.TMPDIR || tmpdir(), "mktemp-not-yet-created");
  // Three rounds reach through `A=$B/x; B=$(mktemp -d)` chains without looping forever.
  for (let round = 0; round < 3; round += 1) {
    text = text
      .replace(/\$\{([A-Za-z_]\w*)\}|\$([A-Za-z_]\w*)/g, (whole, braced, bare) => {
        const name = braced ?? bare;
        if (name === "PWD") return cwd;
        return vars.get(name) ?? env[name] ?? whole;
      })
      .replace(/\$\(\s*pwd\s*\)|`\s*pwd\s*`/g, () => cwd)
      .replace(/\$\(\s*mktemp(?:\s+-[A-Za-z]+)*\s*\)/g, () => fresh);
  }
  // Still unknown: an expansion, a brace list or range (`{a,b}`, `{1..3}`), another user's home.
  const unknown = /[$`]/.test(text) || /\{[^{}]*(?:,|\.\.)[^{}]*\}/.test(text) || /^~[^/]/.test(text);
  return { text, unknown };
}
