// RECOVERABLE's judges. Each takes ONE command, already found and unwrapped by the dispatcher,
// and answers one question by asking git: would running this destroy something git cannot
// give back?
//
// That question has no spellings. A command either destroys bytes that never reached git's
// object store (untracked, not-ignored files. Uncommitted edits) or it does not, and git says
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
//   * `ctx.before` is the argv of every command that runs earlier in the same Bash call.
//   * `ctx.prefix` is the command's own `NAME=value` prefix (the listing's `prefix`), so
//     `GIT_DIR=… git clean -fd` is judged in the repository it names. Optional.

import { readFile } from "node:fs/promises";
import { basename, dirname, join, sep } from "node:path";

import { FIND, FIND_TIMEOUT_MS, ProbeFailed, configBool, git as runGit, repositoryOf, run, status } from "./git.mjs";
import { absolute, exists, inside, isDirectory, isRealDirectory, realOrSelf } from "./paths.mjs";

/**
 * @typedef {import("../runner.mjs").Verdict} Verdict
 * @typedef {{ top: string, config: string[] }} Repo
 * @typedef {object} Context
 * @property {string} base the directory the command runs in
 * @property {string} agentId "" on the main thread
 * @property {(word: string) => { text: string, unknown: boolean }} resolve
 * @property {string[][]} before
 * @property {Array<[string, string]>} [prefix]
 * @property {AbortSignal} [signal]
 */

export { ProbeFailed };

const NAMED = 4; // victims quoted by name in a reason
const MAX_VICTIMS = 250_000; // a dry run naming more falls back to the stricter whole-root check
const MAX_LIST_BYTES = 1_000_000; // an xargs input file larger than this is judged by where it runs
const RM_LIKE = new Set(["rm", "unlink", "shred"]);
const FIND_EXEC = new Set(["-exec", "-execdir", "-ok", "-okdir"]);
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
 * `rm` / `unlink` / `shred` with operands on the command line. Deleting ONE file on the main thread
 * is everyday scratch cleanup and is left alone. A recursive delete, a delete of several files,
 * and every delete a subagent makes are judged.
 *
 * @param {string[]} argv
 * @param {Context} ctx
 * @returns {Promise<Verdict | null>}
 */
export async function rm(argv, ctx) {
  const { flags, operands } = splitOperands(argv.slice(1));
  const recursive = flags.some((f) => f === "--recursive" || (!f.startsWith("--") && /[rR]/.test(f)));
  if (!recursive && !ctx.agentId && operands.length <= 1) return null;
  if (operands.length === 0) return null;
  return judgeOperands(operands, "any", `\`${basename(argv[0])}\``, ctx);
}

/**
 * An `rm` whose operands arrive on stdin through `xargs`. `feed` says where they come from:
 * a printing `find` (dry-run exactly as written), a file (`xargs -a list`, `< list`), or
 * something this guard cannot read.
 *
 * @param {string[]} argv the rm, with any xargs replacement token already removed
 * @param {{ kind: "find", argv: string[] } | { kind: "file", path: string } | { kind: "unknown" }} feed
 * @param {Context} ctx
 */
export async function pipeFedRm(argv, feed, ctx) {
  const what = "a pipe-fed `rm`";
  const { operands } = splitOperands(argv.slice(1));
  const fixed = operands.length ? await judgeOperands(operands, "any", what, ctx) : null;
  if (fixed) return fixed;

  if (feed.kind === "file") {
    const listed = await readList(ctx.resolve(feed.path), ctx.base);
    // xargs splits and unquotes its input its own way. A line that names nothing on disk as
    // read here (a quoted name, say) is a victim this guard cannot see: judge where it runs.
    const unseen = listed?.some((line) => !absolute(ctx.base, line).some(exists));
    if (listed && !unseen) return judgeOperands(listed, "any", `${what} (fed from ${basename(feed.path)})`, ctx);
  }
  if (feed.kind === "find") {
    const verdict = await printingFind(feed.argv, what, ctx);
    if (verdict !== undefined) return verdict;
  }
  return whereItRuns(`${what} (its input cannot be read)`, ctx);
}

