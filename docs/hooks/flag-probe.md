# FLAG-PROBE

<span class="tag event">PreToolUse · Bash</span> refuses `--help` on a script that does not handle the flag and has not been read.

<div class="stops" markdown>
**Stops this**
`./some-script.sh --help` run to learn a script's options, when the script ignores the flag and simply runs. It <span class="tag deny">denies</span> the call and says the one command that fixes it.
</div>

## The failure

To learn a script's options, Claude ran it with `--help` over ssh. The script did not parse `--help`. It ignored the flag. It did its job. It rewrote a service config, and the service evicted the two models it had loaded, which was exactly the step Claude had been about to ask about. The script's header, read one call later, listed its real options.

A help flag is a guess about a fact that is sitting in the file. For a script that does not handle it, the guess runs the script.

## What it checks

For every Bash call, FLAG-PROBE finds each script invoked with a standalone `-h` or `--help`. It finds it typed directly, behind `sudo`, `env`, `nice` or `timeout`, run by an interpreter (`bash x.sh`, `python3 x.py`, `uv run x.py`), inside `bash -c '…'`, `eval` or a heredoc fed to a shell, and on the far side of `ssh host '…'`.

The call goes through when either is true:

- **The script's code handles the flag.** A `-h|--help)` case arm, a test like `[ "$1" = "--help" ]`, `getopts` with `h`, a `"--help" in sys.argv`, or the import line of a parser that answers help itself: argparse, click, typer, docopt, fire, commander, yargs, OptionParser and others. Comments are removed before looking. A comment saying the script does not support `--help` is not support for it, and neither is `add_help=False`.
- **The script was read this session.** A Read of the file, or `cat`, `head`, `sed -n`, `rg` and the like with the file as an operand, earlier in the session or earlier in the same command. A search pattern is not a read: `grep deploy.sh notes.txt` read `notes.txt`. A read counts for the file it named in the directory it ran in, and a local read never vouches for a script on another machine.

A program it cannot name, such as `"$f" --help` in a loop over files, is asked about instead of guessed at. Inside a subagent it is denied.

A bare name is found the way its runner finds it. `deploy.sh --help` is looked up on PATH. `bash deploy.sh --help` looks in the working directory first. A compiled program is not a script, so `/usr/bin/git --help` and `python3 -m pip --help` are never touched.

## What it returns

```json
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "deny",
    "permissionDecisionReason": "FLAG-PROBE: `./gen-config.sh --help` guesses that gen-config.sh parses a help flag. Nothing in it says so, and this session has not read it. A script that ignores the flag simply runs. Read it first with `head -40 ./gen-config.sh`. Once it has been read, the call is allowed."
  }
}
```

A deny, on the main thread too. The fix costs one command. The reason names it. For a script over ssh it names `ssh host head -40 <script>`.

## When not to use it

If you want Claude to learn tools by probing them, turn the plugin off in that project. FLAG-PROBE assumes the file is the source of truth.

## Limits

- A remote script can only be matched by name, since its source is on the other machine.
- A script that handles help in a way these patterns do not recognise is refused until it has been read once. The fix still costs one command.

Tests: `test/flag-probe.test.mjs`.
