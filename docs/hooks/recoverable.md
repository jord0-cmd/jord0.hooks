# RECOVERABLE

<span class="tag event">PreToolUse · Bash</span> asks git, before a delete or a discard, whether the work it would destroy can ever come back.

<div class="stops" markdown>
**Stops this**
A delete or a git discard that would destroy untracked files or uncommitted edits. On the main thread it <span class="tag ask">asks</span>. Inside a subagent it <span class="tag deny">denies</span>.
</div>

## The failure

A research subagent carried a scope note naming its own files. It looked at `git status`, and everything else in the tree read as clutter. It ran `find <dir> -depth -delete` on an untracked directory. That directory was the main session's project, never committed. Then it reverted two uncommitted fixes with `git checkout -- <files>`.

The guard of the day allowed both. It asked the wrong question: is this a dangerous place? The deleted directory was an ordinary place. What made it unrecoverable was that its bytes had never reached git's object store.

## The question it asks

Would this command destroy untracked, not-ignored files, or uncommitted edits? No spellings to enumerate. A command destroys such bytes or it does not. Git says which.

So these stay silent by construction: ignored files (`node_modules/`, `build/`, `*.pyc`), tracked files with no edits, dry runs, `git restore --staged`. A rebuild or a checkout gives them back.

| Command | What would be lost |
|---------|--------------------|
| `rm -r`, or `rm` / `unlink` / `shred` of more than one file: several names, a glob, a brace list, a variable holding several words, a second one-file delete in the same call | untracked files and uncommitted edits under the targets |
| a delete of a directory that holds another repository (a submodule, a clone in an ignored directory) | the same, inside that repository too |
| `rm -rf .git`, or the whole work tree | the same, and every commit on no remote (on a branch, a tag or a detached HEAD), and the stash |
| `find … -delete`, `find … -exec rm … {}` | the same, for exactly what the find matches (dry-run first) |
| `xargs rm`, fed through a pipe or from a file | the same, for what feeds it: a printing `find`, a list file, text the command carries (`echo`, a here-string, a heredoc). Where it runs, when the feed cannot be read |
| `git checkout -- f`, `git restore f` | unstaged edits (a staged edit survives a restore from the index) |
| any git discard with `:!pattern` or `--pathspec-from-file` | judged against the whole tree, since the set is open-ended |
| `git checkout HEAD -- f`, `git restore -SW f` | every uncommitted edit, staged or not |
| `git checkout -f`, `git switch -f`, `git switch --discard-changes`, `git reset --hard`, `git read-tree -u` with `--reset` or `-m` | every uncommitted edit in the tree. Not `git switch -f -c other`: a branch made at HEAD keeps the edits |
| `git checkout-index -f` | unstaged edits to the files it rewrites, and the whole tree with `--stdin`. Not with `--prefix`, which writes somewhere else |
| `git clean -f`, or `git clean` where `clean.requireForce` is false | untracked files (not `-n`, not `-X` alone). Without `-d` and without a path, the files inside untracked directories are spared, as git spares them |
| `git rm -f` | uncommitted edits to the files it removes (plain `git rm` already refuses) |
| `git stash drop`, `git stash clear` | the stash, when it holds anything |
| `git worktree remove --force` | untracked files and uncommitted edits in that worktree (its commits live in the main tree) |

Deleting one plainly named file on the main thread is left alone. That is everyday scratch cleanup, and asking about it would get the guard switched off. A second one anywhere in the same call, and both are judged. So is a glob, a brace list, anything recursive, a file a `find` or `xargs` hands to a shell, and every delete a subagent makes. A `git add` after such a delete saves nothing: the file is gone by then.

Inside `.git` nothing is scratch. `.git/index` is one file, and it is the staging area. A delete there, or a `find` that reaches in, is named as git's own data, since `git status` never lists it. `FETCH_HEAD`, `ORIG_HEAD`, `COMMIT_EDITMSG` and `gc.log` are left alone: they record the last operation, and git writes them again. So is a lock at any depth, `index.lock` or `refs/heads/main.lock`. Removing a stale one is the everyday fix after a git that crashed.

A git command that names its repository, with `--git-dir`, `--work-tree`, or `GIT_DIR=` and `GIT_WORK_TREE=` in front of it (behind `env` too), is judged in that repository. With `--git-dir` alone, git treats the working directory as the work tree, and so does the guard.

