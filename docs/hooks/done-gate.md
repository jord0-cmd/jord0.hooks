# DONE-GATE

<span class="tag event">Stop</span> refuses the stop once, with feedback, when the final message claims the work is done and nothing proves it.

<div class="stops" markdown>
**Stops this**
"Done, all fixed" after a code edit, when no test has run since that edit, or when the last one failed.
</div>

## The failure

A turn ended on "all green". Ninety-two tests had passed. They were a subset. The suite beside them never ran, and the claim read exactly the same as it would have if it had.

The same claim turns up in three other shapes. A test ran before the last edit. A test ran and failed, but its output went through `tail`, which exits 0. Or nothing ran at all. The person reading "done" cannot tell any of these apart.

DONE-GATE catches those three. Not the subset. It sees that a test ran after the edit and passed, never whether it was the right test. Which tests ran is in the runner's own result line, and that line is yours to read.

## What it checks

When Claude is about to stop, DONE-GATE reads the final message and then what the session did, in order:

1. Does the final message claim completion? "Done", "fixed", "all tests pass", "shipped", "ready to merge", "everything's green", "all set", and the rest of a fixed list. A negated claim ("nothing is committed") does not count, and neither does a word inside backticks or quotes.
2. Was a code file edited? Edit, Write, MultiEdit, NotebookEdit, or `sed -i` and `perl -i` in Bash. Markdown, text, images and CSV do not count, and neither do `.gitignore`, `.gitattributes`, `.editorconfig`, `CODEOWNERS` or a licence: nothing runs them. A `Dockerfile`, an `.env.example` and JSON do count. An edit to them changes what builds and runs.
3. After the last such edit, did a test command run, and did it pass?

It knows the test runners people use: pytest, `python -m pytest`, `python manage.py test`, tox, nox, jest, vitest, mocha, `node --test`, `deno test`, `cargo test` (toolchain too), `cargo nextest`, `go test`, `mvn clean test`, `gradle test`, `dotnet test`, rspec, `mix test`, `swift test`, ctest, phpunit, bats, `bazel test`, `sbt test`, `stack test`, `cabal test`, `meson test`, plus `npm test`, `npm run test:*`, `pnpm --filter x test`, `pnpm vitest run`, `make test` and `make -j 4 check`. It sees through `timeout`, `env`, `nice`, `uv run`, `poetry run`, `npx`, `bundle exec` and `docker compose run`. Anything else can be named in `JORD0_DONE_GATE_COMMANDS`.

## The command that hides a failure

A Bash call exits with its last command's status. `pytest | tail -3` exits with `tail`'s, and `pytest; echo done` and `pytest || true` exit 0 however many tests failed.

So when a test run is piped onward without `pipefail`, or followed by anything, DONE-GATE reads the output for the summary lines the runners print: "3 failed", "2 failed, 8 passed", "ℹ fail 2", "test result: FAILED", "FAIL", "FAILED (failures=1)", "BUILD FAILURE". It quotes the whole line. Otherwise it trusts the exit status.

The hidden status cuts both ways. In `pytest -q; git push`, a push that fails exits 1 after nine tests passed. With no failure line in the output, DONE-GATE does not blame the tests. It says the status belongs to a command after them, and asks for the test run's own result line.

## What it returns

Nothing, when there is nothing to say. When it refuses:

```json
{
  "hookSpecificOutput": {
    "hookEventName": "Stop",
    "additionalContext": "DONE-GATE: your final message says “Done, the parser is fixed.”, but parser.py was edited and no test has run since. Run the project's tests now and quote the result line, or say plainly that this work is not verified."
  }
}
```

And when the last run failed behind a pipe:

```json
{
  "hookSpecificOutput": {
    "hookEventName": "Stop",
    "additionalContext": "DONE-GATE: your final message says “All tests pass.”, but the last test run after your edits failed: `pytest -q | tail -3` (its output says “41 passed, 1 failed in 2.10s”, and the command hid the exit status). Fix it and run it again, or say plainly that the work is not done."
  }
}
```

`additionalContext` is the channel Claude Code documents for a Stop hook working as designed. It keeps Claude going like a block does, without a hook-error banner.

## When it lets the stop through

- A test ran after the last edit and passed.
- No test ran, and the final message already says the work is not verified. That is the honest answer this hook asks for, so it does not ask twice. It has to be about the work as a whole. "Not tested on Windows" is about a corner of it. And no admission excuses a test run that failed.
- `stop_hook_active` is true, which means Claude is already continuing because of a refusal. DONE-GATE refuses at most once per stop.
- `JORD0_DONE_GATE=0` is set.
- It cannot read the transcript, or the payload carries no final message. Then it lets the stop through and tells you it did not check, because a Stop hook that fails closed would trap the session.

## When not to use it

In a repository with no tests, it will ask every time you claim done after an edit. Name your own check in `JORD0_DONE_GATE_COMMANDS`, or disable the plugin there.

## Limits

- It reads Claude Code's session transcript, whose format is internal to Claude Code. If that format changes and nothing can be read, the hook says so and checks nothing.
- Edits made inside a subagent live in the subagent's transcript, not the main one.
- A test run started in the background reports "running", not a result. It counts as run.
- A run counts whatever it covered. One test file, unrelated to the edit, passes the gate.
- Claims come from that fixed list, in English. "The bug is gone" and "that should do it" are not on it, and pass unread.
- A test run inside a command the grammar cannot parse is not seen. The feedback then says which command it could not read.

Tests: `test/done-gate.test.mjs`.
