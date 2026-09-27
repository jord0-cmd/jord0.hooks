# Contributing

A new guard earns its place the same way these three did: a failure that already happened, told plainly on its page.

- `npm ci --ignore-scripts && npm test` must pass. No dev dependencies.
- A test for a guard is run once with the guard removed, and it must go red. Say so in the pull request.
- Hook tests go through the real entry script, spawned the way `hooks/hooks.json` configures it.
- A guard never answers `allow`, and never fails open. See `lib/runner.mjs`.
- Every source file opens with a comment saying what it guards and why.
- Prose follows the house rules the hygiene test checks: no em-dashes, and the hook count agrees with `hooks/hooks.json` everywhere.
