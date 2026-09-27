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
| `rm -r`, or `rm` / `unlink` / `shred` of several files | untracked files and uncommitted edits under the targets |
| `rm -rf .git`, or the whole work tree | the same, and every commit on no remote (on a branch, a tag or a detached HEAD), and the stash |
| `find … -delete`, `find … -exec rm … {}` | the same, for exactly what the find matches (dry-run first) |
| `… \| xargs rm` | the same, for what feeds it: a printing `find`, a list file, or where it runs |
| `git checkout -- f`, `git restore f` | unstaged edits (a staged edit survives a restore from the index) |
| any git discard with `:!pattern` or `--pathspec-from-file` | judged against the whole tree, since the set is open-ended |
| `git checkout HEAD -- f`, `git restore -SW f` | every uncommitted edit, staged or not |
| `git checkout -f`, `git switch -f`, `git switch --discard-changes`, `git reset --hard` | every uncommitted edit in the tree |
| `git checkout-index -f` | unstaged edits to the files it rewrites |
| `git clean -f`, or `git clean` where `clean.requireForce` is false | untracked files (not `-n`, not `-X` alone) |
| `git rm -f` | uncommitted edits to the files it removes (plain `git rm` already refuses) |
| `git stash drop`, `git stash clear` | the stash, when it holds anything |
| `git worktree remove --force` | untracked files and uncommitted edits in that worktree (its commits live in the main tree) |

Deleting one file on the main thread is left alone. That is everyday scratch cleanup, and asking about it would get the guard switched off. Several files, anything recursive, and every delete a subagent makes are judged.

Inside `.git` nothing is scratch. `.git/index` is one file, and it is the staging area. A delete there, or a `find` that reaches in, is named as git's own data, since `git status` never lists it. A stale `index.lock`, `FETCH_HEAD` and `ORIG_HEAD` are left alone: git writes them again.

A git command that names its repository, with `--git-dir`, `--work-tree`, or `GIT_DIR=` and `GIT_WORK_TREE=` in front of it, is judged in that repository. With `--git-dir` alone, git treats the working directory as the work tree, and so does the guard.

A word the guard cannot read, such as `$(git diff --name-only)` or an unset variable, is judged by where the command runs. An unreadable word is not a word that names nothing.

## Finding the command

Commands are found by tree-sitter's bash grammar, not by splitting text on `;` and `&&`. A delete inside `( … )`, `if … then … fi`, a `for` loop, `$( … )`, `eval '…'`, `bash -c '…'`, a heredoc fed to `bash`, `time { … }` or a redirection's `$( … )` is still a delete. A delete that is only mentioned (`grep -rn "rm -rf" .`, a heredoc fed to `cat`, a commit message) is not. `((rm -rf wip))` is bash arithmetic and runs nothing.

Some valid bash will not parse. `cat <<EOF; rm -rf wip` is one. It deletes, and the grammar reads only the `cat`. When part of a command cannot be parsed, RECOVERABLE judges where the command runs. A command it cannot read is not a command that deletes nothing.

## Asking git safely

A security hook that runs `git status` runs it inside whatever repository the command points at, and a repository's own config can name programs for git to run. Two of them run during a plain `git status`, and both were driven doing it:

- `core.fsmonitor`, a program git asks what changed.
- a `clean` filter, chosen by `.gitattributes` (which is committed, so it arrives with a clone), which git pipes a file through whenever it has to hash it.

Hooks are the third. A `git status` that refreshes the index runs `post-index-change`, from `.git/hooks` or wherever the repository's `core.hooksPath` points.

So every git call RECOVERABLE makes pins `core.fsmonitor` off, blanks every filter driver the repository's own config defines, and pins signature checks off. It never refreshes the index, and it points `core.hooksPath` at `/dev/null`. Either alone was driven to zero hook runs. Reading config runs nothing, so the drivers are listed first. Drivers from your global config, git-lfs for one, are yours and keep working.

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

When git cannot answer inside a repository (an error, a timeout, a git older than 2.26), the main thread gets `ask` and a subagent gets `deny`, with the reason. Never an allow, and never silence.

## When not to use it

Outside git it says nothing, so it does nothing for work that was never in a repository.

## Limits

It raises the floor against a tidy-minded agent. It is not a sandbox against an adversary.

- `mv`, `python -c "shutil.rmtree(…)"`, a redirect over a file, and a Write over an edited file are outside its question.
- Submodules are compared by commit only. Their work trees would need git to run under their own config, which this hook has not read.
- A delete is judged against the repository its targets sit in. A sweep rooted above your repositories (`rm -rf ~/projects`) sits in none of them, and is not seen.
- On Windows there is no system `find` to dry-run with, so a `find` delete is judged against its whole root instead, the stricter answer. Windows is not claimed.
- Ignored files are treated as rebuildable. A `.env` or a `.venv` is ignored and is not always rebuildable. Keep secrets somewhere a delete of the project cannot reach.
- Each git call RECOVERABLE makes has two seconds. A very large work tree can make one `git status` slower than that. Then it asks, or denies a subagent, and the reason says git timed out. The hook's whole budget is eight seconds, inside Claude Code's ten.

Tests: `test/recoverable.test.mjs`.