## When it asks and when it stays silent

It asks when it can name the work a command loses.

It asks when a command certainly deletes and only its target cannot be read: `rm -rf $DIR/cache` with `DIR` unset, `git checkout -- $(git diff --name-only)`. An unreadable word is not a word that names nothing. For `rm` and `find` the question moves to where the command runs, and covers the uncommitted work there. Never the commits: nothing in the command names `.git`. For git, the flags decide first which loss it is, and the unreadable path stands for the whole tree.

It stays silent after a save. A `git add` or `git stash push` earlier in the same call puts the files in git's keeping, and a later delete of them loses nothing: `git add -A && rm -rf wip`, `git add -A; rm -rf wip`. Only a save that certainly ran, and finished, counts. One behind `&&` or `||`, in an `if`, or in a function called that way may not run. One in another stage of the delete's own pipeline runs at the same moment as the delete. So does one sent off with `&`. Driven: `git add -A | rm -rf wip` staged none of three thousand files. A bare `wait`, or `wait $!` for the last job, in the shell that sent the job off, waits for it. A save after the delete stages the deletion, not the bytes.

It stays silent when the program itself cannot be known from the text. A name built at run time. A script file handed to a shell. Asking there would mean asking about every command it cannot read, and a guard that asks about everything gets switched off.

Everything the text does say is read.

## Finding the command

Commands are found by tree-sitter's bash grammar, not by splitting text on `;` and `&&`. A delete inside `( … )`, `if … then … fi`, a `for` loop, `$( … )`, `eval '…'`, `bash -c '…'`, `trap '…' EXIT`, a function that is called, `time { … }` or a redirection's `$( … )` is still a delete. A delete that is only mentioned (`grep -rn "rm -rf" .`, a heredoc fed to `cat`, a commit message) is not. `((rm -rf wip))` is bash arithmetic and runs nothing. A function that is defined and never called runs nothing either.

A shell reads a script from more places than `-c`, and each is read: a heredoc (`bash <<'EOF'`, `cat <<'EOF' | bash`, `bash /dev/stdin <<'EOF'`), a here-string, a pipe from `echo`, a `tee` in between, a process substitution (`bash < <(echo …)`). So is `printf` when its format has no `%` and no backslash, and the string `flock` hands to `sh -c`.

Wrapper words are peeled by one table, which all three hooks share: `sudo`, `doas`, `env`, `nice`, `ionice`, `timeout`, `flock`, `taskset`, `stdbuf`, `nohup`, `setsid`, `time`, `command`, `exec`, `builtin`, `busybox`, `chronic`, `numactl`, `unshare`, `strace`, `chrt`. An option that takes a value takes it here too, so `timeout -k 5 10 rm -rf wip` is an `rm`, and `env -C wip rm -rf deep` and `unshare -w wip rm -rf deep` run in `wip`. `strace -E NAME=value` sets the command's environment, as `env` does. `env -S` splits its string as GNU env does. `\_` separates words and `\c` ends the string. A `#` that starts a word starts a comment. A string env refuses, with an escape it does not know or a quote left open, runs nothing. When the directory `env -C` names cannot be read, a program that can delete is judged where the command runs. `rm` reads its flags after the shell expands them, so `F=-rf; rm $F wip` is recursive.

A program named by a variable the call set is the program the variable holds: `R=rm; $R -rf wip` is an `rm`, and `W=sudo; $W rm -rf wip` peels the wrapper as if it were written out. A variable that may hold several values, set in a branch or a loop, is judged for each of them.

`find … -exec sh -c '…' {} \;` and `xargs sh -c '…'` run a shell for each match. The find is dry-run, and the payload is read with the real matches standing in for `{}`, `$0` and `$@`. `xargs git …` and `find … -exec git …` go to the git judge, with a path it cannot read.

`xargs` itself runs no shell. An item is a name, and a `*` in it is a character. An item that names nothing on disk is nothing to lose, and the rest are judged.

Some valid bash will not parse. `cat <<EOF; rm -rf wip` is one. It deletes, and the grammar reads only the `cat`. When part of a command cannot be parsed, RECOVERABLE judges where the command runs. A command it cannot read is not a command that deletes nothing.

## Following cd

