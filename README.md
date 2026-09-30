# jord0.hooks

Three Claude Code hooks. Each one exists because of a failure that already happened.

| Hook            | Fires on         | Stops this                                                                              |
| --------------- | ---------------- | --------------------------------------------------------------------------------------- |
| **DONE-GATE**   | Stop             | "Done, all fixed" when no test has run since the last code edit, or the last one failed |
| **RECOVERABLE** | PreToolUse, Bash | a delete or a git discard that would destroy work git cannot give back                  |
| **FLAG-PROBE**  | PreToolUse, Bash | `--help` on a script that does not parse it and has not been read                       |

A subagent once deleted an untracked project it took for clutter, then reverted two uncommitted fixes. A `--help` probe once ran the script it was asking about, and the script evicted two models from memory. A "done" once stood on 92 green tests while the suite beside them never ran. These are the seeds that grew out of those three days.

Docs: https://jord0-cmd.github.io/jord0.hooks

## Install

```
/plugin marketplace add jord0-cmd/jord0.skills
/plugin install jord0-hooks@jord0-skills
```

Claude Code installs the two npm dependencies itself, with install scripts switched off. There is no second step.

**Installing is silent.** There is no approval prompt, and all three hooks fire in every session where the plugin is enabled. To stop them:

```
/plugin disable jord0-hooks@jord0-skills
/plugin uninstall jord0-hooks@jord0-skills
```

To silence DONE-GATE for one shell only: `export JORD0_DONE_GATE=0`.

## Needs

- Node.js 20 or newer on your PATH. The hooks run as `node` scripts.
- git 2.26 or newer, for RECOVERABLE.
- Linux. That is where the end-to-end run was driven. macOS is in the CI matrix, on Node 20, 22 and 24, and is claimed when that matrix has run green. Not before. Windows is not claimed: RECOVERABLE's `find` dry run needs a POSIX `find`, and the tests need a POSIX shell.

## How they fail

A guard that crashes is a guard that allows. Claude Code runs a tool when its PreToolUse hook dies, so every failure here becomes a decision instead:

- RECOVERABLE and FLAG-PROBE ask on the main thread, and deny inside a subagent, when they cannot read their input, cannot load the grammar, or run out of time. The reason names the fault.
- DONE-GATE lets the stop through and tells you it could not check. A broken Stop hook that refused would trap the session.
- None of them ever answers `allow`. In Claude Code, `allow` means "skip the user's permission prompt". A guard with no objection says nothing, and your own permission settings decide.

## What is inside

The shell commands are found by tree-sitter's bash grammar, loaded as WebAssembly, instead of by splitting on `;` and `&&`. A commit message that mentions `rm -rf` is one quoted word. A delete inside `( … )`, `if … then` or `$( … )` is still a delete. A command the grammar cannot parse counts as unread, never as clean.

RECOVERABLE asks git, not a list of dangerous paths. When it runs git inside your repository it switches off everything a repository's own config can make `git status` execute: `core.fsmonitor`, the clean filters `.gitattributes` selects, repository hooks, and the fetch a partial clone makes for a missing object, which runs whatever transport the repository names. Each was driven running from inside `git status` before its switch went in.

## Tests

`npm test` runs the unit suite on Node's built-in runner, with no dev dependencies. Each hardening has a test that was proven able to fail: the thing it guards was removed, or changed, in a scratch copy, and the test went red. Two that stayed green were found by review and rewritten. `npm run e2e` installs the plugin into a stock Claude Code in a container and drives each hook through a real session. It needs Docker and a token from `claude setup-token`.

## License

MIT
