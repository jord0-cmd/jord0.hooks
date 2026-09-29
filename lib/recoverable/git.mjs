// The one door through which RECOVERABLE runs anything: git, and a read-only `find`.
//
// A security hook that asks git questions runs git inside whatever repository the command in
// front of it points at, and a repository's own config can name programs for git to run. Two
// of them run during a plain `git status`, and both were driven doing it:
//
//   core.fsmonitor           a program git asks what changed
//   filter.<driver>.clean    a program git pipes a file through before comparing it with the
//                            index, chosen by .gitattributes (which is committed and cloned)
//
// So every call pins fsmonitor off, and blanks every filter driver the REPOSITORY's config
// defines, with `required` pinned false beside it so status does not die on the blank. Reading
// config runs nothing, so the drivers are listed first, by scope. Drivers from your own global
// config (git-lfs, say) are yours and keep working. Signature checks are pinned off too, so
// listing stashes cannot reach a repository-chosen gpg.program.
//
// A third program waits in hooks: `git status` that refreshes the index runs post-index-change,
// from .git/hooks or wherever the repository's core.hooksPath points (driven: one run). Two
// pins close it, and both are safety pins: GIT_OPTIONAL_LOCKS=0 stops the refresh, and
// core.hooksPath=/dev/null leaves no hook to find (each alone was driven to zero runs).
//
// A fourth waits in a partial clone. Objects left on the promisor remote are fetched the moment
// anything reads them, `git status` included, and the fetch runs the transport the repository
// names: core.sshCommand for an ssh URL, remote.<name>.uploadpack for a local one (both driven:
// one run each). protocol.allow=never refuses every transport, file:// included, and holds on
// every git this supports; GIT_NO_LAZY_FETCH=1 says the same thing to git 2.44 and later. A
// status that needed the missing object then fails, and the guard asks, as it does for any
// repository it cannot read.
//
// The pins travel as `-c key=value` on git's command line. GIT_CONFIG_COUNT would be neater and
// arrived only in git 2.31: driven on 2.30.2, git ignored it and ran both programs. `-c` with an
// empty value was driven on 2.30, 2.34 and 2.39, and held on all three.
//
// Nothing here ever throws its way to an allow. Inside a repository, a git that cannot answer
// raises ProbeFailed, and the guard turns that into ask (main thread) or deny (subagent). Only
// git's own "not a git repository" means there is nothing here to protect.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export class ProbeFailed extends Error {}

// `git config --show-scope`, which the filter listing needs, arrived in git 2.26.
const MIN_GIT = [2, 26];

const GIT_TIMEOUT_MS = 2000;
export const FIND_TIMEOUT_MS = 2000;

// The only find the dry run may execute. Never the command's own argv[0] (a `./find` in the
// working directory would run inside the hook), and never whatever PATH turns up first.
export const FIND = ["/usr/bin/find", "/bin/find"].find((path) => existsSync(path)) ?? null;

const BASE_ENV = {
  GIT_OPTIONAL_LOCKS: "0", // never refresh the index: the user's own git holds that lock, and a refresh runs a hook
  GIT_TERMINAL_PROMPT: "0",
  GIT_PAGER: "cat",
  GIT_NO_LAZY_FETCH: "1", // a partial clone's missing object stays missing (git 2.44+; protocol.allow covers older)
};

// Pinned on every call. An empty core.fsmonitor disables it both where it is a hook path
// (before git 2.36) and where it is a boolean (after).
const PINNED = [
  ["core.fsmonitor", ""],
  ["core.hooksPath", "/dev/null"],
  ["log.showSignature", "false"],
  ["protocol.allow", "never"],
];

/** `-c key=value` for each pair. */
function configArgs(pairs) {
  return pairs.flatMap(([key, value]) => ["-c", `${key}=${value}`]);
}

// The argv every git call of this guard opens with. Exported because it is also how a git process
// is known to be this guard's: Claude Code's own git pins core.hooksPath=/dev/null too (driven,
// 2.1.284), so no single pin tells the two apart.
export const PINNED_ARGS = Object.freeze(configArgs(PINNED));

/**
 * @typedef {{ code: number, stdout: Buffer, stderr: string }} Ran
 * @param {string} file
 * @param {string[]} args
 * @param {{ cwd: string, timeoutMs: number, signal?: AbortSignal }} options
 * @returns {Promise<Ran>}
 */
