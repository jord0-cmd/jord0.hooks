// RECOVERABLE's judges. Each takes ONE command, already found and unwrapped by the dispatcher,
// and answers one question by asking git: would running this destroy something git cannot
// give back?
//
// That question has no spellings. A command either destroys bytes that never reached git's
// object store (untracked, not-ignored files; uncommitted edits) or it does not, and git says
// which. Ignored files (`node_modules`, `build/`, `*.pyc`) and clean tracked files are silent
// by construction: a rebuild or a checkout gives those back.
//
//   main thread  -> ask, naming what would be lost (you do delete your own scratch work)
//   subagent     -> deny, saying whose it is (the agent that caused this repo's first rule
//                   read the orchestrator's untracked project as clutter and deleted it)
//
// Contract with the dispatcher (lib/recoverable/dispatch.mjs):
//   * `argv` is the command as listed, with every wrapper word already removed, so argv[0] is
//     the program that really runs; inside a `find`, each -exec clause starts with the program
//     it really runs, too.
//   * `ctx.resolve(word)` expands a word with everything the dispatcher knows at that point
//     (cwd, variables set earlier) and says whether it still depends on run time.
//   * `ctx.before` is the argv of every command that runs earlier in the same Bash call.

import { readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import { FIND, FIND_TIMEOUT_MS, ProbeFailed, git as runGit, repositoryOf, run, status } from "./git.mjs";
import { absolute, exists, inside, isRealDirectory } from "./paths.mjs";

/**
 * @typedef {import("../runner.mjs").Verdict} Verdict
 * @typedef {{ top: string, env: Record<string, string> }} Repo
 * @typedef {object} Context
 * @property {string} base the directory the command runs in
 * @property {string} agentId "" on the main thread
 * @property {(word: string) => { text: string, unknown: boolean }} resolve
 * @property {string[][]} before
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

// Which dirty entries each kind of destruction loses, from git's porcelain XY code.
const LOSES = {
  // deleting: untracked files and every uncommitted edit, staged or not
  any: (xy) => xy === "??" || "MTARC".includes(xy[0]) || "MT".includes(xy[1]),
  // restoring from the index: unstaged edits only; a staged edit survives
  worktree: (xy) => "MT".includes(xy[1]),
  // restoring from a commit: every uncommitted edit to a tracked file
  tracked: (xy) => xy !== "??" && ("MTARC".includes(xy[0]) || "MT".includes(xy[1])),
  // git clean
  untracked: (xy) => xy === "??",
};

// ─── rm ─────────────────────────────────────────────────────────────────────────────────

/**
 * `rm` / `unlink` / `shred` with operands on the command line. A single-file delete on the main
 * thread is everyday work and is left alone; recursive deletes, and every delete a subagent
 * makes, are asked about.
 *
 * @param {string[]} argv
 * @param {Context} ctx
 * @returns {Promise<Verdict | null>}
 */
export async function rm(argv, ctx) {
  const { flags, operands } = splitOperands(argv.slice(1));
  const recursive = flags.some((f) => f === "--recursive" || (!f.startsWith("--") && /[rR]/.test(f)));
  if (!recursive && !ctx.agentId) return null;
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
    if (listed) return judgeOperands(listed, "any", `${what} (fed from ${basename(feed.path)})`, ctx);
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
  const victims = await dryRun(simulated(tokens), ctx);
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
  const args = [...tokens.slice(1).filter((t) => t !== "-print" && t !== "-print0"), "-print0"];
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

const GIT_VALUED = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path"]);

/**
 * The git subcommands that discard work: checkout, restore, switch, checkout-index, clean,
 * rm, reset --hard, stash drop / clear.
 *
 * @param {string[]} argv
 * @param {Context} ctx
 */
export async function git(argv, ctx) {
  const words = argv.map((w) => ctx.resolve(w).text);
  let i = 1;
  let dir = ctx.base;
  while (i < words.length && words[i].startsWith("-")) {
    if (words[i] === "-C" && words[i + 1] !== undefined) dir = absolute(dir, words[i + 1])[0];
    i += GIT_VALUED.has(words[i]) ? 2 : 1;
  }
  const sub = words[i];
  const args = words.slice(i + 1);
  if (!sub || !isRealDirectory(dir)) return null;
  const repo = await repositoryOf(dir, ctx.signal);
  if (!repo) return null;
  const at = { ...ctx, base: dir };
  const { flags, operands, paths, others } = pathArgs(args, dir, VALUED[sub] ?? new Set());
  const has = (long, short) => flags.includes(long) || (short && flags.some((f) => /^-[a-zA-Z]+$/.test(f) && f.includes(short)));

  switch (sub) {
    case "checkout":
      // `checkout -- f` restores from the INDEX, so a staged edit survives it; naming a
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
      const onlyIgnored = flags.some((f) => /^-[a-zA-Z]*X/.test(f));
      if (dry || !forced || onlyIgnored || has("--interactive", "i")) return null;
      return lostVerdict(repo, paths.length ? paths : [dir], "untracked", "`git clean`", at);
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
 * everything is a path; before it, only what exists, because `git checkout main` names a branch
 * and not a victim. What is left over is a tree-ish, and a tree-ish changes what is destroyed.
 */
function pathArgs(args, dir, valued) {
  const flags = [];
  const operands = [];
  const paths = [];
  const others = [];
  let literal = false;
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
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
  return { flags, operands, paths, others };
}

// ─── Asking git, and shaping the answer ─────────────────────────────────────────────────

/** Judge where the command runs, for a target this guard cannot read. */
export function whereItRuns(what, ctx) {
  return judgePaths([ctx.base], "any", what, ctx);
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
    const dir = isRealDirectory(target) ? target : dirname(target);
    if (!repoOfDir.has(dir)) repoOfDir.set(dir, isRealDirectory(dir) ? await repositoryOf(dir, ctx.signal) : null);
    const repo = repoOfDir.get(dir);
    if (!repo) continue;
    if (!byRepo.has(repo.top)) byRepo.set(repo.top, { repo, paths: [] });
    byRepo.get(repo.top).paths.push(target);
  }
  const lost = [];
  for (const { repo, paths } of byRepo.values()) lost.push(...(await lostUnder(repo, paths, mode, ctx)));
  return shape(what, lost, ctx);
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

/** @returns {Verdict | null} */
function shape(what, lost, ctx) {
  if (lost.length === 0) return null;
  const shown = lost.slice(0, NAMED).join(", ") + (lost.length > NAMED ? ` and ${lost.length - NAMED} more` : "");
  if (ctx.agentId) {
    return {
      decision: "deny",
      reason:
        `RECOVERABLE: ${what} would destroy uncommitted work that is not yours: ${shown}. Git cannot ` +
        "give it back. Other untracked and uncommitted work in this repository belongs to the " +
        "main session: do not delete, revert, stash or clean anything you did not create. " +
        "Leave it as it is and report what you found.",
    };
  }
  return {
    decision: "ask",
    reason:
      `RECOVERABLE: ${what} would destroy work git cannot give back: ${shown} ` +
      `(${lost.length} path${lost.length === 1 ? "" : "s"}, untracked or edited and uncommitted).`,
  };
}