`cd wip && rm -rf deep` is judged in `wip`. The guard follows `cd`, `cd -`, a bare `cd` to `HOME`, `pushd` and `popd`.

A `cd` the shell may not take leaves both places in play: the right side of `&&` or `||`, the body of an `if` or a loop, a target that is not on disk. A later delete is judged in each, because judging both never misses. After `cd wip && …` only `wip` counts, since `&&` runs what follows only when the `cd` worked. A directory that `mkdir` made earlier in the same call is there.

A `cd` into a directory this user cannot search fails, so it is a `cd` the shell may not take too.

With `CDPATH` set, in the call or in the session's environment, a relative target not written `./…` or `../…` is looked for along it first, as bash does. The first entry that has it wins. An empty entry is the current directory. Otherwise the current directory is tried last. `CDPATH=wip; cd deep` lands in `wip/deep`. Driven on bash 5.2.

A `cd` inside `( … )`, a pipeline stage or an `&` job moves nothing outside it.

## Through a link

A path through a symlink is read the way it will be resolved when the command runs.

An operand belongs to the kernel. In `rm -rf link/../notes.md` the `..` is the parent of wherever `link` points. Cutting `link/..` out of the string names a different file. A trailing slash names the directory behind the link: `rm -rf link/` deletes what `link` points to, and `rm -rf link` removes the link.

The shell's own `cd` goes by name. After `cd link`, `cd ..` lands in the directory that holds the link. Driven on bash 5.2. `cd -P` goes where the link points, and `set -P` makes every `cd` do that until `set +P`. A subshell inherits the setting. A `bash -c` does not. A `set -P` the shell may not have run, inside an `if`, leaves both places in play.

A `find` that walks through a link (`find link/`, `-L`, `-H`) deletes what is behind it, and the victims are named by where they really are.

## A repository inside the target

`git status` says nothing about work inside another repository. A submodule's uncommitted files. A clone sitting in an ignored `build/`. A second project under the directory being deleted. So a delete looks for them, and asks each one as the repository it is, under its own config, with the same pins.

Submodules come from the index, however deep they sit. Nothing is walked for them. Everything else comes from a walk below the target, by depth, and within one depth in the order the directory lists them.

A repository is named from the repository the command runs in, however the delete reaches it: `rm -rf build` and `rm -rf build/sub` both name `build/sub/x.txt`.

A submodule's commits live in the git directory of the repository around it, so deleting its work tree loses no history, and commits the superproject has not recorded yet are no loss either. A linked worktree shares one git directory with its main tree, and that history is counted once.

A directory whose `.git` git will not open, a stray file or a `gitdir:` that points nowhere, is not a repository. git refuses to run there, and the repository around it lists the files inside as its own. Driven on git 2.47.

## Asking git safely

A security hook that runs `git status` runs it inside whatever repository the command points at, and a repository's own config can name programs for git to run. Two of them run during a plain `git status`, and both were driven doing it:

- `core.fsmonitor`, a program git asks what changed.
- a `clean` filter, chosen by `.gitattributes` (which is committed, so it arrives with a clone), which git pipes a file through whenever it has to hash it.

Hooks are the third. A `git status` that refreshes the index runs `post-index-change`, from `.git/hooks` or wherever the repository's `core.hooksPath` points.

A partial clone holds the fourth. Objects left on its promisor remote are fetched the moment anything reads them, `git status` included, and the fetch runs the transport the repository names: `core.sshCommand` for an ssh URL, `remote.<name>.uploadpack` for a local one. Both were driven running.

So every git call RECOVERABLE makes pins `core.fsmonitor` off, blanks every filter driver the repository's own config defines, and pins signature checks off. It never refreshes the index, and it points `core.hooksPath` at `/dev/null`. It refuses every transport (`protocol.allow=never`, and `GIT_NO_LAZY_FETCH=1` for git 2.44 and later), so a status that needs a missing object fails, and the guard asks as it does for any repository it cannot read. Either alone was driven to zero hook runs. Reading config runs nothing, so the drivers are listed first. Drivers from your global config, git-lfs for one, are yours and keep working.

The pins ride on git's command line as `-c key=value`. The tidier `GIT_CONFIG_COUNT` environment variables arrived in git 2.31, and git 2.30 was driven ignoring them and running both programs. The command-line form held on 2.30, 2.34 and 2.39.

