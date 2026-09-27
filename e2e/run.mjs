// The vanilla end-to-end run.
//
// Builds a stock Claude Code container, publishes this repository's COMMITTED tree to it as a
// git remote, adds a marketplace that points at it through a `url` source (the same install
// path a GitHub source takes: Claude Code clones it into its cache and runs `npm ci
// --ignore-scripts` there), installs the plugin with Claude Code's own CLI, and then drives
// every scenario in e2e/scenarios.mjs through `claude -p`. What happened is read back from the
// tool stream, the transcript and the disk, and written to e2e/report/.
//
//   npm run e2e                       token from $CLAUDE_CODE_OAUTH_TOKEN or
//                                     ~/.config/jord0-hooks-e2e/token (make one: claude setup-token)
//   npm run e2e -- R1 F1              only those scenarios
//
// The token reaches the container as an environment variable only. It is never written to
// disk there, never passed on a command line, and the container is removed at the end.

import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { renderReport } from "./report.mjs";
import { SCENARIOS } from "./scenarios.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const OUT = join(HERE, "report");
const IMAGE = "jord0-hooks-e2e";
const TOKEN_FILE = join(homedir(), ".config", "jord0-hooks-e2e", "token");
const SCENARIO_TIMEOUT_MS = 6 * 60_000;
const MODEL = process.env.JORD0_E2E_MODEL ?? "sonnet";

/**
 * @typedef {object} Observed what a scenario left behind, for its check to judge
 * @property {Record<string, boolean>} exists each `probe` path, true if it exists afterwards
 * @property {(command: string) => string} bashResult the result text of the first Bash call running `command`
 * @property {string} transcript the main session transcript, raw JSONL
 * @property {string} everything the tool stream, the main transcript and every subagent transcript
 */

async function main() {
  const only = new Set(process.argv.slice(2));
  const scenarios = only.size ? SCENARIOS.filter((s) => only.has(s.id)) : SCENARIOS;
  const token = process.env.CLAUDE_CODE_OAUTH_TOKEN || readToken();
  const version = process.env.CLAUDE_CODE_VERSION || (await sh("npm", ["view", "@anthropic-ai/claude-code", "version"])).stdout.trim();
  const head = (await sh("git", ["rev-parse", "--short", "HEAD"], { cwd: ROOT })).stdout.trim();

  step(`building the vanilla image (Claude Code ${version})`);
  await must(sh("docker", ["build", "-q", "-t", IMAGE, "--build-arg", `CLAUDE_CODE_VERSION=${version}`, HERE]));

  // mkdtemp makes the directory 0700, and the container's user is not this one.
  const srv = mkdtempSync(join(tmpdir(), "jord0-hooks-e2e-"));
  chmodSync(srv, 0o755);
  step(`publishing the committed tree ${head} as a local git remote`);
  await must(sh("git", ["clone", "-q", "--bare", "--no-local", ROOT, join(srv, "jord0.hooks.git")]));
  mkdirSync(join(srv, "market", ".claude-plugin"), { recursive: true });
  writeFileSync(
    join(srv, "market", ".claude-plugin", "marketplace.json"),
    JSON.stringify({
      name: "jord0-e2e",
      owner: { name: "e2e" },
      metadata: { description: "The jord0.hooks end-to-end run: one plugin, served from a local git remote." },
      plugins: [{ name: "jord0-hooks", source: { source: "url", url: "file:///home/tester/srv/jord0.hooks.git" } }],
    }),
  );

  const name = `jord0-hooks-e2e-${Date.now()}`;
  step(`starting container ${name}`);
  await must(
    sh("docker", ["run", "-d", "--rm", "--name", name, "-e", "CLAUDE_CODE_OAUTH_TOKEN", "-v", `${srv}:/srv:ro`, IMAGE, "sleep", "infinity"], {
      env: { ...process.env, CLAUDE_CODE_OAUTH_TOKEN: token },
    }),
  );
  const exec = (script, options) => sh("docker", ["exec", "-i", name, "bash", "-c", script], options);

  const report = { head, version, model: MODEL, started: new Date().toISOString(), install: {}, scenarios: [] };
  try {
    step("installing the plugin with Claude Code's own CLI");
    // git refuses to clone a repository another user owns, so the tester takes its own copy
    // of the mount instead of being told to trust someone else's directory.
    await must(exec("cp -r /srv ~/srv"));
    const added = await exec("claude plugin marketplace add ~/srv/market 2>&1");
    if (added.code !== 0) throw new Error(`marketplace add failed:\n${added.stdout}${added.stderr}`);
    const installed = await exec("claude plugin install jord0-hooks@jord0-e2e 2>&1");
    const deps = await exec("find ~/.claude/plugins/cache -maxdepth 6 -type d -name web-tree-sitter 2>/dev/null");
    const claude = await exec("claude --version");
    report.install = {
      marketplace: added.stdout.trim(),
      install: installed.stdout.trim(),
      dependenciesInstalled: deps.stdout.trim() !== "",
      dependencyPath: deps.stdout.trim(),
      claudeVersion: claude.stdout.trim(),
      pass: installed.code === 0 && deps.stdout.trim() !== "",
    };
    if (!report.install.pass) throw new Error(`install failed:\n${installed.stdout}${installed.stderr}`);

    for (const scenario of scenarios) {
      step(`${scenario.id} ${scenario.hook}: ${scenario.title}`);
      const result = await runScenario(exec, scenario);
      report.scenarios.push(result);
      console.log(`    ${result.pass ? "PASS" : "FAIL"}  ${result.seconds}s  $${result.cost ?? "?"}`);
    }
  } finally {
    await sh("docker", ["rm", "-f", name]);
  }
  report.finished = new Date().toISOString();
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(join(OUT, "report.html"), renderReport(report));
  const passed = report.scenarios.filter((s) => s.pass).length;
  console.log(`\nE2E: ${passed}/${report.scenarios.length} scenarios passed · install ${report.install.pass ? "ok" : "FAILED"} · ${join(OUT, "report.html")}`);
  process.exitCode = passed === report.scenarios.length && report.install.pass ? 0 : 1;
}

