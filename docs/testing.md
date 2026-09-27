# How this is tested

Three layers, and a review.

Each one catches what the one before it cannot.

## Unit, through the real scripts

`npm test` runs on Node's built-in test runner. There are no dev dependencies.

The hook tests do not call a function and inspect its return value. They read `hooks/hooks.json`, spawn the exact command it configures, feed it a payload on stdin, and read the JSON it prints. A test that passes proves the wiring as well as the logic.

RECOVERABLE's tests run against a real git work tree holding each type of file the hook has to tell apart. Tracked and clean. Tracked with an uncommitted edit. Untracked. Ignored. DONE-GATE's run against transcripts built in Claude Code's own shape. FLAG-PROBE's run against real scripts on disk.

## Tests that were made to fail

A test that cannot fail proves nothing, and it looks exactly like one that can. So each guard's test was run once with the guard removed, to watch it go red:

| Test | Guard removed | Result |
|------|---------------|--------|
| `core.fsmonitor` is never executed | the fsmonitor pin | red |
| a clean filter is never executed | the filter blanking | red |
| `./find` in the working directory never runs | the absolute path to the system `find` | red |
| a failing run piped into `tail` is caught | the pipe rule | red |
| a negated claim is not a claim | the negation check | red |
| a read script may be probed | the read history | red, four tests |
| a trailing heredoc goes to the last pipeline stage | the last-stage rule | red |
| every leaked name is reported, not only the first | (two planted leaks) | both reported |
| git's pins reach it on git 2.30 | pins moved back off the command line | red |
| a broken repository config is a failure, not silence | any git error read as "not a repository" | red |
| a required filter does not kill `git status` | `required=false` beside the blank | red |
| a commented-out `--help` handler does not count | comment stripping | red |
| a trailing comment or a usage line is not a handler | the quote-aware comment cut, the anchored case arm | red, one mutation each |
| a script with no `#!` is still a script | interpreter files, executable text, the binary sniff | red, one mutation each |
| a grep pattern is not a read | per-tool operand parsing | red |
| a local read does not vouch for a remote script | matching by path and host | red |
| `Now all tests pass.` is a claim | whole-word negation | red, three tests |
| `pytest; echo done` hides the exit status | "not the last command" | red, two tests |
| an admission never excuses a failed run | the failed-run check | red |
| a failed push after passing tests is not a failed test run | the exit status read only when it is the test's own | red, two tests |
| several files deleted on the main thread | the one-file exemption | red |
| a magic pathspec judges the whole tree | pathspec magic | red |
| deleting `.git` counts commits on no remote | the history check | red |
| a symlinked working directory still asks | resolving the real directory | red |
| a glob pathspec (`git checkout -- "*.py"`) judges the whole tree | the glob as an open-ended set | red, four tests |
| `find wip -print -delete` is dry-run cleanly | dropping the printing predicates | red, five tests |
| an unresolvable line in an xargs list file is judged | where it runs | red |
| `time { rm -rf wip; }` and a redirection's `$( … )` hide no command | the reserved word blanked, redirections walked | red, three tests |
| a command the grammar cannot parse is not cleared | the parse-error check, in each hook | red, three tests |
| `git clean -d` deletes when `clean.requireForce` is false | reading the setting, and `-c` / `--config-env` | red, two tests |
| `--git-dir`, `--work-tree` and `GIT_DIR=` are judged in the repository they name | the location passed to every git call | red, five tests |
| a commit on a detached HEAD or a tag counts as history | every ref, not only branches | red |
| the stash is not counted twice | `refs/stash` excluded from the commit count | red |
| deleting a linked worktree names no lost commits | history tied to the git directory, not the top | red |
| `git worktree remove --force` on a dirty worktree | `worktree` among the discarding subcommands | red |
| Node starts with every flag in `hooks.json` | (a flag Node rejects, planted) | red |

One of them lied first.

The clean-filter test passed with the filter blanking removed. Its fixture changed the file's size, and git spotted the change from the file's size alone, without hashing it, so it never needed the filter. A same-size edit forces the hash. The rewritten test goes red without the guard and green with it.

## The loud list and the quiet list

A guard that fails closed asks about everything. That would pass any test that only checks it asks about dangerous commands. So every loud case must be refused by a judge, with a reason that says what would be lost, and there is a quiet list beside it: `rm -rf build`, `git status`, `grep -rn "rm -rf" .`, a commit message that mentions `find wip -delete`, `((rm -rf wip))`. No broken guard can stay silent on those.

## A review before release

Before anything was published, six Claude models read the code, each hunting a different class of flaw. One was told to break the consensus. A non-Claude model read it too, because Claude models share blind spots. A seventh Claude weighed their findings against the code and ran the disputed ones. Every finding was reproduced before it was fixed. Each fix got a test that fails without it. No exceptions.

## A vanilla Claude Code

`npm run e2e` builds a stock container. It holds the npm Claude Code, git, and an empty home: no `CLAUDE.md`, no settings, no other hooks. The repository's committed tree is served to it as a git remote. It is added through a marketplace, the same way a GitHub source installs. Claude Code's own CLI does the install.

Then every scenario runs through `claude -p`. Each one is judged from what really happened, never from what the model says it did: the tool calls and their results, the transcripts, including any subagent's, and the files left on disk.

It needs a token from `claude setup-token`, passed to the container as an environment variable only.
