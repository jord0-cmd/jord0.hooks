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
 * @property {WordShape[]} shapes how each argv word was quoted, index for index
 * @property {Array<[string, string]>} prefix `NAME=value` words written before the command name
 * @property {number[]} scope ids of the enclosing child shells (subshells, substitutions, pipeline
 *   stages, `&` jobs, function bodies), outermost first
 * @property {boolean} conditional reached only if something before it lets it run: the right side
 *   of `&&` / `||`, or the body of an `if`, a loop, a `case` or a function
 * @property {number | null} fn the id of the function whose body this is, or null
 * @property {ListLink[]} chain the `&&` / `||` lists it sits in, outermost first, up to the nearest
 *   compound statement (a command after `cd x &&` runs only if the cd succeeded)
 * @property {number} start where the command starts in the text (a UTF-16 offset)
 * @property {number} end where it ends
 * @property {number} pipeIndex position in its pipeline, 0 when it is not piped
 * @property {string[] | null} feeder argv of the simple command piped into this one, if any
 * @property {Command | null} feederCommand that command whole (its heredoc and its own feeder
 *   included), or the last command of a `< <( … )` that feeds this one
 * @property {boolean} stdinRedirected stdin comes from `<`, `<<<` or a heredoc
 * @property {string | null} stdinFile the file named by `< file`, unquoted
 * @property {string[]} writes files its output is redirected into (`>`, `>>`, `>|`, `&>`), unquoted
 * @property {string | null} heredoc the body of a heredoc on this command
 *
 * @typedef {object} Assignment a bare `NAME=value` statement, in order with the commands
 * @property {"assignment"} kind
 * @property {string} name
 * @property {string} value
 * @property {number[]} scope
 * @property {boolean} conditional
 * @property {number | null} fn
 *
 * @typedef {object} LoopVar the variable of a `for NAME in …` loop, which takes each value in turn
 * @property {"loopvar"} kind
 * @property {string} name
 * @property {string[] | null} values the words after `in`, quoting removed; null for `for NAME;`,
 *   which walks the positional parameters this guard cannot see
 * @property {WordShape[]} shapes
 * @property {number[]} scope
 * @property {boolean} conditional
 * @property {number | null} fn
 *
 * @typedef {object} FunctionDef `NAME() { … }`. Its body's events follow it in the listing,
 *   each carrying `fn: id`. Nothing in them runs where they are written, only where NAME is called.
 * @property {"function"} kind
 * @property {string} name
 * @property {number} id
 * @property {number[]} scope
 * @property {boolean} conditional
 * @property {number | null} fn
 *
 * @typedef {object} ListLink one `a && b` / `a || b` list around an event
 * @property {number} id the list node
 * @property {"L" | "R"} side which side of it the event is on
 * @property {boolean} and the operator is `&&`
 *
 * @typedef {object} WordShape what the shell will still do to a word after quote removal
 * @property {boolean} glob it holds an unquoted `*`, `?` or `[`, or an unquoted expansion whose
 *   value the shell then globs
 * @property {boolean} split it holds an unquoted expansion, whose value the shell splits on spaces
 * @property {boolean} brace it holds an unquoted brace list or range (`{a,b}`, `{1..3}`)
 * @property {boolean} quoted some part of it was quoted
 *
 * @typedef {{ events: Array<Command | Assignment | LoopVar | FunctionDef>, hasError: boolean }} Listing
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
  let source = text;
  for (let round = 0; ; round += 1) {
    const tree = parser.parse(source);
    if (!tree) throw new Error("the bash parser returned no tree");
    try {
      const spans = reservedWordSpans(tree.rootNode);
      if (spans.length > 0 && round < MAX_KEYWORD_ROUNDS) {
        source = blank(source, spans);
        continue;
      }
      const events = [];
      walk(tree.rootNode, { scope: [], conditional: false, fn: null, chain: [] }, events, []);
      return { events, hasError: unreadableCommand(tree.rootNode) || spans.length > 0 };
    } finally {
      tree.delete();
    }
  }
}

