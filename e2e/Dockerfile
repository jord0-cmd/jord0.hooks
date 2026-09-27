# A vanilla Claude Code: the npm package on a stock Node image, a non-root user with an empty
# home, git, and nothing else. No CLAUDE.md, no settings, no other hooks, no plugins.
FROM node:24-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/*

ARG CLAUDE_CODE_VERSION
RUN npm install -g "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}"

RUN useradd --create-home --shell /bin/bash tester
USER tester
WORKDIR /home/tester
RUN git config --global user.email "e2e@example.invalid" && git config --global user.name "e2e"
