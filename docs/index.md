# jord0.hooks

Three Claude Code hooks. Each one exists because of a failure that already happened.

| Hook                                | Fires on                                         | Stops this                                                                              |
| ----------------------------------- | ------------------------------------------------ | --------------------------------------------------------------------------------------- |
| [DONE-GATE](hooks/done-gate.md)     | <span class="tag event">Stop</span>              | "Done, all fixed" when no test has run since the last code edit, or the last one failed |
| [RECOVERABLE](hooks/recoverable.md) | <span class="tag event">PreToolUse · Bash</span> | a delete or a git discard that would destroy work git cannot give back                  |
| [FLAG-PROBE](hooks/flag-probe.md)   | <span class="tag event">PreToolUse · Bash</span> | `--help` on a script that does not parse it and has not been read                       |

They are seeds, not a harness.

Each one is small enough to read in a sitting. Each one says why it refuses, in words Claude can act on.

## Two commands

```
/plugin marketplace add jord0-cmd/jord0.skills
/plugin install jord0-hooks@jord0-skills
```

Claude Code installs the two npm dependencies itself, with install scripts switched off. There is no second step.

Read [Install](install.md) first. Installing is silent, and the hooks fire in every session from then on.

## Three rules they share

**No guard fails open.** A PreToolUse hook that crashes lets the tool run. So every way these can fail becomes a decision: ask on the main thread, deny inside a subagent, and a reason naming the fault.

**No guard says allow.** In Claude Code, `allow` skips your permission prompt. A guard with no objection says nothing at all, and your own settings decide.

**Commands are parsed, never split.** tree-sitter's bash grammar finds the commands inside `( … )`, `if … then`, `$( … )`, a redirection and a heredoc fed to a shell. A commit message that mentions `rm -rf` is one quoted word. A command the grammar cannot parse counts as unread, never as clean.

## Where they came from

A research subagent deleted an untracked project it took for clutter, then reverted two uncommitted fixes with `git checkout`.

A `--help` probe ran the script it was asking about. The script rewrote a config, and two models were evicted from memory.

A "done" stood on 92 green tests. The suite beside them never ran.

The hook pages tell each one properly. [How hooks actually work](how-hooks-work.md) covers the machinery the official docs leave thin, and [How this is tested](testing.md) covers the tests, including the ones that were proven able to fail.
