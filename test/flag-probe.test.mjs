// FLAG-PROBE: every acceptance criterion, against real scripts on disk.

import assert from "node:assert/strict";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { before, describe, it } from "node:test";

import { decisionOf, reasonOf, runHook } from "./helpers/hook.mjs";
import { scratchDir } from "./helpers/scratch.mjs";
import { bash, transcript } from "./helpers/transcript.mjs";

let dir;

before(() => {
  dir = scratchDir("jord0-hooks-flag-probe-");
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
  // Round 1 of review: files that only TALK about help, and files whose code handles it.
  script("says-no.sh", "#!/bin/sh\n# NOTE: this script does NOT support --help.\necho ran\n");
  script("fire.sh", "#!/bin/sh\n# fire and forget\necho ran\n");
  script("nohelp.py", "import argparse\nparser = argparse.ArgumentParser(add_help=False)\nparser.parse_args()\n");
  script("tests-arg.sh", '#!/bin/sh\nif [ "$1" = "--help" ]; then echo usage; exit 0; fi\necho ran\n');
  script("getopts.sh", '#!/bin/sh\nwhile getopts "hv" opt; do :; done\necho ran\n');
  script("argv.py", 'import sys\nif "--help" in sys.argv:\n    print("usage")\n');
  script("cli.mjs", 'import { Command } from "commander";\nnew Command().parse();\n');
  // A handler that has been commented out is not a handler.
  script("commented.sh", '#!/bin/sh\n# case "$1" in\n#   -h|--help) usage ;;\n# esac\necho ran\n');
  script("commented.py", "# import argparse\nprint('ran')\n");
  // Round 1b: a handler in a trailing comment or a usage string is not a handler.
  script("trailing.sh", '#!/bin/bash\nset -euo pipefail\ndeploy_everything "$@"   # case "$1" in -h|--help) usage;; esac\n');
  script("usage-string.sh", '#!/bin/sh\necho "Try: make help (or make --help)"\necho ran\n');
  script("trailing.mjs", '#!/usr/bin/env node\nconsole.log("ran"); // if (arg === "--help") later\n');
  script("oneliner.sh", '#!/bin/sh\ncase "$1" in -h|--help) echo usage; exit 0;; esac\necho ran\n');
  script("hash-in-string.sh", '#!/bin/sh\necho "# not a comment"\ncase "$1" in\n  --help | -h ) echo usage ;;\nesac\n');
  // Round 1b: bash runs an executable text file with no `#!` as a shell script.
  script("legacy", "echo no shebang here\necho ran\n");
  writeFileSync(join(dir, "notexec"), "echo ran\n"); // not executable: bash refuses to run it
  script("compiled", Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0, 0, 0, 0, 0]));
  // Round 1b: wrappers that hand the flag to a CLI that answers it, known by the call they make.
  mkdirSync(join(dir, "django"));
  script("django/manage.py", "import sys\n\ndef main():\n    from django.core.management import execute_from_command_line\n    execute_from_command_line(sys.argv)\n");
  script("gradlew", '#!/bin/sh\nset -- -classpath "$CLASSPATH" org.gradle.wrapper.GradleWrapperMain "$@"\nexec "$JAVACMD" "$@"\n');
  script("manage.py", "print('a manage.py that is not Django, and runs')\n");
  script("length.sh", '#!/bin/sh\nif [ ${#1} -gt 0 ] && [ "$1" = "--help" ]; then echo usage; exit 0; fi\necho ran\n');
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

describe("round 1 of review: text about help is not code that handles it", () => {
  for (const command of [
    "./says-no.sh --help",
    "./fire.sh --help",
    "python3 nohelp.py --help",
    "./commented.sh --help",
    "python3 commented.py --help",
  ]) {
    it(`denies ${command}`, async () => {
      assert.equal((await decide(command)).decision, "deny");
    });
  }
  for (const command of ["./tests-arg.sh --help", "./getopts.sh -h", "python3 argv.py --help", "node cli.mjs --help"]) {
    it(`stays silent for ${command}`, async () => {
      assert.equal((await decide(command)).decision, "silent");
    });
  }
});

describe("round 1 of review: a search pattern is not a read", () => {
  it("does not count grep's pattern as reading the script", async () => {
    assert.equal((await decide("grep deploy.sh notes.txt; ./deploy.sh --help")).decision, "deny");
    assert.equal((await decide("rg deploy.sh; ./deploy.sh --help")).decision, "deny");
  });
  it("does not count wc or file as reading it", async () => {
    assert.equal((await decide("wc -l deploy.sh; ./deploy.sh --help")).decision, "deny");
  });
  it("counts grep's file operand as a read", async () => {
    assert.equal((await decide("grep -n . deploy.sh; ./deploy.sh --help")).decision, "silent");
    assert.equal((await decide("rg -e usage deploy.sh; ./deploy.sh --help")).decision, "silent");
  });
});