export function run(file, args, { cwd, timeoutMs, signal }) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("aborted before it started"));
    // A process group of its own, so a timeout takes any grandchild with it.
    const group = process.platform !== "win32";
    const child = spawn(file, args, {
      cwd,
      env: { ...process.env, LC_ALL: "C", ...BASE_ENV },
      stdio: ["ignore", "pipe", "pipe"],
      detached: group,
      windowsHide: true,
    });
    const out = [];
    const err = [];
    let settled = false;
    const finish = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    const kill = (why) => {
      if (settled) return;
      settled = true;
      finish();
      try {
        if (group) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        // already gone
      }
      reject(new Error(why));
    };
    const timer = setTimeout(() => kill(`timed out after ${timeoutMs} ms`), timeoutMs);
    const onAbort = () => kill("aborted: over the hook's budget");
    signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout.on("data", (chunk) => out.push(chunk));
    child.stderr.on("data", (chunk) => err.push(chunk));
    child.on("error", (e) => {
      if (settled) return;
      settled = true;
      finish();
      reject(e);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      finish();
      resolve({ code: code ?? -1, stdout: Buffer.concat(out), stderr: Buffer.concat(err).toString("utf8") });
    });
  });
}

/** @type {Promise<number[] | null> | null} */
let versionPromise = null;

/** git's version as [major, minor], or null when there is no git on this machine. */
function gitVersion(signal) {
  versionPromise ??= run("git", ["version"], { cwd: "/", timeoutMs: GIT_TIMEOUT_MS, signal })
    .then(({ stdout }) => {
      const m = /(\d+)\.(\d+)/.exec(stdout.toString("utf8"));
      return m ? [Number(m[1]), Number(m[2])] : null;
    })
    .catch((err) => {
      if (err?.code === "ENOENT") return null;
      throw new ProbeFailed(`git version: ${err.message}`);
    });
  return versionPromise;
}

/**
 * The work tree holding `dir`, with the config every git call inside it must carry, or null when
 * `dir` is not in a repository (or there is no git at all: then git holds nothing to lose).
 *
 * @param {string} dir an existing directory
 * @param {AbortSignal} [signal]
 * @param {string[]} [location] `--git-dir=…` / `--work-tree=…` the command itself names, with
 *   absolute paths. They ride on every later call too, so git answers about that repository.
 * @returns {Promise<{ top: string, common: string, config: string[] } | null>} `common` is
 *   the git directory that holds the commits, which a linked worktree shares with its main tree
 */
export async function repositoryOf(dir, signal, location = []) {
  const version = await gitVersion(signal);
  if (!version) {
    // No git on this machine. Outside any repository there is nothing to protect; inside one,
    // the work is still there and this guard cannot read it.
    if (hasGitAbove(dir)) throw new ProbeFailed("git is not installed, and this is inside a git repository");
    return null;
  }
  const found = await ask(dir, [...location, "rev-parse", "--show-toplevel", "--git-common-dir"], signal);
  if (found.code !== 0) {
    if (/not a git repository/i.test(found.stderr)) return null;
    throw new ProbeFailed(`git rev-parse: ${firstLine(found.stderr) || `exit ${found.code}`}`);
  }
  const [top, common] = found.stdout.toString("utf8").trim().split("\n");
  if (!top || !common) throw new ProbeFailed("git rev-parse printed no work tree");
  if (version[0] < MIN_GIT[0] || (version[0] === MIN_GIT[0] && version[1] < MIN_GIT[1])) {
    throw new ProbeFailed(
      `git ${version.join(".")} is older than ${MIN_GIT.join(".")} and cannot list this repository's filters`,
    );
  }
  const listing = await ask(
    top,
    [...location, "config", "--show-scope", "--get-regexp", String.raw`^filter\..+\.(clean|smudge|process)$`],
    signal,
  );
  // Exit 1 is git's "no key matched". Anything else is a listing that failed, and a missed
  // driver would RUN, so that is a probe failure, never "no filters".
  if (listing.code !== 0 && listing.code !== 1) {
    throw new ProbeFailed(`git config: ${firstLine(listing.stderr) || `exit ${listing.code}`}`);
  }
  const drivers = new Set();
  for (const line of listing.stdout.toString("utf8").split("\n")) {
    const [scope, rest] = line.split("\t");
    const key = rest?.split(" ")[0] ?? "";
    const driver = /^filter\.(.+)\.(?:clean|smudge|process)$/.exec(key)?.[1];
    if (driver && (scope === "local" || scope === "worktree")) drivers.add(driver);
  }
  const blanked = [...drivers].flatMap((d) => [
    [`filter.${d}.clean`, ""],
    [`filter.${d}.smudge`, ""],
    [`filter.${d}.process`, ""],
    [`filter.${d}.required`, "false"],
  ]);
  return { top, common: resolve(dir, common), config: [...PINNED_ARGS, ...configArgs(blanked), ...location] };
}

/** A `.git` in `dir` or any directory above it. */
function hasGitAbove(dir) {
  for (let p = resolve(dir); ; p = dirname(p)) {
    if (existsSync(join(p, ".git"))) return true;
    if (p === dirname(p)) return false;
  }
}

