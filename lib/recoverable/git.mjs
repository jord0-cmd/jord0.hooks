// The one door through which RECOVERABLE runs anything: git, and a read-only `find`.
//
// A security hook that asks git questions runs git inside whatever repository the command in
// front of it points at, and a repository's own config can name programs for git to run.
// `git status` runs two of them without being asked:
//
//   core.fsmonitor           a program git calls to learn what changed
//   filter.<driver>.clean    a program git pipes a file through to compare it with the index,
//                            selected by .gitattributes (which IS committed and cloned)
//
// Both were driven: each executed from inside `git status`. So every git call here pins
// fsmonitor off and points attribute lookup at the empty tree, which leaves no filter to
// select. Status still reports every change; with attributes off it can only report MORE files
// as modified (no line-ending normalisation), which makes the guard ask more, never allow more.
//
// Nothing here ever throws its way to an allow. Inside a repository, a git that cannot answer
// raises ProbeFailed, and the guard turns that into ask (main thread) or deny (subagent).

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";

export class ProbeFailed extends Error {}

const EMPTY_TREE = {
  sha1: "4b825dc642cb6eb9a060e54bf8d69288fbee4904",
  sha256: "6ef19b41225c5369f1c104d45d8d85efa9b057b53b14b4b9b939dd74decc5321",
};

// GIT_ATTR_SOURCE arrived in git 2.40. An older git ignores it, and would run filters.
const MIN_GIT = [2, 40];

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

// Pins fsmonitor off. Outranks every config file and reaches submodule gits too.
const HARDENED = {
  GIT_OPTIONAL_LOCKS: "0", // never take or refresh the index lock beside the user's own git
  GIT_TERMINAL_PROMPT: "0",
  GIT_CONFIG_COUNT: "1",
  GIT_CONFIG_KEY_0: "core.fsmonitor",
  GIT_CONFIG_VALUE_0: "false",
};

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
 * The work tree holding `dir` and the repository's hash format, or null when `dir` is not in
 * one (or there is no git at all: then git holds nothing that could be lost).
 *
 * @param {string} dir an existing directory
 * @param {AbortSignal} [signal]
 * @returns {Promise<{ top: string, emptyTree: string } | null>}
 */
export async function repositoryOf(dir, signal) {
  const version = await gitVersion();
  if (!version) return null;
  let ran;
  try {
    ran = await run("git", ["rev-parse", "--show-toplevel", "--show-object-format"], {
      cwd: dir,
      env: HARDENED,
      timeoutMs: GIT_TIMEOUT_MS,
      signal,
    });
  } catch (err) {
    throw new ProbeFailed(`git rev-parse: ${err.message}`);
  }
  if (ran.code !== 0) return null; // not a repository
  const [top, format] = ran.stdout.toString("utf8").trim().split("\n");
  if (!top) return null;
  if (version[0] < MIN_GIT[0] || (version[0] === MIN_GIT[0] && version[1] < MIN_GIT[1])) {
    throw new ProbeFailed(
      `git ${version.join(".")} is older than ${MIN_GIT.join(".")} and cannot be stopped from running this repository's filters`,
    );
  }
  const emptyTree = EMPTY_TREE[format] ?? EMPTY_TREE.sha1;
  return { top, emptyTree };
}

/**
 * Run git inside a known repository with every config-named program switched off.
 *
 * @param {{ top: string, emptyTree: string }} repo
 * @param {string[]} args
 * @param {AbortSignal} [signal]
 */
export async function git(repo, args, signal) {
  try {
    const ran = await run("git", args, {
      cwd: repo.top,
      env: { ...HARDENED, GIT_ATTR_SOURCE: repo.emptyTree },
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
 * @param {{ top: string, emptyTree: string }} repo
 * @param {string[]} paths
 * @param {AbortSignal} [signal]
 * @returns {Promise<Array<[string, string]>>}
 */
export async function status(repo, paths, signal) {
  if (paths.length === 0) return [];
  const base = ["--literal-pathspecs", "status", "--porcelain=v1", "-z", "--untracked-files=all", "--"];
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