Only git's own "not a git repository" means there is nothing to protect. A broken config, a repository owned by someone else, or a format this git cannot read is a probe failure.

The dry run of a `find` uses the system `find` by absolute path. A file called `find` in the working directory is never executed.

## What it returns

On the main thread:

```json
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "ask",
    "permissionDecisionReason": "RECOVERABLE: `rm` would destroy work git cannot give back: wip/deep/plate.png, wip/notes.md (2 paths, untracked or edited and uncommitted)."
  }
}
```

Inside a subagent:

```json
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "deny",
    "permissionDecisionReason": "RECOVERABLE: `git checkout` would destroy work that is not yours: src/mod.py (1 path, untracked or edited and uncommitted). Git cannot give it back. Other untracked and uncommitted work in this repository belongs to the main session: do not delete, revert, stash or clean anything you did not create. Leave it as it is and report what you found."
  }
}
```

The subagent's reason says whose the work is, because a scope note is what made the incident's agent read everything else as clutter.

One Bash call gets one answer. When several commands in it lose work, the reason names each command and what it loses.

When git cannot answer inside a repository (an error, a timeout, a git older than 2.26), the main thread gets `ask` and a subagent gets `deny`, with the reason. Never an allow, and never silence.

## When not to use it

Outside git it says nothing, so it does nothing for work that was never in a repository.

## Limits

It raises the floor against a tidy-minded agent. It is not a sandbox against an adversary.

- `mv`, `python -c "shutil.rmtree(…)"`, a redirect over a file, and a Write over an edited file are outside its question.
- It reads the program a command names, and one held in a variable the same call set. A name decided when the command runs is not read: `$(which rm) -rf wip`, `eval "$(echo rm -rf wip)"`, a variable set by `read`, a variable that may or may not be empty. Reaching those is the adversary this hook is not built to stop.
- A script file is not opened. `bash deploy.sh`, `bash < deploy.sh`, `cat deploy.sh | bash`, `source env.sh` and `curl … | bash` all run text this hook never reads. Neither is a `printf` with a `%` or a backslash in its format: what it prints is decided when it runs.
- A `cd` into a directory that something other than `mkdir` makes in the same call (`cp -r a b; cd b; rm -rf *`) is judged both ways, in `b` and where the call started. That can ask about a delete that was safe.
- Fifteen payloads or function calls deep is followed, and so are eleven wrapper words. One more of either, and the command is judged by where it runs.
- A program word is followed through eight readings: a variable that may hold several programs, times a wrapper that may be several. At nine the command is judged by where it runs.
- After `cd`s that may fail, eight directories a command may be running in are kept. Past that, a command that can delete is judged across the directory they all lie under. That can ask about a delete that was safe.
- `CDPATH` is read from the call and from the environment the hook runs in. One set in a shell startup file and not exported is not seen, and one this guard cannot read leaves the tracked directory where it was.
- `unshare -R DIR` runs the command under a new root. A relative path is read from `DIR`. An absolute one is read as it is outside the new root.
- The walk for a repository inside a target lists two thousand directories or reads twenty thousand entries, whichever comes first, and stops. A clone past that in a very large tree is not found. A submodule is, from the index. When the hook asks anyway, its reason says the search reached its limit.
- Deleting a submodule's git directory (`.git/modules/<name>`) asks, naming git's own data. The commits inside it are not counted one by one.
- A save inside a function the call runs on every path still asks: every command in a function body is read as one that may not run.
- It reads thirty-two repositories inside one target. Past that it asks without naming anything, and says why.
- `xargs` reads quotes and backslashes its own way, and not at all with `-0`. An item under them that names nothing on disk asks, judged by where the command runs, even when `rm` would have found nothing either.
- On Windows there is no system `find` to dry-run with, so a `find` delete is judged against its whole root instead, the stricter answer. Windows is not claimed.
- Ignored files are treated as rebuildable. A `.env` or a `.venv` is ignored and is not always rebuildable. Keep secrets somewhere a delete of the project cannot reach.
- Each git call RECOVERABLE makes has two seconds. A very large work tree can make one `git status` slower than that. Then it asks, or denies a subagent, and the reason says git timed out. The hook's whole budget is eight seconds, inside Claude Code's ten.

Tests: `test/recoverable.test.mjs`.