// `time` and `coproc` are reserved words to bash, which runs the pipeline or compound command
// after them. The grammar reads them as command names, and then `time { rm -rf wip; }` is a
// command called `time` with `{` for an argument. Blanking the reserved word (with spaces, so
// every other offset stays put) and parsing again gives the grammar the statement bash sees.
// `\time` is not the reserved word, it is the program /usr/bin/time, so it is left alone.
const MAX_KEYWORD_ROUNDS = 4; // `time time x`; past this the text is reported unreadable

/**
 * The spans to blank: each reserved word in command position, `time`'s own `-p` / `--`, and a
 * coproc's NAME (a name is only allowed before a compound command, so a word followed by one).
 *
 * @param {import("web-tree-sitter").Node} root
 * @returns {Array<[number, number]>}
 */
function reservedWordSpans(root) {
  const spans = [];
  for (const node of root.descendantsOfType("command")) {
    const [name, ...rest] = node?.namedChildren.filter(Boolean) ?? [];
    if (name?.type !== "command_name") continue;
    if (name.text === "time") {
      spans.push([name.startIndex, name.endIndex]);
      for (const word of rest) {
        if (word.text !== "-p" && word.text !== "--") break;
        spans.push([word.startIndex, word.endIndex]);
      }
    } else if (name.text === "coproc") {
      spans.push([name.startIndex, name.endIndex]);
      const [word, next] = rest;
      if (word?.type === "word" && /^[A-Za-z_]\w*$/.test(word.text) && (next?.text === "{" || next?.type === "subshell")) {
        spans.push([word.startIndex, word.endIndex]);
      }
    }
  }
  return spans;
}

/** `text` with each span replaced by spaces of the same length. */
function blank(text, spans) {
  let out = text;
  for (const [start, end] of spans) out = out.slice(0, start) + " ".repeat(end - start) + out.slice(end);
  return out;
}

/**
 * Whether the tree has an error or missing node that could hide a COMMAND, the question a
 * caller asks when it treats "unreadable" as "may destroy something". An error confined to
 * arithmetic does not count: no command runs inside `(( … ))` or `$(( … ))`.
 *
 * @param {import("web-tree-sitter").Node} root
 */
function unreadableCommand(root) {
  if (!root.hasError) return false;
  const stack = [root];
  while (stack.length > 0) {
    const node = stack.pop();
    if ((node.isError || node.isMissing) && !inArithmetic(node)) return true;
    for (const child of node.children) if (child) stack.push(child);
  }
  return false;
}

/**
 * Is this node's nearest command context an arithmetic evaluation? A `$( … )` runs commands
 * whatever encloses it, so the climb stops there and answers no. `[[ … ]]` shares expression
 * node types with `(( … ))` but runs a test, not arithmetic, so only `$(( … ))` and a compound
 * that opens with `((` count. `((rm -rf wip))` is invalid arithmetic, which tree-sitter flags,
 * but bash still runs no command there.
 *
 * @param {import("web-tree-sitter").Node} node
 */
