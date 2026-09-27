# How hooks actually work

The official hooks reference is long and exact. This page is the part of it these three hooks stand on, plus what was found by driving it. Each fact names its source. A fact marked **driven** was run and watched, not read.

## The input

A command hook gets one JSON object on stdin. Every event carries `session_id`, `transcript_path`, `cwd` and `hook_event_name`. PreToolUse adds `tool_name` and `tool_input`. For Bash, the command is `tool_input.command`.

`agent_id` appears only when the tool call comes from a subagent. That one field is how RECOVERABLE tells the main session from a subagent. Source: [hooks reference, common input fields](https://code.claude.com/docs/en/hooks#common-input-fields).

Read stdin with a timeout.

A hook that waits forever on a pipe that never closes holds up the tool call it was meant to judge. These hooks give it two seconds, then treat the missing payload as a fault.

## The answer, for PreToolUse

Exit 0 and print one JSON object:

```json
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "ask",
    "permissionDecisionReason": "why"
  }
}
```

- `deny` stops the call. The reason goes to Claude, so write it for Claude.
- `ask` puts the call in front of the user. The reason goes to the user.
- `allow` skips the user's permission prompt.

That last one is the trap.

`allow` does not mean "no objection". A guard that answers `allow` to everything it has no opinion on has just approved every command it inspects. The right answer for "no objection" is to print nothing and exit 0. Your own permission settings then decide, as if the hook were not there. Source: [PreToolUse decision control](https://code.claude.com/docs/en/hooks#pretooluse-decision-control).

## What ask and deny look like to Claude

**Driven** in a stock Claude Code 2.1.283 container, through `claude -p`:

- A hook's `ask` in headless mode is a refusal. The tool does not run, and Claude receives the ask reason as the tool's error result.
- The same holds under `--dangerously-skip-permissions`. Bypass mode does not wave a hook's `ask` through.
- A `deny` reaches Claude as `PreToolUse:Bash hook error:` followed by your reason. Claude quoted it back and ran nothing else.

What an interactive session in bypass mode does with a hook's `ask` was not driven here, so this page does not claim it.

## A crash is an allow

Exit 2 blocks. Any other non-zero exit is a non-blocking error: Claude Code shows a hook-error notice and runs the tool. Source: [exit codes](https://code.claude.com/docs/en/hooks#exit-code-2-behavior-per-event).

So a guard that throws on a missing package, a bad payload or its own bug lets the tool run. These hooks load everything that can fail by dynamic import, inside one try block, and turn every failure into `ask` on the main thread and `deny` in a subagent. A static import of a missing package would kill the process before any of that code ran.

## The answer, for Stop

Exit 0 and print nothing, and Claude stops. To keep it working, the reference offers three channels: `decision: "block"` with a `reason`, exit 2 with the reason on stderr, or `hookSpecificOutput.additionalContext`.

`additionalContext` is the one the reference names for a hook "working as designed", with "run the test suite before finishing" as its own example. It carries the same loop protection as a block, without the hook-error banner. DONE-GATE uses it. Source: [Stop decision control](https://code.claude.com/docs/en/hooks#stop-decision-control).

Two more fields matter:

- `stop_hook_active` is true when Claude is already continuing because a Stop hook refused. Refuse again and you spend the continuation budget on the same complaint. Claude Code overrides the ninth consecutive refusal anyway.
- `last_assistant_message` is the final text of the turn. The transcript file is written asynchronously and may not hold that message yet when Stop fires. Read the claim from the payload, not the file.

A Stop hook should fail open. A broken one that refuses would hold the session in a loop it cannot leave.

## Running the script

With `args`, a hook runs in exec form. Claude Code spawns `command` directly with `args` as its argument vector. No shell, no quoting, no word splitting. `${CLAUDE_PLUGIN_ROOT}` is substituted into each argument as a plain string. Source: [exec form and shell form](https://code.claude.com/docs/en/hooks#exec-form-and-shell-form).

```json
{
  "type": "command",
  "command": "node",
  "args": ["--liftoff-only", "${CLAUDE_PLUGIN_ROOT}/bin/recoverable.mjs"],
  "timeout": 10
}
```

## Plugins

A plugin's hooks live in `hooks/hooks.json` at its root, in the same shape as `settings.json`. When Claude Code copies a marketplace plugin into its cache, it runs `npm ci --ignore-scripts` there if the plugin ships a `package.json` and a lockfile. No package code runs during that install. Source: [plugin loading](https://code.claude.com/docs/en/plugins/loading).

Installing is silent.

There is no approval prompt, and the hooks fire in every session where the plugin is enabled.

## git runs programs a repository names

**Driven.** A plain `git status` executed a repository's `core.fsmonitor` program. It also piped a file through a `clean` filter chosen by `.gitattributes`, the moment it had to hash that file. A same-size edit forces the hash.

Any hook that runs git inside a repository it did not choose inherits both. RECOVERABLE pins `core.fsmonitor` off and blanks the filter drivers the repository's own config defines, as `-c key=value` on git's command line.

**Driven** on git 2.30.2: the `GIT_CONFIG_COUNT` environment variables, which arrived in 2.31, were ignored, and both programs ran. The command-line form held on 2.30, 2.34 and 2.39.

## The transcript is not a contract

`transcript_path` points at a JSONL file Claude Code writes for itself. Assistant entries carry `tool_use` blocks. The next user entry carries the matching `tool_result`, with `is_error: true` when a Bash command exits non-zero (**driven**). That is how DONE-GATE knows a test run failed. The format is internal and can change, so DONE-GATE reports when it could not read anything instead of reading silence as "nothing happened".
