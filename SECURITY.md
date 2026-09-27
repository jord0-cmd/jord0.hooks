# Security

These hooks run inside your Claude Code session. They execute `git` and `find` on your machine.

A bug that makes a guard allow what it should refuse is a security bug. So is one that makes it run something it should not.

Report it privately. Use GitHub's private vulnerability reporting on this repository, not a public issue. Send three things: the exact Bash command, the state of the tree from `git status --porcelain`, and the JSON the hook printed.

What is out of scope sits on each hook's page, under Limits.

RECOVERABLE raises the floor against a tidy-minded agent. It is not a sandbox.
