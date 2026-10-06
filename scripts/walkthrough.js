#!/usr/bin/env node
'use strict';
/**
 * walkthrough: build docs/rebuild/walkthrough.html from docs/rebuild/screens/index.json and its captures.
 *
 *   node scripts/walkthrough.js [--screens DIR] [--checks FILE] [--out FILE]
 *
 * One section per scene: what it must show, then per step the caption and a text excerpt of each pane
 * (orch, viewer, alice, bob): only the lines new since that session's previous capture, minus UI noise,
 * capped at 10 lines, coloured from the .ansi capture (the .txt when there is none). Then the room-log
 * entries, the scripted waits (screens/waits.jsonl) and the checks from docs/rebuild/checks.json
 * ({scene: [{check, pass, evidence, kind?, status?: pass|fail|warn}], _meta?: {cost, run, note}}).
 * The output is one small self-contained HTML file: no images, no scripts, no external requests.
 * The full captures stay in docs/rebuild/screens.
 */
const fs = require('node:fs');
const path = require('node:path');
const { rowsHtml, palette } = require('./ansi-svg.js');
const { isRed } = require('./metrics.js');

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

// excerpt limits
const MAX_LINES = 10, HEAD = 3, TAIL = 6, MAX_ROWS = 3, EVIDENCE = 160, MERGE = 0.8, RULE_MAX = 16;

function args() {
  const a = process.argv.slice(2), o = {};
  for (let i = 0; i < a.length; i++) if (a[i].startsWith('--')) o[a[i].slice(2)] = a[++i];
  return o;
}

/** Text content: escape & < > only (quotes are fine outside attributes). */
const esc = s => String(s == null ? '' : s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
/** Attribute values. */
const attr = s => esc(s).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const readText = f => { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } };
const seatOf = s => s.replace(/^shd?-/, '');
const seatRank = s => { const i = SEAT_ORDER.indexOf(seatOf(s)); return i < 0 ? 99 : i; };
const sceneRank = s => { const i = ORDER.indexOf(s); return i < 0 ? 1000 : i; };
const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

// ---- excerpt rules -------------------------------------------------------------------------------

/** Lines that carry no evidence: chrome, banners, status bars, spinners, plan-dialog furniture. */
const NOISE = [
  /Claude Code v\d/, /^\s*[▐▝▘▗▖][▛▜▝▘█▀]/, /^\s*(Opus|Sonnet|Haiku|Fable) \d[\d.]* /, /^\s+(@\S+ · )?\/(private|Users|tmp|home)\//,
  /MCP servers? needs? auth/, /Update available/, /Waiting for \d+ background agent/, /Monitor event:/, /Backgrounded agent/,
  /^[\s─━▔▁╌═]*$/, /^[\s─]+[\w.@-]+ ─\s*$/, // rules and the input-box rule "──── alice.room ─"
  /^\s*(⏵⏵|⏸) /, /^\s*❯\s*$/, /Allowed by /,
  /^\s*[⏺⎿]?\s*(Searched for|Called plugin|Calling plugin|Ran \d+ stop hook)/,
  /Entered plan mode|Exited plan mode|is now exploring and designing/,
  /Ready to code\?|Here is Claude's plan:|Would you like to proceed\?/,
  /ctrl\+g to edit|shift\+tab to approve|esc to interrupt|ctrl\+t to (hide|show)/,
  /^\s*⎿\s+Tip:/, /\/plan to preview/,
  /^\s*[·✻✳✶✢*✽✦] \S+…/, /^\s*✻ \w+ for \d+[ms]/, /\(\d+[ms][^)]*[↑↓] [\d.]+k? tokens/, /◐ .*\/effort/,
  /^\s*\S\s*$/, // a lone glyph
];
const isNoise = l => NOISE.some(r => r.test(l)) || l.replace(/[^A-Za-z0-9]/g, '').length < 3;
const isRule = l => /^\s*[─━▔╌]{4,}\s*$/.test(l);
const STATUS = /^\s*(⏵⏵|⏸) /;
const SCROLL = /\s{2,}[↑↓]$/;

