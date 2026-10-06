#!/usr/bin/env node
'use strict';
/**
 * walkthrough: build docs/rebuild/walkthrough.html from docs/rebuild/screens/index.json and its SVGs.
 *
 *   node scripts/walkthrough.js [--screens DIR] [--checks FILE] [--out FILE]
 *
 * One section per scene: caption(s), the three panes side by side (stacked on narrow screens, click
 * to enlarge), the room-log excerpt, the scripted waits (screens/waits.jsonl) and the checks from
 * docs/rebuild/checks.json ({scene: [{check, pass, evidence, kind?, status?: pass|fail|warn}], _meta?: {cost, run, note}};
 * a behavioural check over its threshold shows as WARN, apart from the failures).
 * The output is one self-contained HTML file: SVGs inlined, no external requests.
 */
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..');

const SCENES = {
  Metrics: ['Slim build vs the baselines', 'Room-caused wakes ≤ 12 (vole-8126: 39, Phase 0 otter-0813: 23, previous slim run stoat-3644: 28); small join text; noise ≈ 1.4 per capture; no red lines; model calls per card'],
  S1: ['alice joins with no room open', 'Room created; the orch started as a background job (no window); one room row for alice; the orch lists alice; room task #1'],
  S2: ['bob joins', 'bob nested in alice\'s room row, alice in bob\'s; the orch lists both; no stray rows; alice sees the chat line "bob joined" and "+bob joined" on her room row'],
  S3: ['Pairing with no plan', '@room both ways (receipt line, one wake, exact words); bob\'s Claude asks alice\'s Claude by SendMessage and gets an answer; no card; the orch is not woken'],
  S4: ['"Let\'s plan"', 'bob @room @orch let\'s plan …; the orch writes a plan and proposes it; it opens in the native plan view in both terminals'],
  S5: ['Object, revise, agree', 'bob objects with a note (byte-exact); the orch revises; both agree; a decision citing both'],
  S6: ['Shared tasks', 'alice\'s Claude adds and claims a task; the orch applies it natively; rows and sub-human tasks show it; a non-owner done reaches the task tool and is refused (the gate check is marked SYNTHETIC when the orch declined before reaching it); the owner\'s done with evidence completes it'],
  S7: ['Stray typing in a row view', 'The row view shows the read-only hint; nothing is posted; the typed text reaches the row only when its hold next returns (then the one-line read-only reply), or not at all'],
  S8: ['Resilience', '/clear keeps alice\'s rows; bob --continue: rows return with no prompt (row-rewake) and the monitor still wakes him'],
  S9: ['The orch takes no typed input', 'A viewer attaches (claude attach) and types: refused with the hint; no orch turn'],
  S9b: ['A multi-line post stays nested', 'alice posts three lines with @room, the later two reading like a decision and a sign-off: byte-exact in the log; bob\'s pane shows them nested under "alice: …" (│), never as bare room lines; no consent entry'],
  S10: ['Leave', 'alice exits; bob sees the chat line "alice left" once the leave settles (8 s); bob exits; the reaper completes task 1 and stops the orch; claude agents no longer lists it; each human saw a join/leave notice'],
};
const ORDER = Object.keys(SCENES);
const SEAT_ORDER = ['orch', 'viewer', 'alice', 'bob'];

function args() {
  const a = process.argv.slice(2), o = {};
  for (let i = 0; i < a.length; i++) if (a[i].startsWith('--')) o[a[i].slice(2)] = a[++i];
  return o;
}

const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const seatOf = s => s.replace(/^shd?-/, '');
const seatRank = s => { const i = SEAT_ORDER.indexOf(seatOf(s)); return i < 0 ? 99 : i; };
const sceneRank = s => { const i = ORDER.indexOf(s); return i < 0 ? 1000 : i; };
const fmtTime = t => { const d = new Date(t); return isNaN(d) ? '' : d.toISOString().slice(11, 19); };