async function readList(resolved, base) {
  if (resolved.unknown) return null;
  const [path] = absolute(base, resolved.text);
  try {
    const text = await readFile(path, "utf8");
    if (text.length > MAX_LIST_BYTES) return null;
    return text.split("\n").map((line) => line.trim()).filter(Boolean);
  } catch {
    return null;
  }
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
  if (resolved.some((r) => r.unknown)) return whereItRuns(what, ctx);
  const roots = findRoots(tokens).flatMap((r) => absolute(ctx.base, r)).filter(exists);
  const victims = await dryRun(simulated(withoutOutputs(tokens)), ctx);
  if (victims === null) return judgePaths(roots, "any", what, ctx); // stricter, never looser
  return sweepVerdict(roots, victims, what, ctx);
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
  return names.map((n) => absolute(ctx.base, n)[0]);
}

/** A `find` that only prints (xargs' feeder) dry-run as written, since it writes nothing. */
async function printingFind(argv, what, ctx) {
  const resolved = argv.map((w) => ctx.resolve(w));
  if (resolved.some((r) => r.unknown)) return undefined;
  const tokens = resolved.map((r) => r.text);
  const unsafe = tokens.some((t) => FIND_EXEC.has(t) || FIND_WRITES.has(t) || t === "-delete");
  if (unsafe || !FIND) return undefined;
  const args = [...withoutOutputs(tokens.slice(1)), "-print0"];
  const roots = findRoots(tokens).flatMap((r) => absolute(ctx.base, r)).filter(exists);
  const victims = await dryRun(args, ctx);
  if (victims === null) return judgePaths(roots, "any", what, ctx);
  return sweepVerdict(roots, victims, what, ctx);
}

/**
 * What a sweep rooted at each root would destroy. One `git status` per root and string
 * arithmetic for the rest: a dirty path is lost when it, or a directory above it, is a victim.
 * (Handing git every victim as a pathspec cost seconds on a real tree.)
 */
async function sweepVerdict(roots, victims, what, ctx) {
  const lost = [];
  const named = new Set(victims);
  for (const root of roots) {
    const repo = await repositoryOf(isRealDirectory(root) ? root : dirname(root), ctx.signal);
    if (!repo) continue;
    const relRoot = inside(repo.top, root);
    if (relRoot === null) continue;
    if (named.has(root)) {
      lost.push(...(await lostUnder(repo, [root], "any", ctx)));
      continue;
    }
    for (const [xy, path] of await status(repo, [relRoot], ctx.signal)) {
      if (!LOSES.any(xy)) continue;
      const abs = join(repo.top, path);
      if (selfAndParents(abs).some((p) => named.has(p))) lost.push(path);
    }
  }
  return shape(what, lost, ctx);
}

function selfAndParents(path) {
  const out = [];
  for (let p = path; p !== dirname(p); p = dirname(p)) out.push(p);
  return out;
}

// ─── git ────────────────────────────────────────────────────────────────────────────────

// The subcommands that can discard work. Everything else passes untouched.
const DISCARDING = new Set(["checkout", "restore", "switch", "checkout-index", "clean", "rm", "reset", "stash"]);
const GIT_VALUED = new Set(["-C", "-c", "--config-env", "--git-dir", "--work-tree", "--namespace", "--exec-path"]);
const UNSEEN = "\0"; // a setting whose value this guard cannot read
const LOCATION_ENV = { GIT_DIR: "--git-dir", GIT_WORK_TREE: "--work-tree" };