/** One git question with the pinned config, answered raw. Throws only if git could not run. */
async function ask(cwd, args, signal) {
  try {
    return await run("git", [...PINNED_ARGS, ...args], { cwd, timeoutMs: GIT_TIMEOUT_MS, signal });
  } catch (err) {
    throw new ProbeFailed(`git ${verb(args)}: ${err.message}`);
  }
}

/**
 * Run git inside a known repository with every config-named program switched off.
 *
 * @param {{ top: string, config: string[] }} repo
 * @param {string[]} args
 * @param {AbortSignal} [signal]
 */
export async function git(repo, args, signal) {
  let ran;
  try {
    ran = await run("git", [...repo.config, ...args], { cwd: repo.top, timeoutMs: GIT_TIMEOUT_MS, signal });
  } catch (err) {
    throw new ProbeFailed(`git ${verb(args)}: ${err.message}`);
  }
  if (ran.code !== 0) throw new ProbeFailed(`git ${verb(args)}: ${firstLine(ran.stderr) || `exit ${ran.code}`}`);
  return ran.stdout;
}

/**
 * A boolean config value as git resolves it in this repository, every scope included, or null
 * when it is not set. Reading config runs nothing.
 *
 * @param {{ top: string, config: string[] }} repo
 * @param {string} key
 * @param {AbortSignal} [signal]
 * @returns {Promise<boolean | null>}
 */
export async function configBool(repo, key, signal) {
  let ran;
  try {
    ran = await run("git", [...repo.config, "config", "--type=bool", "--get", key], {
      cwd: repo.top,
      timeoutMs: GIT_TIMEOUT_MS,
      signal,
    });
  } catch (err) {
    throw new ProbeFailed(`git config: ${err.message}`);
  }
  if (ran.code === 1) return null; // not set
  if (ran.code !== 0) throw new ProbeFailed(`git config: ${firstLine(ran.stderr) || `exit ${ran.code}`}`);
  return ran.stdout.toString("utf8").trim() === "true";
}

/** The subcommand of a git call, past the options in front of it, for a reason to name. */
function verb(args) {
  return args.find((a) => !a.startsWith("-")) ?? args[0];
}

function firstLine(text) {
  return text.trim().split("\n")[0]?.slice(0, 160) ?? "";
}

// `git status` has no --pathspec-from-file, so paths go on the command line in chunks well
// under the argument-length limit.
const CHUNK = 500;

/**
 * The submodules recorded under `paths` (relative to the top), relative to the top. They are
 * read from the index, where each is an entry of mode 160000: nothing runs and nothing on disk
 * is walked, however deep one sits.
 *
 * @param {{ top: string, config: string[] }} repo
 * @param {string[]} paths
 * @param {AbortSignal} [signal]
 * @returns {Promise<string[]>}
 */
export async function gitlinks(repo, paths, signal) {
  const found = [];
  for (let start = 0; start < paths.length; start += CHUNK) {
    const chunk = paths.slice(start, start + CHUNK);
    const out = await git(repo, ["--literal-pathspecs", "ls-files", "-z", "--stage", "--", ...chunk], signal);
    for (const entry of out.toString("utf8").split("\0")) {
      if (entry.startsWith("160000 ")) found.push(entry.slice(entry.indexOf("\t") + 1));
    }
  }
  return found;
}

/**
 * Every dirty entry under `paths` (relative to the top), as [XY, path]. Ignored files never
 * appear, and neither does a clean tracked file.
 *
 * @param {{ top: string, config: string[] }} repo
 * @param {string[]} paths
 * @param {AbortSignal} [signal]
 * @returns {Promise<Array<[string, string]>>}
 */
export async function status(repo, paths, signal) {
  if (paths.length === 0) return [];
  // Submodules are compared by commit only here: checking their work trees from outside would
  // run git inside them under THEIR config, which this call has not read. A judge that deletes a
  // submodule's directory reads it as the repository it is (judges.mjs, nestedRepositories).
  const base = ["--literal-pathspecs", "status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignore-submodules=dirty", "--"];
  const entries = [];
  for (let start = 0; start < paths.length; start += CHUNK) {
    const out = await git(repo, [...base, ...paths.slice(start, start + CHUNK)], signal);
    const fields = out.toString("utf8").split("\0");
    for (let i = 0; i < fields.length; i += 1) {
      const entry = fields[i];
      if (entry.length < 4) continue;
      const xy = entry.slice(0, 2);
      entries.push([xy, entry.slice(3)]);
      if (xy[0] === "R" || xy[0] === "C") i += 1; // a rename or copy carries its origin next
    }
  }
  return entries;
}
