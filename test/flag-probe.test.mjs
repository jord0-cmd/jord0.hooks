// FLAG-PROBE: every acceptance criterion, against real scripts on disk.

import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { before, describe, it } from "node:test";

import { decisionOf, reasonOf, runHook } from "./helpers/hook.mjs";
import { bash, transcript } from "./helpers/transcript.mjs";

let dir;

before(() => {
  dir = mkdtempSync(join(tmpdir(), "jord0-hooks-flag-probe-"));
  const script = (name, body) => {
    writeFileSync(join(dir, name), body);
    chmodSync(join(dir, name), 0o755);
  };
  script("deploy.sh", "#!/bin/sh\n# Rebuilds the config and restarts the service.\necho ran > ran.marker\n");
  script("helpful.sh", '#!/bin/sh\ncase "$1" in\n  -h|--help) echo "usage: helpful.sh" ;;\nesac\n');
  script("tool.py", "import argparse\nparser = argparse.ArgumentParser()\nparser.parse_args()\n");
  script("plain.py", "print('I run whatever you pass me')\n");
  script("noext", "#!/usr/bin/env bash\necho ran\n");
  mkdirSync(join(dir, "sub"));
  script("sub/inner.sh", "#!/bin/sh\necho inner\n");
});

/** The decision FLAG-PROBE makes for `command` run in the scratch dir after `history`. */
async function decide(command, history = [], env = {}) {
  const payload = {
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command },
    cwd: dir,
    transcript_path: transcript(history),
  };
  const result = await runHook("flag-probe", payload, { cwd: dir, env });
  assert.equal(result.code, 0, result.stderr);
  return { decision: decisionOf(result.answer), reason: reasonOf(result.answer) };
}

describe("FLAG-PROBE denies a help probe of an unread script that does not handle the flag", () => {
  const probes = [
    "./deploy.sh --help",
    "./deploy.sh -h",
    "sudo ./deploy.sh --help",
    "timeout -k 5 30 ./deploy.sh --help",
    "bash deploy.sh --help",
    "sh -x ./deploy.sh -h",
    "python3 plain.py --help",
    "uv run plain.py -h",
    "./noext --help",
    "cd sub && ./inner.sh --help",
    "bash -c './deploy.sh --help'",
    "ls && ./deploy.sh --help | head",
  ];
  for (const command of probes) {
    it(command, async () => {
      const { decision, reason } = await decide(command);
      assert.equal(decision, "deny");
      assert.match(reason, /FLAG-PROBE: .* guesses that .* parses a help flag/);
      assert.match(reason, /head -40 /);
    });
  }

  it("finds a bare script name on PATH, the way the shell would", async () => {
    const { decision } = await decide("deploy.sh --help", [], { PATH: `${dir}:${process.env.PATH}` });
    assert.equal(decision, "deny");
  });

  it("follows the probe over ssh, and tells Claude to read it over ssh too", async () => {
    const { decision, reason } = await decide("ssh -p 2222 box './gen-config.sh --help'");
    assert.equal(decision, "deny");
    assert.match(reason, /ssh box head -40 \.\/gen-config\.sh/);
  });
});

describe("FLAG-PROBE stays silent", () => {
  it("when the script handles the flag itself", async () => {
    assert.equal((await decide("./helpful.sh --help")).decision, "silent");
  });

  it("when the script uses a parser that answers --help", async () => {
    assert.equal((await decide("python3 tool.py --help")).decision, "silent");
  });

  it("when the script was read earlier with the Read tool", async () => {
    const history = [{ tool: "Read", input: { file_path: join(dir, "deploy.sh") } }];
    assert.equal((await decide("./deploy.sh --help", history)).decision, "silent");
  });

  it("when the script was read earlier from Bash", async () => {
    assert.equal((await decide("./deploy.sh --help", [bash("head -40 deploy.sh")])).decision, "silent");
  });

  it("when the same command reads the script before probing it", async () => {
    assert.equal((await decide("sed -n 1,20p deploy.sh && ./deploy.sh --help")).decision, "silent");
  });

  it("when a remote script was read over ssh earlier", async () => {
    const history = [bash("ssh box 'head -40 gen-config.sh'")];
    assert.equal((await decide("ssh box './gen-config.sh --help'", history)).decision, "silent");
  });

  const quiet = [
    "git --help",
    "ls -h",
    "/usr/bin/env --help",
    "python3 -m pip --help",
    "cat <<'EOF'\n./deploy.sh --help\nEOF",
    'git commit -m "document ./deploy.sh --help"',
    "echo ./deploy.sh --help",
    "./missing.sh --help",
    "./deploy.sh --verbose",
  ];
  for (const command of quiet) {
    it(`for \`${command.split("\n")[0]}\``, async () => {
      assert.equal((await decide(command)).decision, "silent");
    });
  }
});

describe("reading an earlier probe does not count as reading the script", () => {
  it("a previous `--help` run is not a read", async () => {
    assert.equal((await decide("./deploy.sh --help", [bash("cat --help")])).decision, "deny");
  });
});
