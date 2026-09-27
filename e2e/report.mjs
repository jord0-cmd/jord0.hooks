// Renders the end-to-end run as one self-contained HTML page: the install, then every scenario
// grouped by hook, each with what was expected, the verdict, and the evidence read back from the
// session. Same phosphor as the docs site: clay on near-black, JetBrains Mono throughout.

const HOOK_ORDER = ["RECOVERABLE", "FLAG-PROBE", "DONE-GATE"];
const HOOK_LINE = {
  RECOVERABLE: "PreToolUse · Bash · a delete git cannot give back",
  "FLAG-PROBE": "PreToolUse · Bash · --help on a script nobody read",
  "DONE-GATE": "Stop · a “done” with no test run since the last edit",
};

const esc = (value) =>
  String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

/** @param {any} report the object e2e/run.mjs writes to report.json */
export function renderReport(report) {
  const total = report.scenarios.length;
  const passed = report.scenarios.filter((s) => s.pass).length;
  const allGreen = passed === total && report.install.pass;
  const groups = HOOK_ORDER.map((hook) => ({ hook, rows: report.scenarios.filter((s) => s.hook === hook) })).filter((g) => g.rows.length);

  return `<title>jord0.hooks Vanilla Run</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;600;800&display=swap">
<style>
:root {
  color-scheme: dark;
  --ground: #0d1117;
  --panel: #151b23;
  --rule: #2a313b;
  --ink: #c9c2b8;
  --muted: #8b949e;
  --clay: #d97757;
  --amber: #ffb000;
  --pass: #3fb950;
  --fail: #f85149;
  --mono: "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
body { background: var(--ground); color: var(--ink); font: 14px/1.6 var(--mono); }
main { max-width: 1040px; margin: 0 auto; padding-inline: 20px; padding-block: 40px 64px; display: grid; gap: 40px; }
h1, h2 { font-weight: 800; text-wrap: balance; margin: 0; }
h1 { font-size: clamp(26px, 5vw, 38px); color: var(--clay); letter-spacing: -0.01em; }
h1 .cursor { display: inline-block; width: 0.55em; height: 0.9em; background: var(--clay); vertical-align: -0.08em; margin-left: 0.12em; }
@media (prefers-reduced-motion: no-preference) { h1 .cursor { animation: blink 1.1s steps(1) infinite; } }
@keyframes blink { 50% { opacity: 0; } }
h2 { font-size: 18px; color: var(--ink); display: flex; gap: 12px; align-items: baseline; flex-wrap: wrap; }
h2 small { font-weight: 400; font-size: 12px; color: var(--muted); letter-spacing: 0.02em; }
header { display: grid; gap: 16px; }
.lede { color: var(--muted); max-width: 70ch; margin: 0; }
.facts { display: flex; flex-wrap: wrap; gap: 8px 24px; margin: 0; padding: 0; list-style: none; font-size: 12px; color: var(--muted); }
.facts b { color: var(--ink); font-weight: 600; }
.tally { display: inline-flex; gap: 10px; align-items: center; font-size: 13px; font-weight: 800; letter-spacing: 0.08em; text-transform: uppercase; padding: 6px 12px; border: 1px solid currentColor; width: fit-content; }
.tally.ok { color: var(--pass); } .tally.bad { color: var(--fail); }
section { display: grid; gap: 14px; }
.scenario { border: 1px solid var(--rule); border-left: 3px solid var(--rule); background: var(--panel); padding: 16px 18px; display: grid; gap: 10px; }
.scenario.pass { border-left-color: var(--pass); } .scenario.fail { border-left-color: var(--fail); }
.row { display: flex; gap: 12px; align-items: baseline; flex-wrap: wrap; }
.id { color: var(--amber); font-weight: 800; }
.title { color: var(--ink); font-weight: 600; flex: 1 1 320px; }
.verdict { font-weight: 800; letter-spacing: 0.1em; font-size: 12px; }
.pass .verdict { color: var(--pass); } .fail .verdict { color: var(--fail); }
.meta { font-size: 12px; color: var(--muted); display: flex; gap: 6px 18px; flex-wrap: wrap; font-variant-numeric: tabular-nums; }
.expect { margin: 0; } .expect span { color: var(--muted); }
pre { margin: 0; padding: 12px 14px; background: var(--ground); border: 1px solid var(--rule); overflow-x: auto; white-space: pre-wrap; word-break: break-word; font: 12px/1.55 var(--mono); color: var(--ink); max-height: 320px; }
details summary { cursor: pointer; color: var(--clay); font-size: 12px; }
details summary:focus-visible, a:focus-visible { outline: 2px solid var(--amber); outline-offset: 2px; }
details[open] summary { margin-bottom: 8px; }
.install pre { max-height: 200px; }
footer { color: var(--muted); font-size: 12px; border-top: 1px solid var(--rule); padding-top: 16px; }
</style>
<main>
  <header>
    <h1>jord0.hooks · vanilla run<span class="cursor" aria-hidden="true"></span></h1>
    <p class="lede">A stock Claude Code in a fresh container: the npm package, an empty home, no CLAUDE.md, no other hooks. The plugin was installed from its committed tree through a marketplace, and each scenario ran through <code>claude -p</code>. Every verdict below is read from the session and the disk afterwards, never from the model's own account.</p>
    <ul class="facts">
      <li>commit <b>${esc(report.head)}</b></li>
      <li>Claude Code <b>${esc(report.install.claudeVersion || report.version)}</b></li>
      <li>model <b>${esc(report.model)}</b></li>
      <li>ran <b>${esc(report.started)}</b></li>
    </ul>
    <div class="tally ${allGreen ? "ok" : "bad"}">${passed} / ${total} scenarios passed · install ${report.install.pass ? "ok" : "failed"}</div>
  </header>

  <section class="install" aria-labelledby="install">
    <h2 id="install">Install <small>marketplace → claude plugin install → npm ci --ignore-scripts</small></h2>
    <article class="scenario ${report.install.pass ? "pass" : "fail"}">
      <div class="row"><span class="id">S0</span><span class="title">the plugin installs and its dependencies arrive without any step by the user</span><span class="verdict">${report.install.pass ? "PASS" : "FAIL"}</span></div>
      <p class="expect"><span>dependencies:</span> ${report.install.dependenciesInstalled ? esc(report.install.dependencyPath) : "not found in the plugin cache"}</p>
      <details><summary>CLI output</summary><pre>${esc(`${report.install.marketplace}\n${report.install.install}`)}</pre></details>
    </article>
  </section>

  ${groups
    .map(
      (g) => `<section aria-labelledby="h-${g.hook}">
    <h2 id="h-${g.hook}">${esc(g.hook)} <small>${esc(HOOK_LINE[g.hook])}</small></h2>
    ${g.rows.map(scenario).join("\n    ")}
  </section>`,
    )
    .join("\n\n  ")}

  <footer>Generated by <code>e2e/run.mjs</code>. Raw sessions for every scenario are kept beside this page in <code>e2e/report/sessions/</code>.</footer>
</main>
`;
}

function scenario(s) {
  const files = Object.entries(s.exists ?? {})
    .map(([path, present]) => `${path} ${present ? "exists" : "absent"}`)
    .join(" · ");
  return `<article class="scenario ${s.pass ? "pass" : "fail"}">
      <div class="row"><span class="id">${esc(s.id)}</span><span class="title">${esc(s.title)}</span><span class="verdict">${s.pass ? "PASS" : "FAIL"}</span></div>
      <div class="meta"><span>mode ${esc(s.mode === "bypass" ? "bypassPermissions" : "Manual")}</span><span>${esc(s.seconds)} s</span><span>$${esc(s.cost ?? "?")}</span>${files ? `<span>${esc(files)}</span>` : ""}</div>
      <p class="expect"><span>expected:</span> ${esc(s.expect)}</p>
      <pre>${esc(s.evidence)}</pre>
      <details><summary>prompt and final reply</summary><pre>${esc(`PROMPT\n${s.prompt}\n\nFINAL REPLY\n${s.finalText}`)}</pre></details>
    </article>`;
}
