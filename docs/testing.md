# How this is tested

Three layers.

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

One of them lied first.

The clean-filter test passed with the filter blanking removed. Its fixture changed the file's size, and git spotted the change from the file's size alone, without hashing it, so it never needed the filter. A same-size edit forces the hash. The rewritten test goes red without the guard and green with it.

## The loud list and the quiet list

A guard that fails closed asks about everything. That would pass any test that only checks it asks about dangerous commands. So every loud case must be refused by a judge, with a reason that says what would be lost, and there is a quiet list beside it: `rm -rf build`, `git status`, `grep -rn "rm -rf" .`, a commit message that mentions `find wip -delete`, `((rm -rf wip))`. No broken guard can stay silent on those.

## A vanilla Claude Code

`npm run e2e` builds a stock container. It holds the npm Claude Code, git, and an empty home: no `CLAUDE.md`, no settings, no other hooks. The repository's committed tree is served to it as a git remote. It is added through a marketplace, the same way a GitHub source installs. Claude Code's own CLI does the install.

Then every scenario runs through `claude -p`. Each one is judged from what really happened, never from what the model says it did: the tool calls and their results, the transcripts, including any subagent's, and the files left on disk.

It needs a token from `claude setup-token`, passed to the container as an environment variable only.