function inArithmetic(node) {
  for (let a = node.parent; a; a = a.parent) {
    if (a.type === "command_substitution" || a.type === "process_substitution") return false;
    if (a.type === "arithmetic_expansion") return true;
    if (a.type === "compound_statement" && a.text.startsWith("((")) return true;
  }
  return false;
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
const WRITING = new Set([">", ">>", ">|", "&>", "&>>"]);
const SCOPE_TYPES = new Set(["subshell", "command_substitution", "process_substitution"]);

// Compound statements whose bodies run only if something lets them: every part of them except
// the parts named here, which run whenever the statement itself does.
const ALWAYS_RUN = {
  if_statement: new Set(["condition"]),
  while_statement: new Set(["condition"]),
  for_statement: new Set(["value"]),
  c_style_for_statement: new Set(["initializer"]),
  case_statement: new Set(["value"]),
};

/**
 * `where` is what every event under `node` inherits: its scope, whether it is reached only
 * conditionally, and the function whose body it is.
 *
 * @param {import("web-tree-sitter").Node} node
 * @param {{ scope: number[], conditional: boolean, fn: number | null }} where
 * @param {Array<Command | Assignment | LoopVar | FunctionDef>} out
 * @param {import("web-tree-sitter").Node[]} redirects redirections that apply to every command below
 */
function walk(node, where, out, redirects) {
  switch (node.type) {
    case "command":
      out.push(command(node, where, 0, null, redirects));
      descendIntoArguments(node, where, out);
      return;

    case "pipeline":
      walkPipeline(node, where, out, [], redirects);
      return;

    case "redirected_statement": {
      const own = node.namedChildren.filter((c) => c && REDIRECT_TYPES.has(c.type));
      // `cat <<EOF | bash`: the grammar hangs `| bash` inside the heredoc redirect, but bash pipes
      // the heredoc's command into it. Read it as the pipeline it is.
      const body = node.namedChildren.find((c) => c && !REDIRECT_TYPES.has(c.type));
      const rest = own.flatMap((r) => r.namedChildren).find((c) => c?.type === "pipeline");
      // `> $(…)`, `< <(…)` and an unquoted heredoc's `$(…)` run first, while bash sets up the
      // redirections. A quoted heredoc's body is literal, and the grammar gives it no children.
      for (const redirect of own) descendIntoArguments(redirect, where, out, rest);
      if (body?.type === "command" && rest) {
        walkStages([body, ...stagesOf(rest)], where, out, [], redirects, own);
        return;
      }
      for (const child of node.namedChildren) {
        if (!child || REDIRECT_TYPES.has(child.type)) continue;
        // `a | b <<EOF` parses as a redirect on the whole pipeline, but bash gives it to `b`.
        if (child.type === "pipeline") walkPipeline(child, where, out, own, redirects);
        else walk(child, where, out, [...redirects, ...own]);
      }
      return;
    }

    case "variable_assignment": {
      const [name, value] = assignment(node);
      out.push({ kind: "assignment", name, value, ...where });
      descendIntoArguments(node, where, out);
      return;
    }

    case "unset_command": {
      // `unset NAME` has a node of its own in the grammar, not a `command`; list it as one.
      const words = node.namedChildren.filter(Boolean);
      out.push({
        kind: "command", argv: ["unset", ...words.map(unquote)], shapes: [BARE, ...words.map(shapeOf)],
        prefix: [], ...where, start: node.startIndex, end: node.endIndex, pipeIndex: 0, feeder: null, feederCommand: null,
        stdinRedirected: false, stdinFile: null, writes: [], heredoc: null,
      }); // prettier-ignore
      return;
    }

    case "list": {
      // `a && b`, `a || b`: the right side runs only if the left side's status lets it.
      const [left, right] = node.namedChildren.filter(Boolean);
      const and = node.children.some((c) => c?.type === "&&");
      if (left) walk(left, { ...where, chain: [...where.chain, { id: node.id, side: "L", and }] }, out, redirects);
      if (right) walk(right, { ...where, conditional: true, chain: [...where.chain, { id: node.id, side: "R", and }] }, out, redirects);
      return;
    }

    case "function_definition": {
      const name = node.childForFieldName("name")?.text ?? "";
      out.push({ kind: "function", name, id: node.id, ...where });
      const body = node.childForFieldName("body");
      // A function body runs in the caller's shell, where the caller calls it. Its own scope keeps
      // its `cd` from reaching the lines after the definition, which run whether or not it is called.
      if (body) walk(body, { scope: [...where.scope, node.id], conditional: true, fn: node.id, chain: [] }, out, []);
      return;
    }

    case "for_statement": {
      const name = node.childForFieldName("variable")?.text ?? "";
      const valueNodes = node.childrenForFieldName("value").filter(Boolean);
      const words = node.children.some((c) => c?.type === "in") ? valueNodes : null;
      out.push({
        kind: "loopvar", name, ...where,
        values: words ? words.map(unquote) : null,
        shapes: words ? words.map(shapeOf) : [],
      }); // prettier-ignore
      for (const value of valueNodes) descendIntoArguments(value, where, out);
      const body = node.childForFieldName("body");
      if (body) walk(body, { ...where, conditional: true }, out, redirects);
      return;
    }

    default: {
      const scope = SCOPE_TYPES.has(node.type) ? [...where.scope, node.id] : where.scope;
      const always = ALWAYS_RUN[node.type];
      const kids = node.children;
      for (let i = 0; i < kids.length; i += 1) {
        const child = kids[i];
        if (!child || !child.isNamed) continue;
        const reached = always && !always.has(node.fieldNameForChild(i) ?? "") ? true : where.conditional;
        // `a & b`: a statement sent to the background runs in a child shell of its own.
        const background = kids[i + 1]?.type === "&";
        // A compound statement's own status is its last command's, not any one command's, so a
        // `&&` chain around it says nothing about the commands inside: the chain starts again.
        const inner = { ...where, scope: background ? [...scope, child.id] : scope, conditional: reached, chain: node.type === "program" ? where.chain : [] };
        walk(child, inner, out, redirects);
      }
    }
  }
}

/**
 * The stages of a pipeline, each told what feeds it. `lastStage` redirections belong to the
 * final stage only; `enclosing` ones (from a compound around the pipeline) belong to all. Bash
 * runs every stage of a real pipeline in a child shell, so each gets a scope of its own: a `cd`
 * in one stage moves nothing for the next command.
 */
function walkPipeline(node, where, out, lastStage, enclosing) {
  walkStages(node.namedChildren.filter(Boolean), where, out, lastStage, enclosing, []);
}

/** A pipeline's stages, a pipeline nested in one (the grammar's shape for `| b | c` after a heredoc) flattened. */
function stagesOf(node) {
  return node.namedChildren.filter(Boolean).flatMap((c) => (c.type === "pipeline" ? stagesOf(c) : [c]));
}

/** `firstStage` redirections belong to the first stage only (the heredoc of `cat <<EOF | bash`). */
function walkStages(stages, where, out, lastStage, enclosing, firstStage) {
  let feeder = null;
  stages.forEach((stage, index) => {
    const isLast = index === stages.length - 1;
    const redirects = [...enclosing, ...(isLast ? lastStage : []), ...(index === 0 ? firstStage : [])];
    const at = stages.length > 1 ? { ...where, scope: [...where.scope, stage.id] } : where;
    let inner = stage;
    let own = [];
    if (stage.type === "redirected_statement") {
      own = stage.namedChildren.filter((c) => c && REDIRECT_TYPES.has(c.type));
      inner = stage.namedChildren.find((c) => c && !REDIRECT_TYPES.has(c.type)) ?? stage;
    }
    if (inner.type === "command") {
      // A compound stage is walked whole below, redirections included; a simple one is not.
      for (const redirect of own) descendIntoArguments(redirect, at, out);
      const cmd = command(inner, at, index, feeder, [...redirects, ...own]);
      out.push(cmd);
      descendIntoArguments(inner, at, out);
      feeder = cmd;
    } else {
      walk(stage, at, out, redirects);
      feeder = null; // a compound stage's output is not one command's output
    }
  });
}

/**
 * A `$( … )` inside an argument runs too; list the commands nested in it. So does any other
 * statement the grammar hangs under a command (`foo ( rm -rf x )`, which bash itself rejects):
 * whatever the grammar found is listed, never dropped.
 */
function descendIntoArguments(node, where, out, skip = null) {
  for (const child of node.namedChildren) {
    if (!child || child.type === "command_name" || child.id === skip?.id) continue;
    if (child.type === "command_substitution" || child.type === "process_substitution") {
      walk(child, where, out, []);
    } else if (ARGUMENT_TYPES.has(child.type) || REDIRECT_TYPES.has(child.type) || child.type === "variable_assignment") {
      descendIntoArguments(child, where, out);
    } else {
      walk(child, where, out, []);
    }
  }
}

/**
 * @param {{ scope: number[], conditional: boolean, fn: number | null }} where
 * @param {Command | null} feeder the simple command piped into this one
 * @returns {Command}
 */
function command(node, where, pipeIndex, feeder, redirects) {
  const argv = [];
  const shapes = [];
  const prefix = [];
  const all = [...redirects];
  for (const child of node.namedChildren) {
    if (!child) continue;
    if (child.type === "variable_assignment") prefix.push(assignment(child));
    else if (child.type === "command_name") {
      const parts = child.namedChildren.filter(Boolean);
      argv.push(parts.map(unquote).join(""));
      shapes.push(merged(parts.map(shapeOf)));
    } else if (ARGUMENT_TYPES.has(child.type)) {
      argv.push(unquote(child));
      shapes.push(shapeOf(child));
    } else if (REDIRECT_TYPES.has(child.type)) all.push(child);
  }
  let feederCommand = feeder;
  let stdinRedirected = false;
  let stdinFile = null;
  let heredoc = null;
  const writes = [];
  for (const redirect of all) {
    if (redirect.type === "heredoc_redirect" || redirect.type === "herestring_redirect") {
      stdinRedirected = true;
      const body = redirect.namedChildren.find((c) => c?.type === "heredoc_body");
      if (body) heredoc = body.text;
      // A here-string (`<<< 'text'`) has no heredoc_body; its argument is the stdin text.
      else if (redirect.type === "herestring_redirect") {
        const arg = redirect.namedChildren.find((c) => c && ARGUMENT_TYPES.has(c.type));
        if (arg) heredoc = unquote(arg);
      }
      continue;
    }
    const operator = redirect.children.find((c) => c && !c.isNamed)?.text ?? "";
    const descriptor = redirect.namedChildren.find((c) => c?.type === "file_descriptor")?.text;
    const target = redirect.namedChildren.find((c) => c && c.type !== "file_descriptor" && ARGUMENT_TYPES.has(c.type));
    if (operator === "<" && (descriptor === undefined || descriptor === "0")) {
      stdinRedirected = true;
      stdinFile = target ? unquote(target) : null;
      // `bash < <(echo …)`: what the process substitution prints is this command's stdin.
      if (target?.type === "process_substitution") {
        const inner = [];
        walk(target, where, inner, []);
        feederCommand = inner.findLast((e) => e.kind === "command") ?? null;
      }
    } else if (WRITING.has(operator) && target && target.type !== "number") {
      writes.push(unquote(target)); // `>&2` duplicates a descriptor and writes no file
    }
  }
  return {
    kind: "command", argv, shapes, prefix, ...where, start: node.startIndex, end: node.endIndex, pipeIndex,
    feeder: feeder?.argv ?? null, feederCommand, stdinRedirected, stdinFile, writes, heredoc,
  }; // prettier-ignore
}

/**
 * What the shell will still do to one argument node after removing its quotes.
 *
 * @param {import("web-tree-sitter").Node} node
 * @returns {WordShape}
 */
export function shapeOf(node) {
  switch (node.type) {
    case "word":
      // A backslash-escaped `*` or `{` is literal. The grammar hands a brace list over as bare
      // words (`{`, `a,b`, `}`), so a brace in a word is what makes one.
      return {
        glob: /(?<!\\)[*?[]/.test(node.text),
        split: false,
        brace: /(?<!\\)[{}]/.test(node.text),
        quoted: /\\/.test(node.text),
      };
    case "string":
    case "raw_string":
    case "ansi_c_string":
    case "translated_string":
      return { glob: false, split: false, brace: false, quoted: true };
    case "simple_expansion":
    case "expansion":
    case "command_substitution":
      return { glob: true, split: true, brace: false, quoted: false };
    case "brace_expression":
      return { glob: false, split: false, brace: true, quoted: false };
    case "concatenation": {
      const parts = node.children.filter(Boolean).map((c) => (c.isNamed ? shapeOf(c) : wordShapeOf(c.text)));
      return merged(parts);
    }
    default:
      return { glob: false, split: false, brace: false, quoted: false };
  }
}

/** An unnamed piece of a concatenation (`{`, `,`, `}` of a brace list, say) read as a bare word. */
function wordShapeOf(text) {
  return { glob: /[*?[]/.test(text), split: false, brace: /[{}]/.test(text), quoted: false };
}

/** @param {WordShape[]} shapes */
function merged(shapes) {
  return {
    glob: shapes.some((x) => x.glob),
    split: shapes.some((x) => x.split),
    brace: shapes.some((x) => x.brace),
    quoted: shapes.some((x) => x.quoted),
  };
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
 * Does the command whose chain is `first` guard the one whose chain is `later` with `&&`? True when
 * some `a && b` list has `first` as the LAST command of its left side (right-most at every deeper
 * list) and `later` on its right side: `later` then runs only if `first` succeeded.
 *
 * @param {ListLink[]} first
 * @param {ListLink[]} later
 */
export function guards(first, later) {
  for (let i = 0; i < first.length; i += 1) {
    const link = first[i];
    if (link.side !== "L" || !link.and) continue;
    if (!first.slice(i + 1).every((deeper) => deeper.side === "R")) continue;
    if (later.some((l) => l.id === link.id && l.side === "R")) return true;
  }
  return false;
}

// `$NAME`, `${NAME}`, and the special parameters `$0`…`$9`, `$@`, `$*`.
const VAR_REF = /\$\{([A-Za-z_]\w*|[0-9@*])\}|\$([A-Za-z_]\w*|[0-9@*])/g;
const MAX_FIELDS = 4096; // a word expanding to more is treated as one this guard cannot read

/**
 * A word with what CAN be known substituted in, and whether anything still cannot.
 *
 * Knows `~`, `$NAME` / `${NAME}` (and `$0`…`$9`, `$@`, `$*`) from `vars` then the environment,
 * `$PWD`, `$(pwd)`, and a bare `$(mktemp …)`, which always names something fresh under the temp
 * directory. Anything else that expands at run time leaves `unknown` true: a caller must not
 * treat a word it cannot read as a word that names nothing.
 *
 * @param {string} word
 * @param {{ cwd: string, vars?: Map<string, string>, env?: NodeJS.ProcessEnv, home?: string }} context
 * @returns {{ text: string, unknown: boolean }}
 */
export function resolveWord(word, context) {
  const { text, unknown } = substitute(word, context);
  // A brace list or range (`{a,b}`, `{1..3}`) is several words; expandWord expands it.
  return { text, unknown: unknown || /\{[^{}]*(?:,|\.\.)[^{}]*\}/.test(text) };
}

/** resolveWord without the brace check: variables, `~`, `$(pwd)` and `$(mktemp)` only. */
function substitute(word, { cwd, vars = new Map(), env = process.env, home = env.HOME ?? "" }) {
  let text = word;
  if (home && (text === "~" || text.startsWith("~/"))) text = home + text.slice(1);
  const fresh = join(env.TMPDIR || tmpdir(), "mktemp-not-yet-created");
  // Three rounds reach through `A=$B/x; B=$(mktemp -d)` chains without looping forever.
  for (let round = 0; round < 3; round += 1) {
    text = text
      .replace(VAR_REF, (whole, braced, bare) => {
        const name = braced ?? bare;
        if (name === "PWD") return cwd;
        const value = vars.get(name) ?? (/^[A-Za-z_]/.test(name) ? env[name] : undefined);
        return typeof value === "string" ? value : whole;
      })
      .replace(/\$\(\s*pwd\s*\)|`\s*pwd\s*`/g, () => cwd)
      .replace(/\$\(\s*mktemp(?:\s+-[A-Za-z]+)*\s*\)/g, () => fresh);
  }
  // Still unknown: an expansion, or another user's home.
  return { text, unknown: /[$`]/.test(text) || /^~[^/]/.test(text) };
}

/** What a bare, unquoted word gets: globbed and brace-expanded, never split. */
const BARE = { glob: true, split: false, brace: true, quoted: false };

/**
 * A word as the shell expands it into fields: variables substituted (a variable holding several
 * values gives a field set for each), then brace expansion, then word splitting of what an
 * unquoted expansion produced, as `shape` says the word was written. A field keeps whether the
 * shell will glob it. Empty fields are dropped: an unquoted empty expansion is no argument, and
 * `rm ""` removes nothing.
 *
 * A word whose unquoted expansion also sits beside quoted text (`"a b"$X`) is kept whole as well
 * as split, because splitting it exactly would need the quoting of each character; the union
 * never misses a file the shell would name.
 *
 * @param {string} word as listed: quoting removed, expansions as written
 * @param {WordShape} [shape] from the listing; a word it did not come from is read as bare
 * @param {{ cwd: string, vars?: Map<string, string | string[]>, env?: NodeJS.ProcessEnv, home?: string }} context
 * @returns {{ fields: Array<{ text: string, glob: boolean }>, unknown: boolean }}
 */
export function expandWord(word, shape = BARE, context) {
  const vars = context.vars ?? new Map();
  const names = new Set([...word.matchAll(VAR_REF)].map((m) => m[1] ?? m[2]));
  let choices = [new Map()];
  for (const name of names) {
    const value = vars.get(name);
    if (!Array.isArray(value)) continue;
    choices = choices.flatMap((choice) => value.map((v) => new Map([...choice, [name, v]])));
    if (choices.length > MAX_FIELDS) return { fields: [], unknown: true };
  }
  const fields = [];
  for (const choice of choices) {
    const plain = new Map();
    for (const [name, value] of vars) plain.set(name, Array.isArray(value) ? (choice.get(name) ?? "") : value);
    const { text, unknown } = substitute(word, { ...context, vars: plain });
    if (unknown) return { fields: [], unknown: true };
    let texts = shape.brace ? expandBraces(text) : [text];
    if (texts === null) return { fields: [], unknown: true };
    if (shape.split) {
      texts = texts.flatMap((t) => {
        const parts = t.split(/[ \t\n]+/).filter(Boolean);
        return shape.quoted && parts.length > 1 ? [...parts, t] : parts;
      });
    }
    for (const t of texts) if (t !== "") fields.push({ text: t, glob: shape.glob });
    if (fields.length > MAX_FIELDS) return { fields: [], unknown: true };
  }
  return { fields, unknown: false };
}

/**
 * Bash brace expansion: `a{b,c}d` → abd acd, `{1..3}`, `{a..c}`, nested lists. Unmatched or empty
 * braces stay literal, as do `${…}`. Null when the result would exceed MAX_FIELDS.
 *
 * @param {string} text
 * @returns {string[] | null}
 */
export function expandBraces(text) {
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] !== "{" || text[i - 1] === "$") continue;
    let depth = 0;
    let end = -1;
    const commas = [];
    for (let j = i; j < text.length; j += 1) {
      if (text[j] === "{") depth += 1;
      else if (text[j] === "}" && (depth -= 1) === 0) {
        end = j;
        break;
      } else if (text[j] === "," && depth === 1) commas.push(j);
    }
    if (end < 0) return [text];
    const inner = text.slice(i + 1, end);
    let alternatives = null;
    if (commas.length > 0) {
      alternatives = [];
      let from = i + 1;
      for (const c of [...commas, end]) {
        alternatives.push(text.slice(from, c));
        from = c + 1;
      }
    } else alternatives = range(inner);
    if (alternatives === null) continue; // `{x}` is literal; look for a later brace
    const out = [];
    for (const alternative of alternatives) {
      const expanded = expandBraces(text.slice(0, i) + alternative + text.slice(end + 1));
      if (expanded === null) return null;
      out.push(...expanded);
      if (out.length > MAX_FIELDS) return null;
    }
    return out;
  }
  return [text];
}

/** `1..3`, `3..1`, `1..10..2`, `a..e` as their values, or null for anything else. */
function range(inner) {
  const numeric = /^(-?\d+)\.\.(-?\d+)(?:\.\.(-?\d+))?$/.exec(inner);
  if (numeric) {
    const [from, to] = [Number(numeric[1]), Number(numeric[2])];
    const step = Math.abs(Number(numeric[3] ?? 1)) || 1;
    if (Math.abs(to - from) / step > MAX_FIELDS) return null;
    const out = [];
    for (let n = from; from <= to ? n <= to : n >= to; n += from <= to ? step : -step) out.push(String(n));
    return out;
  }
  const letters = /^([a-zA-Z])\.\.([a-zA-Z])$/.exec(inner);
  if (!letters) return null;
  const [a, b] = [letters[1].charCodeAt(0), letters[2].charCodeAt(0)];
  const out = [];
  for (let c = a; a <= b ? c <= b : c >= b; c += a <= b ? 1 : -1) out.push(String.fromCharCode(c));
  return out;
}