/**
 * The git subcommands that discard work: checkout, restore, switch, checkout-index, clean,
 * rm, reset --hard, stash drop / clear.
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
  // `git checkout -- $(git diff --name-only)`, `git -C $UNSET reset --hard`: a word this guard
  // cannot read is not a word that names nothing. Judge where it runs, as rm and find do.
  if ([...resolved, ...location.values()].some((r) => r.unknown)) {
    return whereItRuns(`\`git ${sub}\` with a word this guard cannot read`, ctx);
  }
  const args = words.slice(i + 1);
  if (!isDirectory(dir)) return null;
  // git resolves pathspecs from the real directory it runs in, not a symlink's spelling of it.
  dir = realOrSelf(dir);
  const where = [...location].map(([option, value]) => `${option}=${absolute(dir, value.text)[0]}`);
  const repo = await repositoryOf(dir, ctx.signal, where);
  if (!repo) return null;
  // Run from outside the work tree `--work-tree` names, git reads pathspecs from its top.
  const base = inside(repo.top, dir) === null ? repo.top : dir;
  const at = { ...ctx, base };
  const { flags, operands, paths: named, others, magic } = pathArgs(args, base, VALUED[sub] ?? new Set());
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

    case "switch":
      if (!has("--discard-changes") && !has("--force", "f")) return null;
      return lostVerdict(repo, [repo.top], "tracked", "`git switch` discarding changes", at);

    case "checkout-index": {
      if (!has("--force", "f")) return null; // without -f it never overwrites an existing file
      const targets = has("--all", "a") ? [repo.top] : paths;
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
      return lostVerdict(repo, paths.length ? paths : [base], "untracked", "`git clean`", at);
    }

    case "rm":
      if (has("--cached") || !has("--force", "f") || paths.length === 0) return null; // plain git rm refuses to lose edits
      return lostVerdict(repo, paths, "tracked", "`git rm --force`", at);

    case "reset":
      if (!args.includes("--hard")) return null;
      return lostVerdict(repo, [repo.top], "tracked", "`git reset --hard`", at);

    case "stash": {
      const action = operands[0];
      if (action !== "drop" && action !== "clear") return null;
      const listed = await statusOfStash(repo, ctx);
      if (listed) return shape(`\`git stash ${action}\``, ["the stash (it is not empty)"], at);
      // Empty now, but if this same command stashes first, the dirt is what gets dropped.
      const stashesFirst = ctx.before.some((b) => basename(b[0] ?? "") === "git" && isStashPush(b));
      return stashesFirst ? lostVerdict(repo, [repo.top], "any", `\`git stash ${action}\` after a stash`, at) : null;
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
  const out = await runGit(repo, ["stash", "list"], ctx.signal);
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
      paths.push(...absolute(dir, a));
    } else if (a === "--") {
      literal = true;
    } else if (a.startsWith("-")) {
      flags.push(a);
      if (valued.has(a)) i += 1;
    } else {
      operands.push(a);
      const found = absolute(dir, a).filter(exists);
      if (found.length) paths.push(...found);
      else others.push(a);
    }
  }
  return { flags, operands, paths, others, magic };
}

// ─── Asking git, and shaping the answer ─────────────────────────────────────────────────

/** Judge where the command runs, for a target this guard cannot read. */
export function whereItRuns(what, ctx) {
  return judgePaths([realOrSelf(ctx.base)], "any", what, ctx);
}

async function judgeOperands(operands, mode, what, ctx) {
  const resolved = operands.map((op) => ctx.resolve(op));
  // `$UNSET/wip`, `{a,b}`, `$(cmd)`: not a path this guard can read. Absence of a readable
  // target is not evidence of a harmless one, so the question moves to where it runs.
  if (resolved.some((r) => r.unknown)) return whereItRuns(`${what} of a target this guard cannot read`, ctx);
  const targets = resolved.flatMap((r) => absolute(ctx.base, r.text)).filter(exists);
  return judgePaths(targets, mode, what, ctx);
}