async function runScenario(exec, scenario) {
  const ws = `/home/tester/ws-${scenario.id}`;
  await must(exec(`rm -rf ${ws} && mkdir -p ${ws} && cd ${ws} && ${scenario.setup}`));
  const promptFile = `/tmp/prompt-${scenario.id}.txt`;
  await must(exec(`cat > ${promptFile}`, { input: scenario.prompt }));
  const mode = scenario.mode === "bypass" ? "--dangerously-skip-permissions" : "--permission-mode default";
  const started = Date.now();
  const ran = await exec(
    `cd ${ws} && claude -p "$(cat ${promptFile})" --output-format stream-json --verbose --model ${MODEL} --max-turns 12 ${mode}`,
    { timeoutMs: SCENARIO_TIMEOUT_MS },
  );
  const seconds = Math.round((Date.now() - started) / 1000);

  const events = ran.stdout.split("\n").flatMap((line) => {
    try {
      return [JSON.parse(line)];
    } catch {
      return [];
    }
  });
  const slug = ws.replace(/[^A-Za-z0-9]/g, "-");
  const transcript = (await exec(`cat $(ls -t ~/.claude/projects/${slug}/*.jsonl 2>/dev/null | head -1) 2>/dev/null`)).stdout;
  const subagents = (await exec(`cat ~/.claude/projects/${slug}/*/subagents/*.jsonl 2>/dev/null`)).stdout;
  const exists = {};
  for (const path of scenario.probe) {
    const target = path.startsWith("~/") ? `$HOME/${path.slice(2)}` : `${ws}/${path}`;
    exists[path] = (await exec(`test -e "${target}"`)).code === 0;
  }

  const uses = new Map();
  const results = new Map();
  for (const event of events) {
    for (const block of event.message?.content ?? []) {
      if (block.type === "tool_use" && block.name === "Bash") uses.set(block.id, String(block.input?.command ?? ""));
      if (block.type === "tool_result") results.set(block.tool_use_id, { isError: block.is_error === true, text: textOf(block.content) });
    }
  }
  const bashResult = (command) => {
    for (const [id, text] of uses) {
      if (text.trim() === command || text.includes(command)) {
        const r = results.get(id);
        return r ? `${r.isError ? "[error] " : ""}${r.text}`.slice(0, 1200) : "(no result recorded)";
      }
    }
    return "(the command was never run)";
  };
  const everything = [ran.stdout, transcript, subagents].join("\n");
  const verdict = scenario.check({ exists, bashResult, transcript, everything });
  const final = events.findLast((e) => e.type === "result");
  const init = events.find((e) => e.type === "system" && e.subtype === "init");

  writeFileSync(join(ensure(join(OUT, "sessions")), `${scenario.id}.jsonl`), transcript);
  writeFileSync(join(OUT, "sessions", `${scenario.id}.stream.jsonl`), ran.stdout);
  return {
    id: scenario.id,
    hook: scenario.hook,
    title: scenario.title,
    mode: scenario.mode,
    prompt: scenario.prompt,
    expect: scenario.expect,
    pass: Boolean(verdict.pass),
    evidence: verdict.evidence,
    exists,
    finalText: String(final?.result ?? "").slice(0, 1500),
    seconds,
    cost: final?.total_cost_usd?.toFixed?.(4),
    pluginLoaded: JSON.stringify(init?.plugins ?? init ?? {}).includes("jord0-hooks"),
    exitCode: ran.code,
  };
}

function textOf(content) {
  if (typeof content === "string") return content;
  return (content ?? []).filter((b) => b?.type === "text").map((b) => b.text).join("\n");
}

function ensure(dir) {
  mkdirSync(dir, { recursive: true });
  return dir;
}

function readToken() {
  try {
    const token = readFileSync(TOKEN_FILE, "utf8").trim();
    if (token) return token;
    throw new Error("empty");
  } catch {
    console.error(
      `No token. Run \`claude setup-token\` in your own terminal and save it:\n` +
        `  mkdir -p ${dirname(TOKEN_FILE)} && install -m 600 /dev/stdin ${TOKEN_FILE} <<< '<token>'\n` +
        "or export CLAUDE_CODE_OAUTH_TOKEN for this run.",
    );
    process.exit(2);
  }
}

function step(text) {
  console.log(`▸ ${text}`);
}

async function must(promise) {
  const result = await promise;
  if (result.code !== 0) throw new Error(`command failed (${result.code}): ${result.stderr || result.stdout}`);
  return result;
}

/**
 * @param {string} file
 * @param {string[]} args
 * @param {{ cwd?: string, env?: NodeJS.ProcessEnv, input?: string, timeoutMs?: number }} [options]
 * @returns {Promise<{ code: number, stdout: string, stderr: string }>}
 */
function sh(file, args, { cwd, env, input, timeoutMs } = {}) {
  return new Promise((resolve) => {
    const child = spawn(file, args, { cwd, env: env ?? process.env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = timeoutMs ? setTimeout(() => child.kill("SIGKILL"), timeoutMs) : null;
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
    child.stdin.end(input ?? "");
  });
}

await main();
