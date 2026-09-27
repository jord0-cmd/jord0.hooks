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
// defines. Reading config runs nothing, so the drivers are listed first, by scope. Drivers from
// your own global config (git-lfs, say) are yours and keep working. Status stays exact, on any
// git from 2.26 on. Signature checks are pinned off too, so listing stashes cannot reach a
// repository-chosen gpg.program.
//
// Nothing here ever throws its way to an allow. Inside a repository, a git that cannot answer
// raises ProbeFailed, and the guard turns that into ask (main thread) or deny (subagent).

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";

export class ProbeFailed extends Error {}

// `git config --show-scope`, which the filter listing needs, arrived in git 2.26.
const MIN_GIT = [2, 26];

const GIT_TIMEOUT_MS = 1500;
export const FIND_TIMEOUT_MS = 2000;

// The only find the dry run may execute. Never the command's own argv[0] (a `./find` in the
// working directory would run inside the hook), and never whatever PATH turns up first.
export const FIND = ["/usr/bin/find", "/bin/find"].find((path) => existsSync(path)) ?? null;

/**
 * @typedef {{ code: number, stdout: Buffer, stderr: string }} Ran
 * @param {string} file
 * @param {string[]} args
 * @param {{ cwd: string, env?: NodeJS.ProcessEnv, timeoutMs: number, signal?: AbortSignal }} options
 * @returns {Promise<Ran>}
 */
export function run(file, args, { cwd, env = {}, timeoutMs, signal }) {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      {
        cwd,
        env: { ...process.env, LC_ALL: "C", ...env },
        encoding: "buffer",
        maxBuffer: 256 * 1024 * 1024,
        timeout: timeoutMs,
        killSignal: "SIGKILL",
        signal,
        windowsHide: true,
      },
      (err, stdout, stderr) => {
        if (err && typeof err.code !== "number") return reject(err); // not started, killed, aborted
        resolve({ code: err ? err.code : 0, stdout, stderr: stderr.toString("utf8") });
      },
    );
  });
}

const BASE_ENV = {
  GIT_OPTIONAL_LOCKS: "0", // never take or refresh the index lock beside the user's own git
  GIT_TERMINAL_PROMPT: "0",
  GIT_PAGER: "cat",
};

// Config pinned on every call. GIT_CONFIG_* outranks every config file.
const PINNED = [
  ["core.fsmonitor", "false"],
  ["log.showSignature", "false"],
];

/** GIT_CONFIG_COUNT / KEY_n / VALUE_n for a list of [key, value] pairs. */
function configEnv(pairs) {
  const env = { ...BASE_ENV, GIT_CONFIG_COUNT: String(pairs.length) };
  pairs.forEach(([key, value], n) => {
    env[`GIT_CONFIG_KEY_${n}`] = key;
    env[`GIT_CONFIG_VALUE_${n}`] = value;
  });
  return env;
}

const HARDENED = configEnv(PINNED);

/** @type {Promise<number[] | null> | null} */
let versionPromise = null;

/** git's version as [major, minor], or null when there is no git on this machine. */
function gitVersion() {
  versionPromise ??= run("git", ["version"], { cwd: "/", timeoutMs: GIT_TIMEOUT_MS })
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
 * The work tree holding `dir`, with the environment every git call inside it must use, or null
 * when `dir` is not in a repository (or there is no git at all: then git holds nothing to lose).
 *
 * @param {string} dir an existing directory
 * @param {AbortSignal} [signal]
 * @returns {Promise<{ top: string, env: Record<string, string> } | null>}
 */
export async function repositoryOf(dir, signal) {
  const version = await gitVersion();
  if (!version) return null;
  const top = await ask(dir, ["rev-parse", "--show-toplevel"], signal, true);
  if (top === null) return null; // not a repository
  if (version[0] < MIN_GIT[0] || (version[0] === MIN_GIT[0] && version[1] < MIN_GIT[1])) {
    throw new ProbeFailed(
      `git ${version.join(".")} is older than ${MIN_GIT.join(".")} and cannot list this repository's filters`,
    );
  }
  const listing = await ask(
    top,
    ["config", "--show-scope", "--get-regexp", String.raw`^filter\..+\.(clean|smudge|process)$`],
    signal,
    true,
  );
  const blanked = [];
  for (const line of (listing ?? "").split("\n")) {
    const [scope, rest] = line.split("\t");
    const key = rest?.split(" ")[0];
    if (key && (scope === "local" || scope === "worktree")) blanked.push([key, ""]);
  }
  return { top, env: configEnv([...PINNED, ...blanked]) };
}

/**
 * One git question with the pinned config, answered as text. Null for a plain "no" (a non-zero
 * exit when `quietNo`), ProbeFailed when git could not be run at all.
 */
async function ask(cwd, args, signal, quietNo) {
  let ran;
  try {
    ran = await run("git", args, { cwd, env: HARDENED, timeoutMs: GIT_TIMEOUT_MS, signal });
  } catch (err) {
    throw new ProbeFailed(`git ${args[0]}: ${err.message}`);
  }
  if (ran.code !== 0) {
    if (quietNo) return null;
    throw new ProbeFailed(`git ${args[0]}: ${ran.stderr.trim().split("\n")[0] || `exit ${ran.code}`}`);
  }
  return ran.stdout.toString("utf8").trim();
}

/**
 * Run git inside a known repository with every config-named program switched off.
 *
 * @param {{ top: string, env: Record<string, string> }} repo
 * @param {string[]} args
 * @param {AbortSignal} [signal]
 */
export async function git(repo, args, signal) {
  try {
    const ran = await run("git", args, {
      cwd: repo.top,
      env: repo.env,
      timeoutMs: GIT_TIMEOUT_MS,
      signal,
    });
    if (ran.code !== 0) {
      const first = ran.stderr.trim().split("\n")[0] ?? "";
      throw new ProbeFailed(`git ${args[0]}: ${first.slice(0, 160) || `exit ${ran.code}`}`);
    }
    return ran.stdout;
  } catch (err) {
    if (err instanceof ProbeFailed) throw err;
    throw new ProbeFailed(`git ${args[0]}: ${err.message}`);
  }
}

// `git status` has no --pathspec-from-file, so paths go on the command line in chunks well
// under the argument-length limit.
const CHUNK = 500;

/**
 * Every dirty entry under `paths` (relative to the top), as [XY, path]. Ignored files never
 * appear, and neither does a clean tracked file.
 *
 * @param {{ top: string, env: Record<string, string> }} repo
 * @param {string[]} paths
 * @param {AbortSignal} [signal]
 * @returns {Promise<Array<[string, string]>>}
 */
export async function status(repo, paths, signal) {
  if (paths.length === 0) return [];
  // Submodules are compared by commit only: checking their work trees would run git inside
  // them under THEIR config, which this probe has not read. (Documented limit.)
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