async function judgePaths(targets, mode, what, ctx) {
  /** @type {Map<string, { repo: Repo, paths: string[] }>} */
  const byRepo = new Map();
  const repoOfDir = new Map();
  for (const target of targets) {
    // A `.git` directory is asked about from the work tree it belongs to.
    const dir = basename(target) === ".git" || !isRealDirectory(target) ? dirname(target) : target;
    if (!repoOfDir.has(dir)) repoOfDir.set(dir, isDirectory(dir) ? await repositoryOf(dir, ctx.signal) : null);
    const repo = repoOfDir.get(dir);
    if (!repo) continue;
    if (!byRepo.has(repo.top)) byRepo.set(repo.top, { repo, paths: [] });
    byRepo.get(repo.top).paths.push(target);
  }
  const lost = [];
  const history = [];
  for (const { repo, paths } of byRepo.values()) {
    lost.push(...(await lostUnder(repo, paths, mode, ctx)));
    if (mode === "any" && paths.some((p) => takesHistory(p, repo.top))) history.push(...(await historyLost(repo, ctx)));
  }
  return shape(what, lost, ctx, history);
}

/** Deleting the work tree or its `.git` destroys commits that exist nowhere else, too. */
function takesHistory(target, top) {
  const real = realOrSelf(target);
  const realTop = realOrSelf(top);
  return real === realTop || real === join(realTop, ".git") || realTop.startsWith(real + sep);
}

/** What only this clone holds: commits on no remote, and the stash. */
async function historyLost(repo, ctx) {
  const out = [];
  // Every ref, so a commit made on a detached HEAD or kept only by a tag counts, but not
  // refs/stash, which is named on its own below and would otherwise be counted twice.
  const count = ["rev-list", "--count", "--exclude=refs/stash", "--all", "--not", "--remotes"];
  const unpushed = Number((await runGit(repo, count, ctx.signal)).toString().trim());
  if (unpushed > 0) out.push(`${unpushed} commit${unpushed === 1 ? "" : "s"} on no remote`);
  if ((await runGit(repo, ["stash", "list"], ctx.signal)).toString().trim()) out.push("the stash");
  return out;
}

async function lostVerdict(repo, targets, mode, what, ctx) {
  return shape(what, await lostUnder(repo, targets, mode, ctx), ctx);
}

async function lostUnder(repo, targets, mode, ctx) {
  const rel = targets.map((t) => inside(repo.top, t)).filter((r) => r !== null);
  const entries = await status(repo, rel, ctx.signal);
  return entries.filter(([xy]) => LOSES[mode](xy)).map(([, path]) => path);
}

function splitOperands(args) {
  const flags = [];
  const operands = [];
  let literal = false;
  for (const a of args) {
    if (literal || !a.startsWith("-") || a === "-") operands.push(a);
    else if (a === "--") literal = true;
    else flags.push(a);
  }
  return { flags, operands };
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
function shape(what, lost, ctx, history = []) {
  if (lost.length === 0 && history.length === 0) return null;
  const files = lost.length
    ? lost.slice(0, NAMED).join(", ") +
      (lost.length > NAMED ? ` and ${lost.length - NAMED} more` : "") +
      ` (${lost.length} path${lost.length === 1 ? "" : "s"}, untracked or edited and uncommitted)`
    : "";
  const items = [...history, files].filter(Boolean);
  const listed = items.length > 1 ? `${items.slice(0, -1).join(", ")}, and ${items.at(-1)}` : items[0];
  if (ctx.agentId) {
    return {
      decision: "deny",
      reason:
        `RECOVERABLE: ${what} would destroy work that is not yours: ${listed}. Git cannot give ` +
        "it back. Other untracked and uncommitted work in this repository belongs to the main " +
        "session: do not delete, revert, stash or clean anything you did not create. Leave it " +
        "as it is and report what you found.",
    };
  }
  return { decision: "ask", reason: `RECOVERABLE: ${what} would destroy work git cannot give back: ${listed}.` };
}