function inlineSvg(file) {
  let s;
  try { s = fs.readFileSync(file, 'utf8'); } catch { return '<div class="missing">missing ' + esc(path.basename(file)) + '</div>'; }
  s = s.replace(/<\?xml[^>]*\?>/, '').replace(/<!DOCTYPE[^>]*>/i, '');
  if (/<script/i.test(s)) return '<div class="missing">refused: svg contains script</div>';
  // let CSS size it: drop fixed width/height on the root element (viewBox stays)
  return s.replace(/<svg\b([^>]*)>/, (m, attrs) => '<svg' + attrs.replace(/\s(width|height)="[^"]*"/g, '') + ' preserveAspectRatio="xMinYMin meet">');
}

/** "Slim build vs baselines" table from checks.json _metrics ({run, baseline, phase0}); '' when absent. */
function metricsSection(m) {
  if (!m || !m.run || !m.baseline) return '';
  const R = m.run, B = m.baseline, P = m.phase0 || {}, S = m.prev || null, seats = ['orch', 'alice', 'bob'];
  const g = (o, ...ks) => ks.reduce((x, k) => (x == null ? x : x[k]), o);
  const delta = (now, base) => {
    if (now == null || base == null) return '<td></td>';
    const d = now - base;
    const cls = d === 0 ? '' : d < 0 ? 'better' : 'worse';
    const pct = base ? ` (${d > 0 ? '+' : ''}${Math.round((d / base) * 100)}%)` : '';
    return `<td class="${cls}">${esc((d > 0 ? '+' : '') + (Math.round(d * 100) / 100) + pct)}</td>`;
  };
  const rows = [];
  for (const s of seats) rows.push([`Room-caused model wakes · ${s}`, R.seats[s].wakes.turns, B.wakes[s], g(P, 'wakes', s), g(S, 'wakes', s)]);
  rows.push([`Room-caused model wakes · total (target ≤ ${(m.target && m.target.wakes) ?? '?'})`, R.total.wakes, B.wakes.total, g(P, 'wakes', 'total'), g(S, 'wakes', 'total')]);
  for (const s of seats) rows.push([`Join block chars · ${s}`, R.seats[s].injected.join, g(B, 'joinChars', s), g(P, 'joinChars', s), g(S, 'joinChars', s)]);
  for (const s of seats) rows.push([`Hook-injected chars over the run · ${s}`, R.seats[s].injected.total, g(B, 'injected', s), g(P, 'injected', s), g(S, 'injected', s)]);
  rows.push([`UI noise lines per capture · all seats (target ≤ ${(m.target && m.target.noisePerCapture) ?? '?'})`, R.total.noise.perCapture, B.noise.perCapture, g(P, 'noise', 'perCapture'), g(S, 'noise', 'perCapture')]);
  rows.push(['… excluding "Waiting for N background agents"', R.total.noise.perCaptureExWaiting, B.noise.perCaptureExWaiting, g(P, 'noise', 'perCaptureExWaiting'), g(S, 'noise', 'perCaptureExWaiting')]);
  for (const [k, label] of [['monitor', '"Monitor event" lines'], ['waiting', '"Waiting for N background agents" lines'], ['hookError', '"hook error" lines'], ['blocked', '"blocked by hook" lines'], ['invalid', '"Invalid tool parameters" lines']]) rows.push([`${label} (all captures)`, R.total.noise[k], B.noise[k], g(P, 'noise', k), g(S, 'noise', k)]);
  rows.push(['Red or "hook error" lines (all captures)', R.total.noise.red, null, null, g(S, 'red')]);
  rows.push(['Model calls per proposal review (open + after the answer)', R.total.cards.perCard, null, null, g(S, 'cardsPerCard')]);
  return `<section id="metrics-table">
<header><h2><span class="sid">M</span>Slim build vs baselines</h2><p class="must">This run (room ${esc(R.room)}, ${esc(R.total.noise.captures)} captures of the orch, alice and bob) against vole-8126 (${esc(B.noise.captures)} captures), the Phase 0 run otter-0813 (${esc(g(P, 'noise', 'captures'))} captures)${S ? ` and the previous slim run ${esc(S.run)} (${esc(g(S, 'noise', 'captures'))} captures)` : ''}, all measured by scripts/metrics.js from the seats' transcripts and the pane captures. The orch's pane is <code>claude logs</code> of its background job.</p></header>
<div class="metrics"><table><thead><tr><th>Metric</th><th>vole-8126</th><th>Phase 0</th>${S ? `<th>${esc(S.run)}</th>` : ''}<th>this run</th><th>vs vole</th><th>vs Phase 0</th>${S ? `<th>vs ${esc(S.run)}</th>` : ''}</tr></thead><tbody>
${rows.map(([l, now, base, p0, prev]) => `<tr><td>${esc(l)}</td><td>${esc(base == null ? '–' : base)}</td><td>${esc(p0 == null ? '–' : p0)}</td>${S ? `<td>${esc(prev == null ? '–' : prev)}</td>` : ''}<td>${esc(now == null ? '–' : now)}</td>${delta(now, base)}${delta(now, p0)}${S ? delta(now, prev) : ''}</tr>`).join('\n')}
</tbody></table>
<p class="note">Wakes: a sub-human Monitor event, a peer delivery (SendMessage from another session) or the row-rewake wake that starts an assistant turn; adjacent triggers in one turn count once. Monitor notices delivered this run: ${esc(R.total.notices)}. Noise: lines matching "Monitor event", "Waiting for N background agents", "hook error", "blocked by hook" or "Invalid tool parameters", over every capture; the @room receipt "Operation stopped by hook: ✓ sent" is not noise (${esc(R.total.noise.receipts)} receipt lines). Red lines are read from the colored captures. Reviews: ${esc(R.total.cards.count)} proposals opened (plan view or card), ${esc(R.total.cards.toCard)} model call(s) to open one and ${esc(R.total.cards.after)} after the answer, on average.</p></div>
</section>`;
}

function build({ screens, checksFile, out }) {
  const index = readJson(path.join(screens, 'index.json'), []);
  const checksAll = readJson(checksFile, {});
  const meta = checksAll._meta || {};
  const waits = [];
  try {
    for (const l of fs.readFileSync(path.join(screens, 'waits.jsonl'), 'utf8').split('\n')) if (l.trim()) try { waits.push(JSON.parse(l)); } catch { /* skip */ }
  } catch { /* none */ }

  // group: scene -> steps (by caption, in time order) -> latest record per session
  const scenes = new Map();
  for (const r of index) {
    if (!scenes.has(r.scene)) scenes.set(r.scene, { steps: new Map(), log: new Map() });
    const sc = scenes.get(r.scene);
    const key = r.caption || '';
    if (!sc.steps.has(key)) sc.steps.set(key, { caption: key, time: r.time, panes: new Map() });
    const st = sc.steps.get(key);
    st.panes.set(r.session, r);
    st.time = r.time;
    for (const e of r.log || []) sc.log.set(e.id, e);
  }
  const sceneIds = [...new Set([...scenes.keys(), ...Object.keys(checksAll).filter(k => !k.startsWith('_'))])].sort((a, b) => sceneRank(a) - sceneRank(b));

  // a check's status: pass | fail | warn (a behavioural check over its threshold; older checks.json has only pass)
  const status = c => c.status || (c.pass ? 'pass' : 'fail');
  let pass = 0, fail = 0, warn = 0;
  for (const k of sceneIds) for (const c of checksAll[k] || []) { const s = status(c); s === 'pass' ? pass++ : s === 'warn' ? warn++ : fail++; }
  const sceneStatus = cs => (!cs.length ? 'none' : cs.some(c => status(c) === 'fail') ? 'fail' : cs.some(c => status(c) === 'warn') ? 'warn' : 'pass');

  const toc = sceneIds.map(id => {
    const cs = checksAll[id] || [];
    const st = sceneStatus(cs);
    return `<a class="toc-item ${st}" href="#${esc(id)}"><span class="dot"></span>${esc(id)}<span class="toc-title">${esc((SCENES[id] || [id])[0])}</span></a>`;
  }).join('');

  const sections = sceneIds.map(id => {
    const sc = scenes.get(id) || { steps: new Map(), log: new Map() };
    const [title, must] = SCENES[id] || [id, ''];
    const cs = checksAll[id] || [];
    const steps = [...sc.steps.values()].sort((a, b) => String(a.time).localeCompare(String(b.time)));
    const stepHtml = steps.map((st, i) => {
      const panes = [...st.panes.values()].sort((a, b) => seatRank(a.session) - seatRank(b.session));
      return `<div class="step">
  <p class="caption"><span class="stepno">${steps.length > 1 ? `${i + 1}/${steps.length}` : ''}</span>${esc(st.caption)} <time>${esc(fmtTime(st.time))}</time></p>
  <div class="panes">${panes.map(r => `
    <figure class="pane" tabindex="0" title="click to enlarge">
      <figcaption>${esc(seatOf(r.session))}</figcaption>
      ${inlineSvg(path.join(screens, r.svg))}
    </figure>`).join('')}
  </div>
</div>`;
    }).join('\n');
    const log = [...sc.log.values()].sort((a, b) => a.id - b.id);
    const logHtml = log.length ? `<details class="log" open><summary>Room log · ${log.length} entr${log.length === 1 ? 'y' : 'ies'}</summary><table>
<thead><tr><th>#</th><th>time</th><th>from</th><th>kind</th><th>text</th></tr></thead><tbody>
${log.map(e => `<tr><td>${esc(e.id)}</td><td>${esc(fmtTime(e.at))}</td><td>${esc(e.from)}${e.via ? `<span class="via">${esc(e.via)}</span>` : ''}</td><td><code>${esc(e.kind)}</code>${e.plan_hash ? ` <code>${esc(String(e.plan_hash).slice(0, 6))}</code>` : ''}${e.refs ? ` <span class="refs">refs ${esc(e.refs.join(', '))}</span>` : ''}</td><td class="text">${esc(e.text)}</td></tr>`).join('\n')}
</tbody></table></details>` : '';
    const w = waits.filter(x => x.scene === id);
    const waitHtml = w.length ? `<details class="waits"><summary>Driver waits · ${w.filter(x => x.ok).length}/${w.length} met</summary><ul>${w.map(x => `<li class="${x.ok ? 'pass' : 'fail'}"><span class="mark">${x.ok ? '✓' : '✗'}</span>${esc(x.what)} <span class="ms">${(x.ms / 1000).toFixed(1)}s</span></li>`).join('')}</ul></details>` : '';
    const checkHtml = cs.length ? `<ul class="checks">${cs.map(c => `<li class="${status(c)}"><span class="badge">${status(c).toUpperCase()}</span><div><strong>${esc(c.check)}</strong>${c.kind === 'behavioural' ? `<span class="kind">behavioural · ${esc(c.value)} vs ≤ ${esc(c.threshold)}</span>` : ''}${c.evidence ? `<p class="evidence">${esc(c.evidence)}</p>` : ''}</div></li>`).join('')}</ul>` : '<p class="nochecks">No checks recorded for this scene.</p>';
    return `<section id="${esc(id)}">
<header><h2><span class="sid">${esc(id)}</span>${esc(title)}</h2><p class="must">Must show: ${esc(must)}</p></header>
${steps.length ? stepHtml : '<p class="nochecks">No screens captured for this scene.</p>'}
<div class="meta-grid">${checkHtml}${logHtml}${waitHtml}</div>
</section>`;
  }).join('\n');

  const metricsHtml = metricsSection(checksAll._metrics);

  const summary = [
    `${sceneIds.length} scene${sceneIds.length === 1 ? '' : 's'}`,
    `${index.length} capture${index.length === 1 ? '' : 's'}`,
    pass + fail + warn ? `${pass}/${pass + fail + warn} checks pass${warn ? ` (${warn} behavioural warning${warn === 1 ? '' : 's'})` : ''}` : 'no checks yet',
    meta.cost ? `run cost ${meta.cost}` : '',
    index.length ? `captured ${String(index[0].time).slice(0, 10)}` : '',
  ].filter(Boolean).join(' · ');

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>sub-human slim build</title>
<style>
:root {
  --bg: #f6f6f3; --surface: #ffffff; --ink: #1d1f23; --muted: #626872; --line: #dddcd5;
  --accent: #3b5bdb; --pass: #1f7a3e; --pass-bg: #e3f3e8; --fail: #b42318; --fail-bg: #fde8e6; --warn: #9a6700; --warn-bg: #fdf3dc;
  --code-bg: #efeee9; --shadow: 0 1px 2px rgba(0,0,0,.06), 0 4px 16px rgba(0,0,0,.05);
  color-scheme: light;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --bg: #111317; --surface: #191c21; --ink: #e6e8ec; --muted: #9aa1ad; --line: #2c3038;
    --accent: #8ea2ff; --pass: #5fd08a; --pass-bg: #15291d; --fail: #ff8a7a; --fail-bg: #331715; --warn: #f0b45a; --warn-bg: #2e2412;
    --code-bg: #22262d; --shadow: none; color-scheme: dark;
  }
}
:root[data-theme="dark"] {
  --bg: #111317; --surface: #191c21; --ink: #e6e8ec; --muted: #9aa1ad; --line: #2c3038;
  --accent: #8ea2ff; --pass: #5fd08a; --pass-bg: #15291d; --fail: #ff8a7a; --fail-bg: #331715; --warn: #f0b45a; --warn-bg: #2e2412;
  --code-bg: #22262d; --shadow: none; color-scheme: dark;
}
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body { margin: 0; background: var(--bg); color: var(--ink); font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; }
.wrap { max-width: 1440px; margin: 0 auto; padding: 24px 16px 64px; }
h1 { font-size: 26px; margin: 0 0 4px; letter-spacing: -.01em; }
.sub { color: var(--muted); margin: 0 0 20px; }
code { font: 12.5px ui-monospace, "SF Mono", Menlo, Consolas, monospace; background: var(--code-bg); padding: 1px 5px; border-radius: 4px; }
nav.toc { display: flex; flex-wrap: wrap; gap: 6px; margin: 0 0 28px; }
.toc-item { display: inline-flex; align-items: center; gap: 6px; padding: 4px 10px; border: 1px solid var(--line); border-radius: 999px; background: var(--surface); color: var(--ink); text-decoration: none; font-size: 13px; font-weight: 600; }
.toc-item .toc-title { font-weight: 400; color: var(--muted); }
.toc-item .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--line); }
.toc-item.pass .dot { background: var(--pass); } .toc-item.fail .dot { background: var(--fail); } .toc-item.warn .dot { background: var(--warn); }
section { background: var(--surface); border: 1px solid var(--line); border-radius: 12px; padding: 18px 18px 14px; margin: 0 0 22px; box-shadow: var(--shadow); scroll-margin-top: 12px; }
section h2 { font-size: 19px; margin: 0; display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; }
.sid { font: 600 13px ui-monospace, Menlo, monospace; color: var(--accent); border: 1px solid var(--accent); border-radius: 6px; padding: 0 6px; }
.must { margin: 4px 0 12px; color: var(--muted); font-size: 14px; }
.step { margin: 12px 0 16px; }
.caption { margin: 0 0 8px; font-weight: 500; }
.caption time { color: var(--muted); font: 12px ui-monospace, Menlo, monospace; margin-left: 6px; }
.stepno { color: var(--muted); font: 12px ui-monospace, Menlo, monospace; margin-right: 8px; }
.panes { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; }
.pane { margin: 0; min-width: 0; cursor: zoom-in; outline: none; }
.pane figcaption { font: 600 12px ui-monospace, Menlo, monospace; color: var(--muted); margin: 0 0 4px; text-transform: uppercase; letter-spacing: .06em; }
.pane svg { display: block; width: 100%; height: auto; border-radius: 9px; }
.pane:focus-visible svg { box-shadow: 0 0 0 3px var(--accent); }
.panes.zoomed { grid-template-columns: minmax(0, 1fr); }
.panes.zoomed .pane { display: none; cursor: zoom-out; }
.panes.zoomed .pane.on { display: block; overflow-x: auto; }
.panes.zoomed .pane.on svg { min-width: 960px; } /* readable size on phones: scroll sideways */
.log { overflow-x: auto; }
.missing { padding: 24px; border: 1px dashed var(--line); border-radius: 9px; color: var(--muted); font-size: 13px; }
.meta-grid { display: grid; gap: 12px; }
.checks { list-style: none; margin: 0; padding: 0; display: grid; gap: 6px; }
.checks li { display: flex; gap: 10px; align-items: flex-start; padding: 8px 10px; border-radius: 8px; }
.checks li.pass { background: var(--pass-bg); } .checks li.fail { background: var(--fail-bg); } .checks li.warn { background: var(--warn-bg); }
.kind { display: block; color: var(--muted); font-size: 12px; }
.badge { font: 700 11px ui-monospace, Menlo, monospace; padding: 2px 6px; border-radius: 4px; color: var(--surface); flex: none; margin-top: 2px; }
.pass .badge { background: var(--pass); } .fail .badge { background: var(--fail); } .warn .badge { background: var(--warn); }
.evidence { margin: 2px 0 0; color: var(--muted); font-size: 13.5px; overflow-wrap: anywhere; }
.nochecks { color: var(--muted); font-size: 14px; margin: 0; }
details { border: 1px solid var(--line); border-radius: 8px; padding: 6px 10px; }
summary { cursor: pointer; font-weight: 600; font-size: 14px; }
.log table { width: 100%; border-collapse: collapse; font-size: 13px; margin-top: 6px; }
.log th, .log td { text-align: left; padding: 4px 8px 4px 0; border-top: 1px solid var(--line); vertical-align: top; }
.log th { color: var(--muted); font-weight: 600; }
.log td.text { white-space: pre-wrap; overflow-wrap: anywhere; }
.via { color: var(--muted); font-size: 11px; margin-left: 4px; }
.via::before { content: "via="; }
.refs { color: var(--muted); font-size: 12px; }
.waits ul { list-style: none; margin: 6px 0 0; padding: 0; font-size: 13px; }
.waits li { padding: 2px 0; overflow-wrap: anywhere; }
.waits .mark { display: inline-block; width: 18px; font-weight: 700; }
.waits .pass .mark { color: var(--pass); } .waits .fail .mark { color: var(--fail); }
.ms { color: var(--muted); font-size: 12px; }
.metrics { overflow-x: auto; }
.metrics table { width: 100%; border-collapse: collapse; font-size: 14px; margin-top: 8px; }
.metrics th, .metrics td { text-align: right; padding: 5px 10px; border-top: 1px solid var(--line); white-space: nowrap; font-variant-numeric: tabular-nums; }
.metrics th:first-child, .metrics td:first-child { text-align: left; white-space: normal; }
.metrics thead th { color: var(--muted); font-weight: 600; border-top: 0; }
.metrics .better { color: var(--pass); font-weight: 600; } .metrics .worse { color: var(--fail); font-weight: 600; }
.metrics .note { color: var(--muted); font-size: 13px; margin: 8px 0 0; }
footer { color: var(--muted); font-size: 13px; margin-top: 28px; }
@media (max-width: 900px) {
  .panes { grid-template-columns: minmax(0, 1fr); }
  .log th:nth-child(2), .log td:nth-child(2) { display: none; }
  section { padding: 14px 12px 10px; }
}
</style>
</head>
<body>
<div class="wrap">
<h1>sub-human walkthrough · slim build</h1>
<p class="sub">${esc(summary)}. Each scene shows the orch (its background job, via <code>claude logs</code>), alice and bob terminals, the room-log entries written during the step, and the checks. Click a pane to enlarge it.${meta.note ? ' ' + esc(meta.note) : ''}</p>
${metricsHtml}
<nav class="toc">${toc}</nav>
${sections || '<p class="nochecks">No captures yet: run scripts/demo.sh.</p>'}
<footer>Built ${esc(new Date().toISOString().slice(0, 16).replace('T', ' '))} UTC by scripts/walkthrough.js from docs/rebuild/screens/index.json${fs.existsSync(checksFile) ? ' and docs/rebuild/checks.json' : ''}.</footer>
</div>
<script>
document.addEventListener('click', function (ev) {
  var fig = ev.target.closest && ev.target.closest('.pane');
  if (!fig) return;
  var panes = fig.parentNode;
  var on = panes.classList.contains('zoomed') && fig.classList.contains('on');
  panes.querySelectorAll('.pane').forEach(function (p) { p.classList.remove('on'); });
  panes.classList.toggle('zoomed', !on);
  if (!on) { fig.classList.add('on'); fig.scrollIntoView({ block: 'nearest' }); }
});
document.addEventListener('keydown', function (ev) {
  if ((ev.key === 'Enter' || ev.key === ' ') && ev.target.classList && ev.target.classList.contains('pane')) { ev.preventDefault(); ev.target.click(); }
});
</script>
</body>
</html>
`;
  fs.writeFileSync(out, html);
  return { out, scenes: sceneIds.length, captures: index.length, pass, fail, warn, bytes: Buffer.byteLength(html) };
}

module.exports = { build, SCENES };

if (require.main === module) {
  const o = args();
  const r = build({
    screens: path.resolve(o.screens || path.join(REPO, 'docs/rebuild/screens')),
    checksFile: path.resolve(o.checks || path.join(REPO, 'docs/rebuild/checks.json')),
    out: path.resolve(o.out || path.join(REPO, 'docs/rebuild/walkthrough.html')),
  });
  process.stdout.write(`walkthrough: ${path.relative(process.cwd(), r.out)} — ${r.scenes} scenes, ${r.captures} captures, checks ${r.pass} pass / ${r.fail} fail / ${r.warn} warn, ${(r.bytes / 1024).toFixed(0)} KiB\n`);
}
