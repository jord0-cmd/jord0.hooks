# Install

## Needs

- **Node.js 20 or newer** on your PATH. The hooks are `node` scripts.
- **git 2.26 or newer**, for RECOVERABLE. It reads each repository's filter drivers with `git config --show-scope`, which arrived in 2.26.
- **Linux.** The end-to-end run was driven there. macOS is in the CI matrix, on Node 20, 22 and 24, and gets claimed when that matrix has run green. Not before. Windows is not claimed: RECOVERABLE's `find` dry run needs a POSIX `find`, and the tests need a POSIX shell.

## From the marketplace

```
/plugin marketplace add jord0-cmd/jord0.skills
/plugin install jord0-hooks@jord0-skills
```

The plugin lives in its own repository. The jord0.skills marketplace lists it. When Claude Code copies it into its cache, it runs `npm ci --ignore-scripts` there. The two dependencies arrive pinned by the lockfile. No package code runs.

They are `web-tree-sitter` and `tree-sitter-bash`. The bash grammar, as WebAssembly.

## Installing is silent

No approval prompt. All three hooks fire in every session where the plugin is enabled. There is no per-hook toggle in the plugin UI.

That is how Claude Code plugins work. It is also why this page exists.

| To                                      | Run                                                             |
| --------------------------------------- | --------------------------------------------------------------- |
| turn all three off, keep them installed | `/plugin disable jord0-hooks@jord0-skills`                      |
| remove them                             | `/plugin uninstall jord0-hooks@jord0-skills`                    |
| silence DONE-GATE for one shell         | `export JORD0_DONE_GATE=0` before starting Claude Code          |
| teach DONE-GATE your own test command   | `export JORD0_DONE_GATE_COMMANDS="make ci,./scripts/verify.sh"` |

## When an install is damaged

A missing file or a missing package makes RECOVERABLE and FLAG-PROBE refuse every Bash call. That is the fail policy doing its job, and it is loud on purpose.

The reason names what is missing. Reinstall the plugin, or disable it, and Bash works again.

## Without the marketplace

Clone the repository and run `npm ci --ignore-scripts` in it. Then start Claude Code with `claude --plugin-dir /path/to/jord0.hooks`.

The wiring is in `hooks/hooks.json`. Every hook runs as `node` in exec form.

No shell sits between Claude Code and the script.

## What each hook costs

RECOVERABLE and FLAG-PROBE run on every Bash call, side by side. Each starts Node and parses the command with the bash grammar.

Measured with hyperfine, ten runs, on a compound command with a loop, a pipe into `xargs`, an `if` and a commit: 211 ms each under V8's default tiering. 47 ms with `--liftoff-only`, the flag in `hooks.json`.

Over four times faster.

A trivial command like `ls -la` hides the difference. It touches so little of the grammar that both come in near 45 ms, and the first benchmark said the flag did nothing.

The flag is V8's. Not Node's. A Node that dropped it would refuse to start: `node: bad option`, exit 9. Claude Code reads a hook that exits 9 as an error and runs the command anyway. `npm test` starts Node with every flag in `hooks.json`, on each supported version. To check your own, run `node --liftoff-only -e 0`. Exit 0 and no output means it works.

DONE-GATE runs once per stop and reads the tail of the session transcript.