describe("round 1 of review: spellings that used to walk past", () => {
  for (const command of [
    "nice -n 5 ./deploy.sh --help",
    "env -u HOME ./deploy.sh --help",
    "bash -e ./deploy.sh --help",
    'eval "./deploy.sh --help"',
    "bash <<'EOF'\n./deploy.sh --help\nEOF",
  ]) {
    it(`denies ${JSON.stringify(command)}`, async () => {
      assert.equal((await decide(command)).decision, "deny");
    });
  }

  it("asks, and denies a subagent, when the program cannot be resolved", async () => {
    const command = 'for f in ./*.sh; do "$f" --help; done';
    // Its own reason, not the failure path's: a guard that crashed would ask and deny too.
    const main = await decide(command);
    assert.equal(main.decision, "ask");
    assert.match(main.reason, /cannot tell which program that is/);
    const payload = {
      tool_name: "Bash",
      tool_input: { command },
      cwd: dir,
      agent_id: "agent-1",
      transcript_path: transcript([]),
    };
    const sub = (await runHook("flag-probe", payload, { cwd: dir })).answer;
    assert.equal(decisionOf(sub), "deny");
    assert.match(reasonOf(sub), /cannot tell which program that is/);
  });
});

describe("round 1b: only code that handles the flag counts", () => {
  for (const command of ["./trailing.sh --help", "./usage-string.sh --help", "node trailing.mjs --help"]) {
    it(`denies ${command}`, async () => {
      assert.equal((await decide(command)).decision, "deny");
    });
  }
  for (const command of ["./oneliner.sh --help", "./hash-in-string.sh -h", "./length.sh --help"]) {
    it(`stays silent for ${command}`, async () => {
      assert.equal((await decide(command)).decision, "silent");
    });
  }
});

describe("round 1b: a wrapper that hands the flag on", () => {
  for (const command of ["./gradlew --help", "cd django && python3 manage.py --help"]) {
    it(`stays silent for ${command}`, async () => {
      assert.equal((await decide(command)).decision, "silent");
    });
  }
  it("does not trust a file for its name", async () => {
    assert.equal((await decide("python3 manage.py --help")).decision, "deny");
  });
});

describe("round 1b: a script with no #!", () => {
  // `bash notexec` runs it though it has no #! and no exec bit: the interpreter opens it.
  for (const command of ["./legacy --help", "bash legacy --help", "sh ./legacy -h", "bash notexec --help"]) {
    it(`denies ${command}`, async () => {
      assert.equal((await decide(command)).decision, "deny");
    });
  }
  for (const command of ["./notexec --help", "./compiled --help"]) {
    it(`stays silent for ${command}`, async () => {
      assert.equal((await decide(command)).decision, "silent");
    });
  }
});

describe("round 1b: a command the grammar cannot parse", () => {
  // Valid bash that runs the probe; the grammar cannot parse a heredoc opened before `;`.
  const hidden = "cat <<EOF; ./deploy.sh --help\nbody\nEOF";

  it("asks about a help flag it cannot place, and denies a subagent", async () => {
    const { decision, reason } = await decide(hidden);
    assert.equal(decision, "ask");
    assert.match(reason, /cannot be parsed and it carries a help flag/);
    const payload = { tool_name: "Bash", tool_input: { command: hidden }, cwd: dir, agent_id: "agent-1", transcript_path: transcript([]) };
    assert.equal(decisionOf((await runHook("flag-probe", payload, { cwd: dir })).answer), "deny");
  });

  it("stays silent when the unparsed command carries no help flag", async () => {
    assert.equal((await decide("cat <<EOF; ./deploy.sh --verbose\nbody\nEOF")).decision, "silent");
  });
});

describe("round 1 of review: which read vouches for which script", () => {
  it("a local read never vouches for a remote script of the same name", async () => {
    const history = [{ tool: "Read", input: { file_path: join(dir, "gen-config.sh") } }];
    assert.equal((await decide("ssh box './gen-config.sh --help'", history)).decision, "deny");
  });

  it("an earlier read is resolved in the directory it ran in", async () => {
    const history = [bash("head -40 deploy.sh", { cwd: "/somewhere/else" })];
    assert.equal((await decide("./deploy.sh --help", history)).decision, "deny");
    const here = [bash("head -40 deploy.sh", { cwd: dir })];
    assert.equal((await decide("./deploy.sh --help", here)).decision, "silent");
  });

  it("names the full path to read for a script found on PATH", async () => {
    const { reason } = await decide("deploy.sh --help", [], { PATH: `${dir}:${process.env.PATH}` });
    assert.match(reason, new RegExp(`head -40 ${join(dir, "deploy.sh").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  });
});

describe("round 1 of review: a malformed payload is not silence", () => {
  it("asks when the payload carries no command", async () => {
    const result = await runHook("flag-probe", { tool_name: "Bash", tool_input: {}, cwd: dir }, { cwd: dir });
    assert.equal(decisionOf(result.answer), "ask");
    assert.match(reasonOf(result.answer), /no tool_input\.command string/);
  });

  it("stays out of a call to another tool", async () => {
    const payload = { tool_name: "BashOutput", tool_input: { bash_id: "b1" }, cwd: dir };
    assert.equal(decisionOf((await runHook("flag-probe", payload, { cwd: dir })).answer), "silent");
  });
});
