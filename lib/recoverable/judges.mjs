// RECOVERABLE's judges. Each takes ONE command, already found and unwrapped by the dispatcher,
// and answers one question by asking git: would running this destroy something git cannot
// give back?
//
// That question has no spellings. A command either destroys bytes that never reached git's
// object store (untracked, not-ignored files, and uncommitted edits) or it does not, and git says
// which. Ignored files (`node_modules`, `build/`, `*.pyc`) and clean tracked files are silent
// by construction: a rebuild or a checkout gives those back.
//
//   main thread  -> ask, naming what would be lost (you do delete your own scratch work)
//   subagent     -> deny, saying whose it is (the agent that caused this repo's first rule
//                   read the orchestrator's untracked project as clutter and deleted it)
//
// Contract with the dispatcher (lib/recoverable/dispatch.mjs):
//   * `argv` is the command as listed, with every wrapper word already removed, so argv[0] is
//     the program that really runs. Inside a `find`, each -exec clause starts with the program
//     it really runs, too.
//   * `ctx.resolve(word)` expands a word with everything the dispatcher knows at that point
//     (cwd, variables set earlier) and says whether it still depends on run time.
//   * `ctx.before` is every command earlier in the same Bash call: `{ argv, certain, base, pipelines }`,
//     where `certain` says it runs whatever happens before it, and has finished before any later
//     command starts (not an `&` job nobody waited for), `base` is where it runs (null when that is
//     one of several places), and `pipelines` names the pipeline stages it runs in, each
//     `<pipeline>:<stage>`.
//   * `ctx.memo` is one Map for the whole Bash call: a question to git or the disk is asked once per
//     call, since nothing changes while the call is judged (the command has not run). Optional.
//   * `ctx.pipelines` names the pipeline stages this command runs in. An earlier command in another
//     stage of one of those pipelines runs at the same time, so nothing it saved can be relied on.
//     Optional.
//   * `ctx.prefix` is the command's own `NAME=value` prefix (the listing's `prefix`), so
//     `GIT_DIR=… git clean -fd` is judged in the repository it names. Optional.
//   * `ctx.expand(word)` gives the fields the shell makes of an operand (split, brace-expanded,
//     and whether each is globbed). Optional: without it, `resolve` stands in.
//   * `ctx.fed` is true inside a payload a find or xargs hands its matches to: a file named there is
//     fed in, never plainly named, so the one-file exemption does not apply. Optional.
//   * `ctx.singles` collects the one-file deletes a call makes, as `{ path, seen, pipelines }` (`seen`:
//     how many earlier commands `ctx.before` held then). Each is left alone; the dispatcher
//     judges them together once there are two (`rm a.md; rm b.md`). Optional.
//
// Each verdict carries its `loss` ({ what, lost, history }) beside the reason, so the dispatcher
// can name every loss in a Bash call in one reason (`merged`).

import { lstatSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, dirname, join, relative, sep } from "node:path";

import { FIND, FIND_TIMEOUT_MS, ProbeFailed, configBool, git as runGit, gitlinks, repositoryOf, run, status } from "./git.mjs";

import { FIND_EXEC, RM_LIKE, splitString } from "../commands.mjs";
import { absolute, exists, inside, isDirectory, isRealDirectory, listDirectories, realOrSelf } from "./paths.mjs";

/**
 * @typedef {import("../runner.mjs").Verdict} Verdict
 * @typedef {{ top: string, common: string, config: string[] }} Repo
 * @typedef {object} Context
 * @property {string} base the directory the command runs in
 * @property {string} agentId "" on the main thread
 * @property {(word: string) => { text: string, unknown: boolean }} resolve
 * @property {Array<{ argv: string[], certain: boolean, base: string | null, pipelines?: string[] }>} before
 * @property {string[]} [pipelines]
 * @property {Map<string, Promise<unknown>>} [memo]
 * @property {Array<[string, string]>} [prefix]
 * @property {(word: string) => { fields: Array<{ text: string, glob: boolean }>, unknown: boolean }} [expand]
 * @property {Array<{ path: string, seen: number, pipelines: string[] }>} [singles]
 * @property {AbortSignal} [signal]
 *
 * @typedef {{ kind: "find", argv: string[] } | { kind: "file", path: string } | { kind: "text", text: string } | { kind: "unknown" }} Feed
 */

export { ProbeFailed };

const NAMED = 4; // victims quoted by name in a reason
const MAX_VICTIMS = 250_000; // a dry run naming more falls back to the stricter whole-root check
const MAX_LIST_BYTES = 1_000_000; // an xargs input file larger than this is judged by where it runs
const MAX_WALKED = 2000; // directories listed below a target, nearest first, in the search for a `.git`
// Entries read in that walk, whatever the directories hold. One listing reads a whole directory, so
// without this a single directory of a million entries costs seconds (measured: 270 ms at 100,000).
const MAX_ENTRIES = 20_000;
const MAX_NESTED = 32; // repositories below a target that are read; more than this asks, unread
const FIND_WRITES = new Set(["-fprint", "-fprint0", "-fprintf", "-fls"]);
const FIND_LEADING = new Set(["-H", "-L", "-P"]);
// Predicates that only print. The dry run prints NUL-separated names itself, and any other
// output mixed into that list would turn every victim's name into garbage.
const FIND_OUTPUTS = new Set(["-print", "-print0", "-ls"]);

/** `tokens` without the predicates that only print (and `-printf`'s format word). */
function withoutOutputs(tokens) {
  const out = [];
  for (let i = 0; i < tokens.length; i += 1) {
    if (tokens[i] === "-printf") i += 1;
    else if (!FIND_OUTPUTS.has(tokens[i])) out.push(tokens[i]);
  }
  return out;
}

// Which dirty entries each kind of destruction loses, from git's porcelain XY code.
// A path in a conflicted merge carries a resolution in progress, whichever side changed.
const UNMERGED = (xy) => xy.includes("U") || xy === "AA" || xy === "DD";
const LOSES = {
  // deleting: untracked files and every uncommitted edit, staged or not
  any: (xy) => xy === "??" || "MTARC".includes(xy[0]) || "MT".includes(xy[1]) || UNMERGED(xy),
  // restoring from the index: unstaged edits only. A staged edit survives
  worktree: (xy) => "MT".includes(xy[1]) || UNMERGED(xy),
  // restoring from a commit: every uncommitted edit to a tracked file
  tracked: (xy) => xy !== "??" && ("MTARC".includes(xy[0]) || "MT".includes(xy[1]) || UNMERGED(xy)),
  // git clean
  untracked: (xy) => xy === "??",
};

// ─── rm ─────────────────────────────────────────────────────────────────────────────────

/**
 * `rm` / `unlink` / `shred` with operands on the command line. Deleting ONE file, named plainly,
 * on the main thread, is everyday scratch cleanup and is left alone. A recursive delete, a glob,
 * a brace list, a variable holding several words, a second one-file delete anywhere in the same
 * call, and every delete a subagent makes are judged.
 *
 * @param {string[]} argv
 * @param {Context} ctx
 * @returns {Promise<Verdict | null>}
 */