/** Plain text of a row as compared across captures: right-trimmed, scroll arrow dropped. */
const norm = l => l.replace(/\s+$/, '').replace(SCROLL, '');

/**
 * Classify each line of one capture: {drop} for the plan view's body (all but its "Plan: …" title) and its
 * numbered options, {row} for the agent-rows panel under the status bar.
 */
function classify(texts) {
  const info = texts.map(() => ({ drop: false, row: false }));
  const proceed = texts.findIndex(l => /Would you like to proceed\?/.test(l));
  if (proceed >= 0) {
    let start = -1;
    for (let i = proceed - 1; i >= 0; i--) if (/^\s*▔{4,}\s*$/.test(texts[i]) || /Here is Claude's plan:/.test(texts[i])) { start = i; break; }
    if (start >= 0) {
      let i = start + 1;
      while (i < proceed && (!texts[i].trim() || isRule(texts[i]) || /Ready to code\?|Here is Claude's plan:/.test(texts[i]))) i++;
      for (; i < proceed && !isRule(texts[i]); i++) if (!/^\s*#*\s*Plan:/.test(texts[i])) info[i].drop = true;
    }
    for (let i = proceed + 1; i < texts.length && !STATUS.test(texts[i]); i++) if (/^\s*(❯\s*)?\d\.\s/.test(texts[i])) info[i].drop = true;
  }
  let st = -1;
  texts.forEach((l, i) => { if (STATUS.test(l)) st = i; });
  if (st >= 0) for (let i = st + 1; i < texts.length; i++) info[i].row = true;
  return info;
}

/** Multiset of a capture's lines. */
function bag(texts) { const m = new Map(); for (const l of texts) m.set(l, (m.get(l) || 0) + 1); return m; }

/**
 * The lines of a capture worth showing: new against `prev` (the multiset of that session's previous
 * capture), minus noise, the plan body and consecutive duplicates. rows: [{text, html, red}].
 */
function freshLines(rows, prev) {
  const texts = rows.map(r => norm(r.text));
  const info = classify(texts);
  const seen = new Map(prev || []);
  const out = [];
  let last = null;
  rows.forEach((r, i) => {
    const t = texts[i];
    if (!t.trim()) return;
    const n = seen.get(t) || 0;
    if (n > 0) { seen.set(t, n - 1); return; }
    if (info[i].drop || isNoise(t) || t === last) return;
    last = t;
    out.push({ text: t, html: r.html.replace(/\s{2,}(<i[^>]*>)?[↑↓](<\/i>)?$/, ''), red: !!r.red, row: info[i].row });
  });
  return { lines: out, bag: bag(texts) };
}

/** Cap a pane at MAX_LINES: the first HEAD, an elision, the last TAIL; red lines are never elided. */
function capLines(lines) {
  if (lines.length <= MAX_LINES) return lines;
  const keep = lines.map((l, i) => i < HEAD || i >= lines.length - TAIL || l.red);
  const out = [];
  for (let i = 0; i < lines.length;) {
    if (keep[i]) { out.push(lines[i++]); continue; }
    let j = i; while (j < lines.length && !keep[j]) j++;
    out.push({ elided: j - i });
    i = j;
  }
  return out;
}

/** Share of the larger pane's lines that the other pane also has. */
function overlap(a, b) {
  const sb = bag(b.map(l => l.text)); let n = 0;
  for (const l of a) { const k = sb.get(l.text) || 0; if (k) { n++; sb.set(l.text, k - 1); } }
  return n / Math.max(a.length, b.length);
}

/** One step's panes -> [{seat, lines}] with near-identical panes merged ("alice = bob"). */
function mergePanes(panes) {
  const out = panes.map(p => ({ ...p }));
  for (let i = 0; i < out.length; i++) for (let j = i + 1; j < out.length; j++) {
    const A = out[i], B = out[j];
    if (!A || !B || !A.lines.length || !B.lines.length) continue;
    if (overlap(A.lines, B.lines) >= MERGE) { A.seat += ' = ' + B.seat; out[j] = null; }
  }
  return out.filter(Boolean);
}

const collapseRules = s => s.replace(/([─━▔╌═])\1{16,}/g, (m, c) => c.repeat(RULE_MAX));

function paneHtml(p) {
  if (!p.lines.length) return { chip: `<span class="chip">${esc(p.seat)}: unchanged</span>` };
  if (p.lines.every(l => l.row)) {
    const r = p.lines.map(l => esc(l.text.trim()));
    return { chip: `<span class="chip rows"><b>${esc(p.seat)}</b> rows: ${r.slice(0, MAX_ROWS).join(' · ')}${r.length > MAX_ROWS ? ` · +${r.length - MAX_ROWS}` : ''}</span>` };
  }
  const body = capLines(p.lines).map(l => (l.elided ? `<span class="el">… ${l.elided} line${l.elided === 1 ? '' : 's'} …</span>` : l.red ? `<span class="red">${collapseRules(l.html)}</span>` : collapseRules(l.html))).join('\n');
  return { fig: `<figure class="term"><figcaption>${esc(p.seat)}</figcaption><pre>${body}</pre></figure>` };
}

/** Rows of one capture record: from the .ansi capture (colours, red lines) or else the .txt. */
function captureRows(screens, r, pal) {
  const base = r.txt || r.svg || '';
  const ansi = readText(path.join(screens, base.replace(/\.(txt|svg)$/, '.ansi')));
  if (ansi != null) {
    return rowsHtml(ansi, { palette: pal }).map(x => ({ text: x.text, html: x.html, red: isRed(x.raw) || /hook error/i.test(x.text) }));
  }
  const txt = readText(path.join(screens, r.txt || '')) || '';
  return txt.replace(/\n$/, '').split('\n').map(t => ({ text: t.replace(/\s+$/, ''), html: esc(t.replace(/\s+$/, '')), red: /hook error/i.test(t) }));
}

/** Step key for paginated steps: the caption with its digits ignored. */
const pageKey = c => String(c || '').replace(/\d+/g, '#');

/**
 * Turn the capture index into scenes -> shown steps -> panes, applying the excerpt rules in time order.
 * Returns Map(scene -> {steps: [{caption, step, pages, panes: [{seat, lines}]}], log: Map(id -> entry)}).
 */
function excerpt(index, screens, pal) {
  const scenes = new Map();
  const groups = [];
  const byKey = new Map();
  for (const r of index) {
    if (!scenes.has(r.scene)) scenes.set(r.scene, { steps: [], log: new Map() });
    const sc = scenes.get(r.scene);
    for (const e of r.log || []) sc.log.set(e.id, e);
    const k = r.scene + '|' + (r.step != null ? r.step : r.caption || '');
    if (!byKey.has(k)) { const g = { scene: r.scene, caption: r.caption || '', step: r.step, time: r.time, recs: [] }; byKey.set(k, g); groups.push(g); }
    byKey.get(k).recs.push(r);
  }
  groups.sort((a, b) => sceneRank(a.scene) - sceneRank(b.scene) || (a.step != null && b.step != null ? a.step - b.step : String(a.time).localeCompare(String(b.time))));
  // diffs follow the capture order, so walk groups in time order
  const prev = new Map();
  const timeOrder = [...groups].sort((a, b) => String(a.time).localeCompare(String(b.time)));
  const panesOf = new Map();
  for (const g of timeOrder) {
    const panes = [];
    for (const r of [...g.recs].sort((a, b) => seatRank(a.session) - seatRank(b.session))) {
      const f = freshLines(captureRows(screens, r, pal), prev.get(r.session));
      prev.set(r.session, f.bag);
      panes.push({ seat: seatOf(r.session), lines: f.lines });
    }
    panesOf.set(g, mergePanes(panes));
  }
  for (const g of groups) {
    const sc = scenes.get(g.scene);
    const last = sc.steps[sc.steps.length - 1];
    const shown = { caption: g.caption, step: g.step, pages: 0, panes: panesOf.get(g) };
    if (last && pageKey(last.caption) === pageKey(g.caption)) { shown.pages = last.pages + 1; sc.steps[sc.steps.length - 1] = shown; }
    else sc.steps.push(shown);
  }
  return scenes;
}

// ---- page ----------------------------------------------------------------------------------------

/** "Slim build vs baselines" table from checks.json _metrics ({run, baseline, phase0}); '' when absent. */
function metricsSection(m) {
  if (!m || !m.run || !m.baseline) return '';
  const R = m.run, B = m.baseline, P = m.phase0 || {}, S = m.prev || null, seats = ['orch', 'alice', 'bob'];
  const g = (o, ...ks) => ks.reduce((x, k) => (x == null ? x : x[k]), o);
  const delta = (now, base) => {
    if (now == null || base == null) return '<td></td>';
    const d = now - base;
    const cls = d === 0 ? '' : d < 0 ? ' class="better"' : ' class="worse"';
    const pct = base ? ` (${d > 0 ? '+' : ''}${Math.round((d / base) * 100)}%)` : '';
    return `<td${cls}>${esc((d > 0 ? '+' : '') + (Math.round(d * 100) / 100) + pct)}</td>`;
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
  const v = x => esc(x == null ? '–' : x);
  return `<section id="metrics-table">
<h2><span class="sid">M</span>Slim build vs baselines</h2>
<p class="must">Room ${esc(R.room)} (${esc(R.total.noise.captures)} captures) against vole-8126, Phase 0 otter-0813${S ? ` and ${esc(S.run)}` : ''}; measured by scripts/metrics.js from transcripts and captures.</p>
<div class="metrics"><table><thead><tr><th>Metric</th><th>vole-8126</th><th>Phase 0</th>${S ? `<th>${esc(S.run)}</th>` : ''}<th>this run</th><th>vs vole</th><th>vs P0</th>${S ? `<th>vs ${esc(S.run)}</th>` : ''}</tr></thead><tbody>
${rows.map(([l, now, base, p0, prev]) => `<tr><td>${esc(l)}</td><td>${v(base)}</td><td>${v(p0)}</td>${S ? `<td>${v(prev)}</td>` : ''}<td>${v(now)}</td>${delta(now, base)}${delta(now, p0)}${S ? delta(now, prev) : ''}</tr>`).join('\n')}
</tbody></table></div>
<p class="note">Wake: a Monitor event, peer delivery or row-rewake that starts a turn (${esc(R.total.notices)} notices). Noise: the five line kinds above; ✓ sent receipts excluded (${esc(R.total.noise.receipts)}). Reviews: ${esc(R.total.cards.count)} proposals, ${esc(R.total.cards.toCard)} call(s) to open + ${esc(R.total.cards.after)} after.</p>
</section>`;
}

function logLine(e) {
  const kind = e.kind + (e.plan_hash ? ' ' + String(e.plan_hash).slice(0, 6) : '') + (e.refs && e.refs.length ? ' refs ' + e.refs.join(',') : '');
  return esc(`#${e.id} ${e.from}${e.via ? '/' + e.via : ''} ${kind}${e.text ? ' ' + e.text : ''}`);
}

const PAGE_CSS = `:root{--bg:#f6f6f3;--surface:#fff;--ink:#1d1f23;--muted:#626872;--line:#dddcd5;--accent:#3b5bdb;--pass:#1f7a3e;--pass-bg:#e3f3e8;--fail:#b42318;--fail-bg:#fde8e6;--warn:#9a6700;--warn-bg:#fdf3dc;--code-bg:#efeee9;
--term-bg:#16181d;--term-fg:#d6dbe5;--term-bar:#22252c;--term-border:#3a3e48;--term-muted:#8b929e;--term-red:rgba(255,95,87,.2);color-scheme:light}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#111317;--surface:#191c21;--ink:#e6e8ec;--muted:#9aa1ad;--line:#2c3038;--accent:#8ea2ff;--pass:#5fd08a;--pass-bg:#15291d;--fail:#ff8a7a;--fail-bg:#331715;--warn:#f0b45a;--warn-bg:#2e2412;--code-bg:#22262d;color-scheme:dark}}
:root[data-theme="dark"]{--bg:#111317;--surface:#191c21;--ink:#e6e8ec;--muted:#9aa1ad;--line:#2c3038;--accent:#8ea2ff;--pass:#5fd08a;--pass-bg:#15291d;--fail:#ff8a7a;--fail-bg:#331715;--warn:#f0b45a;--warn-bg:#2e2412;--code-bg:#22262d;color-scheme:dark}
*{box-sizing:border-box}html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif}
.wrap{max-width:1440px;margin:0 auto;padding:24px 16px 64px}
h1{font-size:24px;margin:0}.sub{color:var(--muted)}
code,pre{font:12px/1.45 ui-monospace,"SF Mono",Menlo,Consolas,monospace}code{background:var(--code-bg);padding:1px 4px;border-radius:4px}
nav{display:flex;flex-wrap:wrap;gap:6px;margin:0 0 22px}
nav a{padding:3px 9px;border:1px solid var(--line);border-radius:999px;background:var(--surface);color:var(--ink);text-decoration:none;font-size:13px;font-weight:600}
nav a.pass{border-color:var(--pass)}nav a.fail{border-color:var(--fail)}nav a.warn{border-color:var(--warn)}
section{background:var(--surface);border:1px solid var(--line);border-radius:12px;padding:16px;margin:0 0 20px;min-width:0}
h2{font-size:18px;margin:0;display:flex;align-items:baseline;gap:10px;flex-wrap:wrap}
.sid{font:600 13px ui-monospace,Menlo,monospace;color:var(--accent);border:1px solid var(--accent);border-radius:6px;padding:0 6px}
.must{margin:4px 0 10px;color:var(--muted);font-size:14px}
.step{margin:12px 0}.caption{margin:0 0 6px;font-weight:500}.stepno,.pages{color:var(--muted);font:12px ui-monospace,Menlo,monospace;margin-right:6px}.pages{margin:0 0 0 6px}
.panes{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,400px),1fr));gap:10px}
.term{margin:0;min-width:0;background:var(--term-bg);color:var(--term-fg);border:1px solid var(--term-border);border-radius:9px;overflow:hidden}
.term figcaption{background:var(--term-bar);color:var(--term-muted);font:600 12px ui-monospace,Menlo,monospace;padding:4px 10px;border-bottom:1px solid var(--term-border)}
.term pre{margin:0;padding:8px 10px;overflow-x:auto;white-space:pre}
.term .el{color:var(--term-muted);font-style:italic}.term .red{background:var(--term-red)}
.chips{display:flex;flex-wrap:wrap;gap:6px;margin:0 0 8px}
.chip{font:12px ui-monospace,Menlo,monospace;color:var(--muted);border:1px solid var(--line);border-radius:6px;padding:1px 7px;overflow-wrap:anywhere}
.chip.rows{color:var(--ink);background:var(--code-bg)}
.checks{list-style:none;margin:10px 0;padding:0;display:grid;gap:4px}
.checks li{padding:6px 10px;border-radius:8px;font-size:14px;overflow-wrap:anywhere}
.checks .pass{background:var(--pass-bg)}.checks .fail{background:var(--fail-bg)}.checks .warn{background:var(--warn-bg)}
.checks b{font:700 11px ui-monospace,Menlo,monospace;padding:1px 5px;border-radius:4px;color:var(--surface);margin-right:4px}
.pass b{background:var(--pass)}.fail b{background:var(--fail)}.warn b{background:var(--warn)}
.checks i,.checks small{color:var(--muted);font-size:13px;font-style:normal}.checks small{display:block}
.log{margin:8px 0 0;padding:8px 10px;background:var(--code-bg);border-radius:8px;overflow-x:auto;white-space:pre}
.waits{color:var(--muted);font-size:13px;margin:6px 0 0}.waits .fail{color:var(--fail)}
.nochecks{color:var(--muted)}
.metrics{overflow-x:auto}.metrics table{width:100%;border-collapse:collapse;font-size:13px}
.metrics th,.metrics td{text-align:right;padding:4px 8px;border-top:1px solid var(--line);white-space:nowrap;font-variant-numeric:tabular-nums}
.metrics th:first-child,.metrics td:first-child{text-align:left;white-space:normal;min-width:180px}.metrics thead th{color:var(--muted);border-top:0}
.better{color:var(--pass);font-weight:600}.worse{color:var(--fail);font-weight:600}.note{color:var(--muted);font-size:13px;margin:8px 0 0}
footer{color:var(--muted);font-size:13px}
@media (max-width:600px){section{padding:12px 10px}}`;

function build({ screens, checksFile, out }) {
  const index = readJson(path.join(screens, 'index.json'), []);
  const checksAll = readJson(checksFile, {});
  const meta = checksAll._meta || {};
  const waits = [];
  for (const l of (readText(path.join(screens, 'waits.jsonl')) || '').split('\n')) if (l.trim()) try { waits.push(JSON.parse(l)); } catch { /* skip */ }

  const pal = palette();
  const scenes = excerpt(index, screens, pal);
  const sceneIds = [...new Set([...scenes.keys(), ...Object.keys(checksAll).filter(k => !k.startsWith('_'))])].sort((a, b) => sceneRank(a) - sceneRank(b));

  // a check's status: pass | fail | warn (a behavioural check over its threshold; older checks.json has only pass)
  const status = c => c.status || (c.pass ? 'pass' : 'fail');
  let pass = 0, fail = 0, warn = 0;
  for (const k of sceneIds) for (const c of checksAll[k] || []) { const s = status(c); s === 'pass' ? pass++ : s === 'warn' ? warn++ : fail++; }
  const sceneStatus = cs => (!cs.length ? '' : cs.some(c => status(c) === 'fail') ? 'fail' : cs.some(c => status(c) === 'warn') ? 'warn' : 'pass');

  const toc = sceneIds.map(id => `<a class="${sceneStatus(checksAll[id] || [])}" href="#${attr(id)}">${esc(id)}</a>`).join('');

  const sections = sceneIds.map(id => {
    const sc = scenes.get(id) || { steps: [], log: new Map() };
    const [title, must] = SCENES[id] || [id, ''];
    const cs = checksAll[id] || [];
    const n = sc.steps.length;
    const stepHtml = sc.steps.map((st, i) => {
      const parts = st.panes.map(paneHtml);
      const chips = parts.filter(p => p.chip).map(p => p.chip).join('');
      const figs = parts.filter(p => p.fig).map(p => p.fig).join('\n');
      return `<div class="step"><p class="caption">${n > 1 ? `<span class="stepno">${i + 1}/${n}</span>` : ''}${esc(st.caption)}${st.pages ? `<span class="pages">(final page; +${st.pages} more page${st.pages === 1 ? '' : 's'})</span>` : ''}</p>
${chips ? `<div class="chips">${chips}</div>` : ''}${figs ? `<div class="panes">${figs}</div>` : ''}</div>`;
    }).join('\n');
    const log = [...sc.log.values()].sort((a, b) => a.id - b.id);
    const logHtml = log.length ? `<pre class="log">${log.map(logLine).join('\n')}</pre>` : '';
    const w = waits.filter(x => x.scene === id);
    const failed = w.filter(x => !x.ok);
    const waitHtml = w.length ? `<p class="waits">${w.length - failed.length}/${w.length} driver waits met${failed.map(x => `<br><span class="fail">✗ ${esc(x.what)} (${(x.ms / 1000).toFixed(1)}s)</span>`).join('')}</p>` : '';
    // kind is shown when it is not the default (deterministic); the intro says so
    const checkHtml = cs.length ? `<ul class="checks">${cs.map(c => `<li class=${status(c)}><b>${status(c).toUpperCase()}</b> ${esc(c.check)}${c.kind === 'behavioural' ? ` <i>behavioural · ${esc(c.value)} vs ≤ ${esc(c.threshold)}</i>` : c.kind && c.kind !== 'deterministic' ? ` <i>${esc(c.kind)}</i>` : ''}${c.evidence ? `<small>${esc(clip(String(c.evidence), EVIDENCE))}</small>` : ''}</li>`).join('')}</ul>` : '<p class="nochecks">No checks recorded for this scene.</p>';
    return `<section id="${attr(id)}">
<h2><span class="sid">${esc(id)}</span>${esc(title)}</h2><p class="must">Must show: ${esc(must)}</p>
${n ? stepHtml : '<p class="nochecks">No screens captured for this scene.</p>'}
${checkHtml}${logHtml}${waitHtml}
</section>`;
  }).join('\n');

  const run = meta.run || (index.length && index[0].room ? `room ${index[0].room}` : '');
  const summary = [
    run,
    `${sceneIds.length} scene${sceneIds.length === 1 ? '' : 's'}`,
    `${index.length} capture${index.length === 1 ? '' : 's'}`,
    pass + fail + warn ? `checks ${pass} pass / ${warn} warn / ${fail} fail` : 'no checks yet',
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
${PAGE_CSS}
${pal.css('.term', new Set([...sections.matchAll(/<i class=([a-z]+)>/g)].map(m => m[1])))}
</style>
</head>
<body>
<div class="wrap">
<h1>sub-human walkthrough · slim build</h1>
<p class="sub">${esc(summary)}. Each step shows what changed in the orch (its background job, via <code>claude logs</code>), alice and bob terminals since their previous capture, then the checks (deterministic unless marked behavioural) and the room log.${meta.note ? ' ' + esc(meta.note) : ''}</p>
${metricsSection(checksAll._metrics)}
<nav>${toc}</nav>
${sections || '<p class="nochecks">No captures yet: run scripts/demo.sh.</p>'}
<footer>Built ${esc(new Date().toISOString().slice(0, 16).replace('T', ' '))} UTC by scripts/walkthrough.js from docs/rebuild/screens/index.json${fs.existsSync(checksFile) ? ' and docs/rebuild/checks.json' : ''}. Panes are excerpts; the full captures (.ansi, .txt, .svg) are in docs/rebuild/screens locally.</footer>
</div>
</body>
</html>
`;
  fs.writeFileSync(out, html);
  return { out, scenes: sceneIds.length, captures: index.length, pass, fail, warn, bytes: Buffer.byteLength(html), chars: html.length };
}

module.exports = { build, SCENES, isNoise, classify, freshLines, capLines, mergePanes, paneHtml, excerpt, bag };

if (require.main === module) {
  const o = args();
  const r = build({
    screens: path.resolve(o.screens || path.join(REPO, 'docs/rebuild/screens')),
    checksFile: path.resolve(o.checks || path.join(REPO, 'docs/rebuild/checks.json')),
    out: path.resolve(o.out || path.join(REPO, 'docs/rebuild/walkthrough.html')),
  });
  process.stdout.write(`walkthrough: ${path.relative(process.cwd(), r.out)} — ${r.scenes} scenes, ${r.captures} captures, checks ${r.pass} pass / ${r.fail} fail / ${r.warn} warn, ${r.bytes} bytes (~${Math.round(r.chars / 3.5 / 1000)}k tokens)\n`);
}
