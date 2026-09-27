# Security

These hooks run inside your Claude Code session and execute `git` and `find` on your machine. A bug that makes a guard allow what it should refuse, or run something it should not, is a security bug.

Report one through GitHub's private vulnerability reporting on this repository, not a public issue. Include the exact Bash command, the working tree's state (`git status --porcelain`), and the JSON the hook printed.

What is out of scope is written down on each hook's page under Limits. RECOVERABLE raises the floor against a tidy-minded agent. It is not a sandbox.