export async function rm(argv, ctx) {
  const what = `\`${basename(argv[0])}\``;
  const words = rmWords(argv, ctx);
  // `$UNSET/wip`, `$(cmd)`: not a path this guard can read. Absence of a readable target is not
  // evidence of a harmless one, so the question moves to where it runs.
  if (words === null) return whereItRuns(`${what} of a target this guard cannot read`, ctx);
  const { operands, recursive } = words;
  if (operands.length === 0) return null;
  // rm refuses `.` and `..` whatever else it is told; without -r it refuses a directory.
  const fields = operands.filter((f) => !/(?:^|\/)\.\.?\/*$/.test(f.text));
  let targets = [...new Set(fields.flatMap((f) => absolute(ctx.base, f.text, f.glob)))].filter(exists);
  if (!recursive) targets = targets.filter((t) => !isRealDirectory(t));
  if (targets.length === 0) return null;
  // `.git/index` is one file, and not scratch: it is the staging area.
  const internal = targets.some((path) => gitData(path)?.guarded);
  const plain = fields.length === 1 && !(fields[0].glob && /[*?[]/.test(fields[0].text));
  if (!recursive && !ctx.agentId && !ctx.fed && !internal && plain && targets.length === 1) {
    ctx.singles?.push({ path: targets[0], seen: ctx.before?.length ?? 0, pipelines: ctx.pipelines ?? [] });
    return null;
  }
  return judgePaths(targets, "any", what, ctx);
}

/**
 * rm's words as rm reads them: after the shell has expanded them (`F=-rf; rm $F wip` is recursive),
 * split into flags and operand fields. Null when a word cannot be read.
 *
 * @returns {{ operands: Array<{ text: string, glob: boolean }>, recursive: boolean } | null}
 */
function rmWords(argv, ctx) {
  const expanded = argv.slice(1).map((word) => expandOf(ctx, word));
  if (expanded.some((e) => e.unknown)) return null;
  const flags = [];
  const operands = [];
  let literal = false;
  for (const field of expanded.flatMap((e) => e.fields)) {
    if (literal || !field.text.startsWith("-") || field.text === "-") operands.push(field);
    else if (field.text === "--") literal = true;
    else flags.push(field.text);
  }
  return { operands, recursive: flags.some((f) => f === "--recursive" || (!f.startsWith("--") && /[rR]/.test(f))) };
}

/**
 * One expanded field as the absolute paths it names (a glob the shell expands, matched on disk).
 *
 * @param {string} base
 * @param {{ text: string, glob: boolean }} field
 */
export function globbed(base, field) {
  return absolute(base, field.text, field.glob);
}

/** The fields the shell makes of `word`, from the dispatcher's expansion or a plain resolve. */
function expandOf(ctx, word) {
  if (ctx.expand) return ctx.expand(word);
  const r = ctx.resolve(word);
  if (r.unknown) return { fields: [], unknown: true };
  return { fields: r.text === "" ? [] : [{ text: r.text, glob: true }], unknown: false };
}

/**
 * The one-file deletes of one Bash call, judged together: each alone is scratch cleanup, several
 * are a sweep (`rm a.md; rm b.md; rm c.md`, or the same inside a loop).
 *
 * @param {string[]} targets absolute paths
 * @param {Context} ctx
 */
export async function oneFileDeletes(targets, ctx) {
  return judgePaths([...new Set(targets)], "any", "`rm` one file at a time", ctx);
}

/**
 * An `rm` whose operands arrive on stdin through `xargs`. `feed` says where they come from: a
 * printing `find` (dry-run exactly as written), a file (`xargs -a list`, `< list`), text the
 * command itself carries (`echo build | xargs rm`, a here-string), or something unreadable.
 *
 * @param {string[]} argv the rm, with any xargs replacement token already removed
 * @param {Feed} feed
 * @param {Context} ctx
 * @param {{ perLine?: boolean, nul?: boolean }} [how] xargs' splitting: one item per line (-I),
 *   or per NUL (-0); else on blanks
 */
export async function pipeFedRm(argv, feed, ctx, how = {}) {
  const what = "a pipe-fed `rm`";
  const words = rmWords(argv, ctx);
  if (words === null) return whereItRuns(`${what} of a target this guard cannot read`, ctx);
  const fixed = words.operands.flatMap((f) => absolute(ctx.base, f.text, f.glob));
  // Without -r, rm refuses a directory, fed or named: `echo wip | xargs rm` removes nothing.
  const removes = (path) => words.recursive || !isRealDirectory(path);
  if (feed.kind === "find") {
    const found = await findMatches(feed.argv, ctx);
    if (found !== null) return sweepVerdict(findRoots(feed.argv).flatMap((r) => absolute(ctx.base, r)), [...found, ...fixed.filter(exists)].filter(removes), what, ctx);
  } else {
    const text = await feedText(feed, ctx);
    // xargs hands each item to rm as it is: no shell runs, so a `*` in one is a character.
    const paths = text === null ? null : itemsIn(text, how).map((item) => absolute(ctx.base, item, false));
    // An item that names nothing on disk is nothing to lose (`rm -f` would say as much), unless
    // xargs unquoted it: it reads quotes and backslashes its own way (not with -0), and a name
    // under them that is not here as this guard read it may be there as xargs reads it.
    const unquoted = !how.nul && /['"\\]/.test(text ?? "");
    const unseen = unquoted && paths?.some((p) => !p.some(exists));
    if (paths && !unseen) {
      const from = feed.kind === "file" ? ` (fed from ${basename(feed.path)})` : "";
      return judgePaths([...new Set([...paths.flat(), ...fixed])].filter(exists).filter(removes), "any", `${what}${from}`, ctx);
    }
  }
  return whereItRuns(`${what} whose input this guard cannot read`, ctx);
}

/**
 * The items an `xargs` reads, when they can be read here: from a file, from text the command
 * carries, or the files a printing `find` would print (absolute). Null otherwise.
 *
 * @param {Feed} feed
 * @param {Context} ctx
 * @param {{ perLine?: boolean, nul?: boolean }} [how]
 * @returns {Promise<string[] | null>}
 */
export async function feedItems(feed, ctx, how = {}) {
  if (feed.kind === "find") return findMatches(feed.argv, ctx);
  const text = await feedText(feed, ctx);
  return text === null ? null : itemsIn(text, how);
}

/** What an `xargs` reads, as text, from a file or from the command itself. Null otherwise. */
async function feedText(feed, ctx) {
  let text = null;
  if (feed.kind === "text") text = feed.text;
  if (feed.kind === "file") {
    const resolved = ctx.resolve(feed.path);
    if (resolved.unknown) return null;
    try {
      text = await readFile(absolute(ctx.base, resolved.text)[0], "utf8");
    } catch {
      return null;
    }
  }
  return text === null || text.length > MAX_LIST_BYTES ? null : text;
}

/** The items xargs makes of its input: per NUL (-0), per line (-I), else on blanks, unquoted. */
function itemsIn(text, how) {
  if (how.nul) return text.split("\0").filter(Boolean);
  if (how.perLine) return text.split("\n").map((line) => line.trim()).filter(Boolean);
  return splitString(text);
}

// ─── find ───────────────────────────────────────────────────────────────────────────────

/**
 * A `find` that deletes what it matches (`-delete`, or `-exec rm … {}`). It is dry-run with
 * the destructive action swapped for `-print0`, through the system `find` by absolute path,
 * and what it would remove is checked against git in one status call per root.
 *
 * @param {string[]} argv
 * @param {Context} ctx
 */
export async function find(argv, ctx) {
  const resolved = argv.map((w) => ctx.resolve(w));
  const tokens = resolved.map((r) => r.text);
  if (!deletes(tokens)) return null;
  const what = "`find` (deleting what it matches)";
  if (resolved.some((r) => r.unknown)) return whereItRuns(`${what} with a word this guard cannot read`, ctx);
  const roots = rootsOf(tokens, ctx);
  const victims = await dryRun(simulated(withoutOutputs(tokens)), ctx);
  if (victims === null) return judgePaths(roots, "any", what, ctx); // stricter, never looser
  return sweepVerdict(roots, victims, what, ctx);
}

/**
 * A find's starting points as the directories it walks. A symlink it follows (`-L`, `-H`, or a
 * trailing slash) is the directory it points to: git is asked about that, not about the link.
 */
function rootsOf(tokens, ctx) {
  const follows = tokens.slice(1).some((t) => t === "-L" || t === "-H");
  return findRoots(tokens)
    .flatMap((r) => absolute(ctx.base, r).map((path) => (follows ? realOrSelf(path) : path)))
    .filter(exists);
}

/**
 * The files a find would match, printed by the system find in a dry run (its deleting and
 * executing actions removed first), as absolute paths. Null when it cannot be run safely or
 * trusted.
 *
 * @param {string[]} argv
 * @param {Context} ctx
 * @returns {Promise<string[] | null>}
 */
export async function findMatches(argv, ctx) {
  const resolved = argv.map((w) => ctx.resolve(w));
  if (resolved.some((r) => r.unknown) || !FIND) return null;
  const tokens = resolved.map((r) => r.text);
  const unsafe = tokens.some((t) => FIND_EXEC.has(t) || FIND_WRITES.has(t) || t === "-delete");
  if (unsafe) return null;
  return dryRun([...withoutOutputs(tokens.slice(1)), "-print0"], ctx);
}

function deletes(tokens) {
  if (tokens.includes("-delete")) return true;
  return tokens.some((t, i) => FIND_EXEC.has(t) && RM_LIKE.has(basename(tokens[i + 1] ?? "")));
}

function findRoots(tokens) {
  const roots = [];
  for (const t of tokens.slice(1)) {
    if (FIND_LEADING.has(t)) continue;
    if (t.startsWith("-") || t === "(" || t === "!" || t === ")") break;
    roots.push(t);
  }
  return roots.length ? roots : ["."];
}

/**
 * The same find with each destructive action replaced by `-print0`, or null when some action
 * cannot be simulated safely (it runs something that is not a plain rm, or it writes a file).
 */
function simulated(tokens) {
  if (!FIND) return null;
  const out = [];
  for (let i = 1; i < tokens.length; i += 1) {
    const t = tokens[i];
    if (t === "-delete") out.push("-print0");
    else if (FIND_EXEC.has(t)) {
      const end = tokens.findIndex((x, j) => j > i && (x === ";" || x === "+"));
      const clause = end > 0 ? tokens.slice(i + 1, end) : [];
      if (end < 0 || t === "-ok" || t === "-okdir" || !RM_LIKE.has(basename(clause[0] ?? "")) || !clause.includes("{}")) {
        return null;
      }
      out.push("-print0");
      i = end;
    } else if (FIND_WRITES.has(t)) return null;
    else out.push(t);
  }
  return out;
}

/** Paths the (simulated, read-only) find would remove, or null when that cannot be trusted. */
async function dryRun(args, ctx) {
  if (!args) return null;
  let ran;
  try {
    ran = await run(FIND, args, { cwd: ctx.base, timeoutMs: FIND_TIMEOUT_MS, signal: ctx.signal });
  } catch {
    return null;
  }
  const names = ran.stdout.toString("utf8").split("\0").filter(Boolean);
  if (names.length > MAX_VICTIMS) return null;
  if (ran.code !== 0 && names.length === 0) return null; // a permission-denied branch is normal; nothing at all is not
  // find prints a match under its root as the root was spelled. Behind a link the find walks
  // through (`wiplink/`, -L, -H) that spelling is not where the file is, and git names the real
  // place. And a printed name is a name: `[n]otes.md` is that file, not a pattern to expand.
  /** @type {Map<string, string>} */
  const real = new Map();
  return names.map((n) => {
    const [path] = absolute(ctx.base, n, false);
    const dir = dirname(path);
    if (!real.has(dir)) real.set(dir, realOrSelf(dir));
    return join(real.get(dir), basename(path));
  });
}

/**
 * What a sweep rooted at each root would destroy. One `git status` per root and string
 * arithmetic for the rest: a dirty path is lost when it, or a directory above it, is a victim.
 * (Handing git every victim as a pathspec cost seconds on a real tree.)
 */
async function sweepVerdict(roots, victims, what, ctx) {
  const lost = [];
  const orphans = [];
  const nested = new Set();
  /** @type {Array<{ repo: Repo, paths: string[] }>} */
  const holders = [];
  const named = new Set(victims);
  // git status never lists what is inside `.git`, so a sweep that reaches it is named here.
  const internals = victims.map((v) => gitData(v)).filter((d) => d !== null && d.guarded);
  const history = internals.length ? [ownData(internals)] : [];
  for (const root of roots) {
    const holder = gitData(root)?.tree ?? (basename(root) === ".git" ? dirname(root) : null);
    const repo = await repoAt(holder ?? (isRealDirectory(root) ? root : dirname(root)), ctx, { climb: true });
    if (!repo) {
      // A sweep rooted above any repository (`find .. -name notes.md -delete`) still reaches
      // into the ones below it: each victim is judged in its own.
      for (const item of victims.filter((v) => v === root || v.startsWith(root + sep))) orphans.push(item);
      continue;
    }
    const relRoot = inside(repo.top, root);
    if (relRoot === null) continue;
    holders.push({ repo, paths: [root] });
    const prefix = await namedFrom(repo, ctx);
    if (named.has(root)) {
      for (const item of await lostUnder(repo, [root], "any", ctx, { nested })) lost.push(join(prefix, item));
      continue;
    }
    for (const [xy, path] of withoutRepositories(repo, await statusOf(repo, [relRoot], ctx), nested)) {
      if (!LOSES.any(xy)) continue;
      const abs = join(repo.top, path);
      if (selfAndParents(abs).some((p) => named.has(p))) lost.push(join(prefix, path));
    }
  }
  // A repository inside a root says nothing to the root's own status. What the sweep matches
  // in it is what is lost there. (Under a root above every repository, each victim is judged in
  // its own repository below, exactly, and nothing is walked for it.)
  const inRepository = holders.flatMap((h) => h.paths);
  const walk = await nestedRepositories(inRepository, holders, ctx, nested);
  for (const { repo, name } of walk.found) {
    for (const [xy, path] of await statusOf(repo, ["."], ctx)) {
      if (!LOSES.any(xy)) continue;
      if (selfAndParents(join(repo.top, path)).some((p) => named.has(p))) lost.push(join(name, path));
    }
  }
  if (orphans.length > 0) {
    const inRepos = await judgePaths([...new Set(orphans)], "any", what, ctx, { history: false });
    if (inRepos?.loss) {
      for (const item of inRepos.loss.lost) lost.push(item);
      for (const item of inRepos.loss.history) history.push(item);
    }
  }
  return shape(what, lost, ctx, history, walk.stopped);
}

function selfAndParents(path) {
  const out = [];
  for (let p = path; p !== dirname(p); p = dirname(p)) out.push(p);
  return out;
}

// ─── git ────────────────────────────────────────────────────────────────────────────────

// The subcommands that can discard work. Everything else passes untouched.
const DISCARDING = new Set(["checkout", "restore", "switch", "checkout-index", "clean", "rm", "reset", "stash", "worktree", "read-tree"]);
const GIT_VALUED = new Set(["-C", "-c", "--config-env", "--git-dir", "--work-tree", "--namespace", "--exec-path"]);
const UNSEEN = "\0"; // a setting whose value this guard cannot read
const LOCATION_ENV = { GIT_DIR: "--git-dir", GIT_WORK_TREE: "--work-tree" };

/**
 * The git subcommands that discard work: checkout, restore, switch, checkout-index, clean,
 * rm, reset --hard, stash drop / clear, worktree remove --force.
 *
 * @param {string[]} argv
 * @param {Context} ctx
 */
export async function git(argv, ctx) {
  const resolved = argv.map((w) => ctx.resolve(w));
  const words = resolved.map((r) => r.text);
  let i = 1;
  let dir = ctx.base;
  /** @type {string[]} `-c key=value` settings on this command, in order */
  const settings = [];
  // Which repository: GIT_DIR / GIT_WORK_TREE in the prefix, overridden by `--git-dir` /
  // `--work-tree` on the command. Their paths are resolved after every -C, as git does.
  /** @type {Map<string, { text: string, unknown: boolean }>} */
  const location = new Map();
  for (const [name, value] of ctx.prefix ?? []) {
    if (LOCATION_ENV[name]) location.set(LOCATION_ENV[name], ctx.resolve(value));
  }
  while (i < words.length && words[i].startsWith("-")) {
    const eq = words[i].indexOf("=");
    const option = eq > 0 ? words[i].slice(0, eq) : words[i];
    if (option === "--git-dir" || option === "--work-tree") {
      const value = eq > 0 ? { ...resolved[i], text: words[i].slice(eq + 1) } : resolved[i + 1];
      if (value) location.set(option, value);
    }
    if (words[i] === "-C" && words[i + 1] !== undefined) dir = absolute(dir, words[i + 1])[0];
    if (words[i] === "-c" && words[i + 1] !== undefined) settings.push(words[i + 1]);
    // `--config-env key=VAR` takes the value from the environment, which this guard cannot see.
    const fromEnv = words[i] === "--config-env" ? words[i + 1] : /^--config-env=(.*)$/.exec(words[i])?.[1];
    if (fromEnv !== undefined) settings.push(`${fromEnv.split("=")[0]}=${UNSEEN}`);
    i += GIT_VALUED.has(words[i]) ? 2 : 1;
  }
  const sub = words[i];
  if (!sub || !DISCARDING.has(sub)) return null;
  // `git -C $UNSET reset --hard`: a repository this guard cannot read. Judge where it runs.
  if ([...resolved.slice(0, i), ...location.values()].some((r) => r.unknown)) {
    return whereItRuns(`\`git ${sub}\` in a repository this guard cannot read`, ctx);
  }
  // `git checkout -- $(git diff --name-only)`, and the files `xargs` or `find -exec` feed it: an
  // operand this guard cannot read is an open-ended pathspec. It is judged as naming the whole
  // tree, but only AFTER the flags have said whether the command loses anything at all
  // (`restore --staged` and `rm --cached` never do).
  const args = resolved.slice(i + 1).map((r) => (r.unknown ? ":(unreadable)" : r.text));
  if (!isDirectory(dir)) return null;
  // git resolves pathspecs from the real directory it runs in, not a symlink's spelling of it.
  dir = realOrSelf(dir);
  const where = [...location].map(([option, value]) => `${option}=${absolute(dir, value.text)[0]}`);
  const repo = await repoAt(dir, ctx, { location: where });
  if (!repo) return null;
  // Run from outside the work tree `--work-tree` names, git reads pathspecs from its top.
  const base = inside(repo.top, dir) === null ? repo.top : dir;
  const at = { ...ctx, base };
  const { flags, operands, paths: named, others, magic } = pathArgs(args, base, VALUED[sub] ?? new Set());
  // A `git add` or `git stash` earlier in this same call changes what is at stake (see `saved`).
  const saved = savedEarlier(ctx, repo);
  // A magic pathspec (`:!*.tmp`) or a pathspec file names an open-ended set: judge the tree.
  const paths = magic ? [repo.top] : named;
  const has = (long, short) => flags.includes(long) || (short && flags.some((f) => /^-[a-zA-Z]+$/.test(f) && f.includes(short)));

  switch (sub) {
    case "checkout":
      // `checkout -- f` restores from the INDEX, so a staged edit survives it. Naming a
      // commit (`checkout HEAD -- f`) rewrites the index too, and every uncommitted edit goes.
      if (paths.length) return lostVerdict(repo, paths, others.length ? "tracked" : "worktree", "`git checkout`", at);
      if (has("--force", "f")) return lostVerdict(repo, [repo.top], "tracked", "`git checkout --force`", at);
      return null;

    case "restore": {
      const staged = has("--staged", "S");
      const worktree = has("--worktree", "W");
      if ((staged && !worktree) || paths.length === 0) return null;
      return lostVerdict(repo, paths, staged ? "tracked" : "worktree", "`git restore`", at);
    }

    case "switch": {
      if (!has("--discard-changes") && !has("--force", "f")) return null;
      // Creating a branch with no start point (`switch -f -c other`) stays on the same commit and the
      // edits stay. Any start point, even `HEAD` or the branch it is on, resets them: driven on git 2.47.
      const creating = flags.some((f) => ["-c", "-C", "--create", "--force-create"].includes(f));
      if (creating && others.length === 0) return null;
      return lostVerdict(repo, [repo.top], saved.any ? "any" : "tracked", "`git switch` discarding changes", at);
    }

    case "read-tree":
      // `read-tree -u --reset` / `-u -m` rewrites the index and the work tree to match a tree.
      if (!args.includes("-u") || !(args.includes("--reset") || args.includes("-m"))) return null;
      return lostVerdict(repo, [repo.top], saved.any ? "any" : "tracked", "`git read-tree -u`", at);

    case "checkout-index": {
      if (!has("--force", "f")) return null; // without -f it never overwrites an existing file
      // `--prefix=DIR/` writes the files under DIR instead of over the work tree.
      if (flags.some((f) => f === "--prefix" || f.startsWith("--prefix="))) return null;
      const targets = has("--all", "a") || has("--stdin") ? [repo.top] : paths;
      return targets.length ? lostVerdict(repo, targets, "worktree", "`git checkout-index --force`", at) : null;
    }

    case "clean": {
      const dry = has("--dry-run", "n");
      const forced = has("--force", "f");
      // -X alone removes only ignored files. Add -x and it removes everything untracked.
      const shortFlags = flags.filter((f) => /^-[a-zA-Z]+$/.test(f)).join("");
      const onlyIgnored = shortFlags.includes("X") && !shortFlags.includes("x");
      if (dry || onlyIgnored || has("--interactive", "i")) return null;
      // With clean.requireForce false, a plain `git clean -d` deletes without -f.
      if (!forced && (await requiresForce(repo, settings, ctx.signal))) return null;
      // A pathspec that names nothing on disk matches no untracked file: nothing is cleaned.
      if (operands.length > 0 && paths.length === 0 && !magic) return null;
      const lost = await lostUnder(repo, paths.length ? paths : [base], "untracked", at);
      // Without -d and without a pathspec, git clean leaves every untracked DIRECTORY alone, and
      // with it everything inside (driven on git 2.47: `clean -f` -> nothing, `clean -f wip` -> wip/).
      const keptDirs = !has("-d", "d") && operands.length === 0 ? await untrackedDirs(repo, base, ctx) : [];
      return shape("`git clean`", lost.filter((p) => !keptDirs.some((d) => p.startsWith(d))), at);
    }

    case "rm":
      if (has("--cached") || !has("--force", "f") || paths.length === 0) return null; // plain git rm refuses to lose edits
      return lostVerdict(repo, paths, saved.any ? "any" : "tracked", "`git rm --force`", at);

    case "reset":
      if (!args.includes("--hard")) return null;
      return lostVerdict(repo, [repo.top], saved.any ? "any" : "tracked", "`git reset --hard`", at);

    case "stash": {
      const action = operands[0];
      if (action !== "drop" && action !== "clear") return null;
      const listed = await statusOfStash(repo, ctx);
      if (listed) return shape(`\`git stash ${action}\``, ["the stash (it is not empty)"], at);
      // Empty now, but if this same command stashes first, the dirt is what gets dropped.
      // A stash that MAY run first counts: the drop may then take what it stashed.
      const stashesFirst = ctx.before.some((b) => basename(b.argv[0] ?? "") === "git" && isStashPush(b.argv));
      return stashesFirst ? lostVerdict(repo, [repo.top], "any", `\`git stash ${action}\` after a stash`, at) : null;
    }

    case "worktree": {
      // Unforced, git refuses to remove a worktree holding modified or untracked files. Forced,
      // it deletes the worktree whole. Its commits live in the main tree and survive.
      if (operands[0] !== "remove" || !has("--force", "f") || operands[1] === undefined) return null;
      let [target] = absolute(base, operands[1]);
      // git also takes a worktree by its last path component, when that is unique.
      if (!isDirectory(target)) target = (await worktreeNamed(repo, operands[1], ctx)) ?? target;
      if (!isDirectory(target)) return null;
      const linked = await repoAt(realOrSelf(target), ctx);
      if (!linked) return null;
      return lostVerdict(linked, [linked.top], "any", "`git worktree remove --force`", at);
    }

    default:
      return null;
  }
}

/**
 * Does `git clean` need -f here? The command's own `-c clean.requireForce=…` wins, then the
 * config git would read. A value from `--config-env` cannot be read here, and counts as "no".
 */
async function requiresForce(repo, settings, signal) {
  for (const setting of settings.toReversed()) {
    const [key, ...rest] = setting.split("=");
    if (key.toLowerCase() !== "clean.requireforce") continue;
    if (rest.length === 0) return true; // `-c clean.requireForce` alone means true
    const value = rest.join("=").toLowerCase();
    if (value === UNSEEN) return false;
    if (["false", "no", "off", "0", ""].includes(value)) return false;
    return true; // true, or a value git rejects, and then git clean does nothing at all
  }
  return (await configBool(repo, "clean.requireForce", signal)) ?? true;
}

// Options whose value is the next word, per subcommand, so the value is not read as a path.
const VALUED = {
  checkout: new Set(["-b", "-B", "--orphan", "--conflict"]),
  restore: new Set(["-s", "--source", "--conflict"]),
  switch: new Set(["-c", "-C", "--create", "--force-create", "--orphan", "--conflict"]),
  clean: new Set(["-e", "--exclude"]),
  "checkout-index": new Set(["--prefix", "--stage"]),
};

function isStashPush(argv) {
  const i = argv.indexOf("stash");
  const action = argv[i + 1];
  return i > 0 && (action === undefined || action === "push" || action === "save" || action.startsWith("-"));
}

async function statusOfStash(repo, ctx) {
  const out = await gitOnce(repo, ["stash", "list"], ctx);
  return out.toString("utf8").trim() !== "";
}

/**
 * Split git arguments into flags, operands, and of the operands, which are paths. After `--`
 * everything is a path. Before it, only what exists, because `git checkout main` names a branch
 * and not a victim. What is left over is a tree-ish, and a tree-ish changes what is destroyed.
 */
function pathArgs(args, dir, valued) {
  const flags = [];
  const operands = [];
  const paths = [];
  const others = [];
  let literal = false;
  let magic = false;
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a.startsWith("--pathspec-from-file")) magic = true;
    // `:!*.tmp`, and a glob: git's `*` crosses `/`, so the shell-style expansion used for
    // paths would match nothing and judge nothing. Both name an open-ended set.
    if (!a.startsWith("-") && (a.startsWith(":") || /[*?[]/.test(a))) magic = true;
    if (literal) {
      for (const item of absolute(dir, a)) paths.push(item);
    } else if (a === "--") {
      literal = true;
    } else if (a.startsWith("-")) {
      flags.push(a);
      // `-e PATTERN`, and a cluster that ends in a letter taking a value (`-fde build`).
      if (valued.has(a) || (/^-[a-zA-Z]{2,}$/.test(a) && valued.has(`-${a.at(-1)}`))) i += 1;
    } else {
      operands.push(a);
      const found = absolute(dir, a).filter(exists);
      if (found.length) for (const item of found) paths.push(item);
      else others.push(a);
    }
  }
  return { flags, operands, paths, others, magic };
}

// ─── Asking git, and shaping the answer ─────────────────────────────────────────────────

/**
 * One answer per question per Bash call. Nothing a judge asks changes while the call is judged:
 * the command has not run. Without it, a call of 60 unreadable deletes asked the same `git status`
 * and walked the same 2,100 directories 60 times (six seconds; a hundred went over the budget).
 */
function once(ctx, key, ask) {
  if (!ctx.memo) return ask();
  if (!ctx.memo.has(key)) ctx.memo.set(key, ask());
  return ctx.memo.get(key);
}

const statusOf = (repo, paths, ctx) => once(ctx, `status\0${repo.config.join("\0")}\0${repo.top}\0${paths.join("\0")}`, () => status(repo, paths, ctx.signal));
const linksOf = (repo, paths, ctx) => once(ctx, `links\0${repo.config.join("\0")}\0${repo.top}\0${paths.join("\0")}`, () => gitlinks(repo, paths, ctx.signal));
const gitOnce = (repo, args, ctx) => once(ctx, `git\0${repo.config.join("\0")}\0${repo.top}\0${args.join("\0")}`, () => runGit(repo, args, ctx.signal));

/**
 * The repository holding `dir`, as git sees it from there. With `climb`, a directory whose own
 * `.git` git will not open (not a gitfile, or one pointing nowhere) is asked about from its parent:
 * git refuses to run in it, and the repository around it lists the files inside as its own
 * untracked work (driven, git 2.47). A delete aimed straight at one was silent.
 *
 * @param {{ location?: string[], climb?: boolean }} [how]
 */
function repoAt(dir, ctx, { location = [], climb = false } = {}) {
  return once(ctx, `repo\0${climb}\0${location.join("\0")}\0${dir}`, async () => {
    const refused = climb && location.length === 0 && existsNoFollow(join(dir, ".git"));
    try {
      const repo = await repositoryOf(dir, ctx.signal, location);
      if (repo || !refused) return repo;
    } catch (err) {
      if (!refused || !(err instanceof ProbeFailed) || !/invalid gitfile format/i.test(err.message)) throw err;
    }
    const up = dirname(dir);
    return up === dir ? null : repoAt(up, ctx, { climb });
  });
}

/**
 * Judge where the command runs, for a target this guard cannot read. The uncommitted work there is
 * what an unreadable delete could reach. The repository's commits are not counted: nothing here
 * names `.git`, and a clean repository with local commits must not be told they are at risk.
 */
export function whereItRuns(what, ctx) {
  const base = realOrSelf(ctx.base);
  // The answer depends on the place and on what earlier saves put in git's keeping, nothing else.
  const saves = relevantSaves(ctx).map((b) => `${b.base}\u0001${b.argv.join("\u0001")}`).join("\u0002");
  return once(ctx, `where\0${base}\0${what}\0${ctx.agentId}\0${saves}`, () => judgePaths([base], "any", what, ctx, { history: false }));
}

/**
 * What deleting `targets` loses, repository by repository.
 *
 * @param {{ history?: boolean }} [options] history: false leaves commits and the stash uncounted
 */
async function judgePaths(targets, mode, what, ctx, { history: countHistory = true } = {}) {
  /** @type {Map<string, { repo: Repo, paths: string[] }>} */
  const byRepo = new Map();
  const known = [];
  for (const target of targets) {
    // A `.git` directory, and anything inside one, is asked about from the work tree it belongs
    // to: inside `.git`, git has no work tree to answer from.
    const holder = gitData(target)?.tree;
    const dir = holder ?? (basename(target) === ".git" || !isRealDirectory(target) ? dirname(target) : target);
    let repo = await repoFor(dir, known, ctx);
    let judged = target;
    if (!repo) {
      // A target above every repository (`rm -rf ~/projects` from inside one): the repository this
      // command runs in is knowable, and lies under it. Other repositories below are not walked.
      const here = await repoFor(realOrSelf(ctx.base), known, ctx);
      const real = realOrSelf(target);
      if (!here || !(realOrSelf(here.top) === real || realOrSelf(here.top).startsWith(real + sep))) continue;
      repo = here;
      judged = here.top;
    }
    if (!byRepo.has(repo.top)) byRepo.set(repo.top, { repo, paths: [] });
    byRepo.get(repo.top).paths.push(judged);
  }
  const lost = [];
  const history = [];
  const nested = new Set();
  // One git directory holds one history, however many work trees share it (a linked worktree
  // and its main tree): it is counted once.
  const counted = new Set();
  const first = (repo) => !counted.has(realOrSelf(repo.common)) && counted.add(realOrSelf(repo.common));
  for (const { repo, paths } of byRepo.values()) {
    // git status never lists what is inside `.git`, so git's own data is named here.
    const internals = paths.map((p) => gitData(p)).filter((d) => d !== null && d.guarded);
    if (internals.length) history.push(ownData(internals));
    // A repository deleted by name is named as one found below the target is: from the repository
    // this command runs in, when it lies inside it (`build/sub/x.txt`, `1 commit … in build/sub`).
    const prefix = await namedFrom(repo, ctx);
    for (const item of await lostUnder(repo, paths.filter((p) => !gitData(p)), mode, ctx, { honourSaved: true, nested })) lost.push(join(prefix, item));
    if (countHistory && mode === "any" && paths.some((p) => takesHistory(p, repo)) && first(repo)) {
      for (const item of await historyLost(repo, ctx)) history.push(prefix ? `${item} in ${prefix}` : item);
    }
  }
  // A repository inside a target goes with it, and the status above said nothing about it.
  const walk = await nestedRepositories(targets, [...byRepo.values()], ctx, nested);
  for (const { repo, name } of walk.found) {
    for (const item of (await lostUnder(repo, [repo.top], mode, ctx)).map((path) => join(name, path))) lost.push(item);
    if (countHistory && mode === "any" && targets.some((t) => takesHistory(t, repo)) && first(repo)) {
      for (const item of (await historyLost(repo, ctx)).map((held) => `${held} in ${name}`)) history.push(item);
    }
  }
  return shape(what, lost, ctx, history, walk.stopped);
}

/**
 * Where `repo`'s paths are named from, as a prefix: "" for the repository this command runs in and
 * for any outside it, else the repository's directory from that one's top.
 */
async function namedFrom(repo, ctx) {
  const here = await repoAt(realOrSelf(ctx.base), ctx, { climb: true }).catch(() => null);
  if (!here) return "";
  const top = realOrSelf(repo.top);
  const outer = realOrSelf(here.top);
  return top !== outer && top.startsWith(outer + sep) ? relative(outer, top) : "";
}

/**
 * The repositories inside `targets`: a submodule, a clone in an ignored directory, another
 * repository below a directory above this one. The status of the repository around them says
 * nothing about the work inside, so each is found here and read as the repository it is, under
 * its own config (git.mjs pins that per repository).
 *
 * Submodules come from the index of each repository in `holders`, at any depth. Every other one
 * comes from a walk below each target, nearest first, that lists MAX_WALKED directories or reads
 * MAX_ENTRIES entries, whichever comes first, and stops (documented limit). Symlinks are not
 * followed: a delete does not follow them either.
 *
 * @param {string[]} targets absolute paths a command deletes
 * @param {Array<{ repo: Repo, paths: string[] }>} holders the repositories already judged
 * @param {Context} ctx
 * @returns {Promise<{ found: Array<{ repo: Repo, name: string }>, stopped: boolean }>} `name` is the
 *   repository's directory as a reason spells it: from the repository around it, else from the target
 *   above it. `stopped` when the walk reached its limit before the last directory.
 */
async function nestedRepositories(targets, holders, ctx, nested = new Set()) {
  const dirs = new Set(nested);
  for (const { repo, paths } of holders) {
    const rel = paths.map((p) => inside(repo.top, p)).filter((r) => r !== null);
    // A submodule whose directory is gone has no work tree to lose, and git cannot be run in it.
    for (const link of await linksOf(repo, rel, ctx)) if (isRealDirectory(join(repo.top, link))) dirs.add(realOrSelf(join(repo.top, link)));
  }
  const roots = targets.filter(isRealDirectory).map(realOrSelf);
  const walked = await once(ctx, `walk\0${roots.join("\0")}`, async () => walkForGit(roots));
  for (const dir of walked.git) dirs.add(dir);
  const tops = holders.map((h) => realOrSelf(h.repo.top));
  const above = targets.map(realOrSelf);
  for (const top of [...tops, ...above]) dirs.delete(top); // a holder is judged already; a target that is a repository was its own holder
  if (dirs.size > MAX_NESTED) throw new ProbeFailed(`more than ${MAX_NESTED} repositories below the target, and this guard reads ${MAX_NESTED}`);
  const found = [];
  for (const dir of dirs) {
    const repo = await repoAt(dir, ctx, { climb: true });
    // A submodule that was never checked out, or a stray `.git`: the directory belongs to the
    // repository around it, whose status has spoken for it.
    if (!repo || realOrSelf(repo.top) !== dir) continue;
    const nearest = (roots) => roots.filter((top) => dir.startsWith(top + sep)).sort((a, b) => b.length - a.length)[0];
    const from = nearest(tops) ?? nearest(above);
    const prefix = from && tops.includes(from) ? await namedFrom(holders.find((h) => realOrSelf(h.repo.top) === from).repo, ctx) : "";
    found.push({ repo, name: from ? join(prefix, relative(from, dir)) : dir });
  }
  return { found, stopped: walked.stopped };
}

/**
 * The directories below `roots` that hold a `.git`, walked by depth, and within one depth in listing
 * order, until MAX_WALKED directories are listed or MAX_ENTRIES entries read. `stopped` when that
 * limit came first.
 */
function walkForGit(roots) {
  const git = [];
  let queue = roots;
  let budget = MAX_ENTRIES;
  let walked = 0;
  while (queue.length > 0) {
    const below = [];
    for (const dir of queue) {
      // A directory still queued, or entries still unread in the last one: the walk stopped short.
      if (walked >= MAX_WALKED) return { git, stopped: true };
      walked += 1;
      const listed = listDirectories(dir, budget);
      budget -= listed.read;
      if (listed.git) git.push(dir);
      if (budget <= 0) return { git, stopped: true };
      for (const item of listed.dirs) below.push(item); // every one was an entry the budget paid for, so the queue is bounded too
    }
    queue = below;
  }
  return { git, stopped: false };
}

/**
 * The repository holding `dir`. A directory under one already found reuses it without asking
 * git again, unless a `.git` sits between them (a nested repository or submodule): deleting
 * `node_modules/*` must not cost two git calls per package.
 */
async function repoFor(dir, known, ctx) {
  if (!isDirectory(dir)) return null;
  const real = realOrSelf(dir);
  for (const repo of known) {
    const top = realOrSelf(repo.top);
    if (real !== top && !real.startsWith(top + sep)) continue;
    let nested = false;
    for (let p = real; p !== top && p !== dirname(p); p = dirname(p)) {
      if (existsNoFollow(join(p, ".git"))) nested = true;
    }
    if (!nested) return repo;
  }
  const repo = await repoAt(dir, ctx, { climb: true });
  if (repo && !known.some((k) => k.top === repo.top)) known.push(repo);
  return repo;
}

function existsNoFollow(path) {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

// Inside `.git`, files that git recreates or that only record the last operation. Deleting a
// stale `index.lock` is the everyday fix for "index.lock: File exists", and a stale ref lock
// (`refs/heads/main.lock`) is the same fix one level down.
const DISPOSABLE = /^(?:FETCH_HEAD|ORIG_HEAD|COMMIT_EDITMSG|gc\.log)$/;

/** "git's own data (.git/index)", naming the first few. */
function ownData(found) {
  const more = found.length > NAMED ? ` and ${found.length - NAMED} more` : "";
  return `git's own data (${found.slice(0, NAMED).map((d) => d.name).join(", ")}${more})`;
}

/**
 * For a path strictly inside a `.git` directory: the work tree that holds it, its name from
 * there (`.git/index`), and whether deleting it loses anything. Null for every other path.
 */
function gitData(path) {
  const parts = path.split(sep);
  const at = parts.lastIndexOf(".git", parts.length - 2);
  if (at < 1) return null;
  return {
    tree: parts.slice(0, at).join(sep) || sep,
    name: parts.slice(at).join("/"),
    guarded: !(parts.at(-1).endsWith(".lock") || (parts.length === at + 2 && DISPOSABLE.test(parts[at + 1]))),
  };
}

/**
 * Deleting the git directory that holds the commits, or anything above it, destroys commits
 * that exist nowhere else. A linked worktree's commits live in its main tree's `.git`, so
 * deleting the worktree loses its uncommitted work and no history.
 */
function takesHistory(target, repo) {
  const real = realOrSelf(target);
  const common = realOrSelf(repo.common);
  return common === real || common.startsWith(real + sep);
}

/** What only this clone holds: commits on no remote, and the stash. */
async function historyLost(repo, ctx) {
  const out = [];
  // Every ref, so a commit made on a detached HEAD or kept only by a tag counts, but not
  // refs/stash, which is named on its own below and would otherwise be counted twice.
  const count = ["rev-list", "--count", "--exclude=refs/stash", "--all", "--not", "--remotes"];
  const unpushed = Number((await gitOnce(repo, count, ctx)).toString().trim());
  if (unpushed > 0) out.push(`${unpushed} commit${unpushed === 1 ? "" : "s"} on no remote`);
  if ((await gitOnce(repo, ["stash", "list"], ctx)).toString().trim()) out.push("the stash");
  return out;
}

async function lostVerdict(repo, targets, mode, what, ctx) {
  return shape(what, await lostUnder(repo, targets, mode, ctx), ctx);
}

/**
 * The dirty paths under `targets` that `mode` loses. `honourSaved` drops what a `git add` or
 * `git stash` earlier in the call has already put in git's keeping, for a delete; a command that
 * itself throws the saved copy away (`git stash drop`) passes false.
 */
async function lostUnder(repo, targets, mode, ctx, { honourSaved = false, nested = null } = {}) {
  const rel = targets.map((t) => inside(repo.top, t)).filter((r) => r !== null);
  const entries = withoutRepositories(repo, await statusOf(repo, rel, ctx), nested);
  const saved = honourSaved ? savedEarlier(ctx, repo) : null;
  return entries
    .filter(([xy, path]) => LOSES[mode](xy) && !saved?.keeps(xy, join(repo.top, path)))
    .map(([, path]) => path);
}

/**
 * `entries` without the untracked directories that are repositories themselves. git lists one as
 * `?? dir/` and never looks inside: it is not a loss by that name, and it is read as the repository
 * it is. Each such root is added to `nested`, so it is read however far the walk would have to go.
 */
function withoutRepositories(repo, entries, nested) {
  return entries.filter(([xy, path]) => {
    if (xy !== "??" || !path.endsWith("/") || !existsNoFollow(join(repo.top, path, ".git"))) return true;
    nested?.add(realOrSelf(join(repo.top, path)));
    return false;
  });
}

/**
 * What a `git add` or `git stash push` earlier in the same Bash call has put in git's keeping.
 * Their bytes then reach the object store before a later command runs, so:
 *   * `keeps(xy, path)`: a later `rm` loses nothing there (the index or the stash holds it);
 *   * `any`: a later `reset --hard`, `rm -f`, `switch` or `read-tree -u` deletes files that were
 *     untracked a moment ago and are staged now, whose bytes survive only as nameless blobs
 *     (`git fsck --lost-found`), so those count as losses too.
 * The paths an add names are read from where this command runs, which is where it usually ran.
 *
 * @param {Context} ctx
 * @param {Repo} repo
 */
function savedEarlier(ctx, repo) {
  const added = [];
  const stashed = [];
  for (const { argv, base } of relevantSaves(ctx)) {
    let i = 1;
    while (i < argv.length && argv[i].startsWith("-")) i += GIT_VALUED.has(argv[i]) ? 2 : 1;
    const sub = argv[i];
    const rest = argv.slice(i + 1);
    const operands = rest.filter((w) => !w.startsWith("-"));
    if (sub === "add") {
      const all = rest.some((w) => w === "-A" || w === "--all") || operands.some((w) => w === "." || w === ":/");
      for (const item of (all ? [repo.top] : operands.flatMap((w) => absolute(base, w)))) added.push(item);
    } else if (sub === "stash" && isStashPush(argv)) {
      const untracked = rest.some((w) => w === "-u" || w === "--include-untracked" || w === "-a" || w === "--all");
      const dash = rest.indexOf("--");
      const specs = dash >= 0 ? rest.slice(dash + 1).flatMap((w) => absolute(base, w)) : [repo.top];
      for (const item of specs.map((path) => ({ path, untracked }))) stashed.push(item);
    }
  }
  const under = (path, root) => path === root || path.startsWith(root + sep);
  return {
    any: added.length > 0,
    keeps: (xy, path) =>
      added.some((root) => under(path, root)) ||
      stashed.some((st) => under(path, st.path) && (xy !== "??" || st.untracked)),
  };
}

/**
 * The earlier git commands a save may be read from: only one that certainly ran and finished, in a
 * place this guard knows. One in this command's own pipeline is still running.
 */
function relevantSaves(ctx) {
  return (ctx.before ?? []).filter(
    ({ argv, certain, base, pipelines = [] }) =>
      certain && base !== null && basename(argv[0] ?? "") === "git" && !pipelines.some((p) => (ctx.pipelines ?? []).some((q) => racing(p, q))),
  );
}

/** Two stages (`<pipeline>:<stage>`) of one pipeline, which run at the same time. */
function racing(a, b) {
  const cut = (stage) => [stage.slice(0, stage.lastIndexOf(":")), stage.slice(stage.lastIndexOf(":") + 1)];
  const [pipeA, stageA] = cut(a);
  const [pipeB, stageB] = cut(b);
  return pipeA === pipeB && stageA !== stageB;
}

/** The untracked directories under `dir`, as `path/` relative to the top (git's default listing). */
async function untrackedDirs(repo, dir, ctx) {
  const rel = inside(repo.top, dir);
  if (rel === null) return [];
  const out = await gitOnce(repo, ["--literal-pathspecs", "status", "--porcelain=v1", "-z", "--untracked-files=normal", "--", rel], ctx);
  return out
    .toString("utf8")
    .split("\0")
    .filter((e) => e.startsWith("?? ") && e.endsWith("/"))
    .map((e) => e.slice(3));
}

/** A linked worktree whose last path component is `name`, when exactly one is. */
async function worktreeNamed(repo, name, ctx) {
  const out = (await gitOnce(repo, ["worktree", "list", "--porcelain"], ctx)).toString("utf8");
  const found = out.split("\n").filter((l) => l.startsWith("worktree ") && basename(l.slice(9)) === name);
  return found.length === 1 ? found[0].slice(9) : null;
}

/**
 * The verdict for what would be lost, or null when nothing would. `history` (commits on no
 * remote, the stash) is named first and never cut short. It is the loss nobody can rebuild.
 *
 * @param {string} what
 * @param {string[]} lost paths, relative to their work tree
 * @param {Context} ctx
 * @param {string[]} [history]
 * @returns {Verdict | null}
 */
function shape(what, lost, ctx, history = [], stopped = false) {
  lost = [...new Set(lost)];
  history = [...new Set(history)];
  if (lost.length === 0 && history.length === 0) return null;
  const verdict = shapeReason(`${what} would destroy`, [{ lost, history }], ctx.agentId);
  return { ...verdict, reason: verdict.reason + (stopped ? STOPPED : ""), loss: { what, lost, history, stopped } };
}

// A repository further down than the walk reached is not in the list: the list may be short.
const STOPPED = ` The search for repositories inside the target reached its limit (${MAX_WALKED} directories, ${MAX_ENTRIES} entries); any further down were not read.`;

/**
 * One verdict for a whole Bash call from each command's: a reason that names every loss, grouped
 * by the command that causes it.
 *
 * @param {Verdict[]} verdicts
 * @param {string} agentId
 * @returns {Verdict | null}
 */
export function merged(verdicts, agentId) {
  const withLoss = verdicts.filter((v) => v?.loss);
  if (withLoss.length !== verdicts.length || verdicts.length <= 1) return verdicts[0] ?? null;
  /** @type {Map<string, { lost: Set<string>, history: Set<string> }>} */
  const byWhat = new Map();
  for (const { loss } of withLoss) {
    if (!byWhat.has(loss.what)) byWhat.set(loss.what, { lost: new Set(), history: new Set() });
    const into = byWhat.get(loss.what);
    for (const p of loss.lost) into.lost.add(p);
    for (const h of loss.history) into.history.add(h);
  }
  const parts = [...byWhat].map(([what, l]) => ({ what, lost: [...l.lost], history: [...l.history] }));
  const stopped = withLoss.some(({ loss }) => loss.stopped);
  if (parts.length === 1) return shape(parts[0].what, parts[0].lost, { agentId }, parts[0].history, stopped);
  const verdict = shapeReason("this command would destroy", parts, agentId);
  return stopped ? { ...verdict, reason: verdict.reason + STOPPED } : verdict;
}

/** The ask or deny text for one or more losses. */
function shapeReason(lead, parts, agentId) {
  const described = parts.map((part) => (part.what ? `${part.what}: ${listing(part)}` : listing(part)));
  const listed = described.join("; ");
  if (agentId) {
    return {
      decision: "deny",
      reason:
        `RECOVERABLE: ${lead} work that is not yours: ${listed}. Git cannot give ` +
        "it back. Other untracked and uncommitted work in this repository belongs to the main " +
        "session: do not delete, revert, stash or clean anything you did not create. Leave it " +
        "as it is and report what you found.",
    };
  }
  return { decision: "ask", reason: `RECOVERABLE: ${lead} work git cannot give back: ${listed}.` };
}

function listing({ lost, history }) {
  const files = lost.length
    ? lost.slice(0, NAMED).join(", ") +
      (lost.length > NAMED ? ` and ${lost.length - NAMED} more` : "") +
      ` (${lost.length} path${lost.length === 1 ? "" : "s"}, untracked or edited and uncommitted)`
    : "";
  const items = [...history, files].filter(Boolean);
  return items.length > 1 ? `${items.slice(0, -1).join(", ")}, and ${items.at(-1)}` : items[0];
}
