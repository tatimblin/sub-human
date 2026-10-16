#!/usr/bin/env node
/**
 * metrics: per-seat cost-of-the-room measurements for one demo run, from evidence only.
 *
 *   node scripts/metrics.ts [--screens DIR] [--home DIR]   print the run's metrics as JSON
 *   measure({screens, home}) (import from './metrics.ts')  same, as an object (used by checks.ts)
 *
 * The run window is the first..last capture in screens/index.json (+30 s). Seats and their transcripts
 * (read-only): the two people (alice and bob unless measure() is given seats) are the top-level ~/.claude/projects/-private-tmp-sh-demo-SEAT/*.jsonl files; the
 * room Claude is a `claude --bg` job started in the joiner's folder, so its transcript is the file named after
 * members.json claude.session_id (wherever it is), and that file is left out of the folder's member seat.
 *
 * - wakes: room-caused model turns: a user entry that is a sub-human plugin prompt (the hooks module's wake:
 *   origin {kind: plugin, name: sub-human}, not isMeta), a peer delivery (origin.kind peer), or the row-rewake
 *   wake (its text "sub-human: this session was resumed…"), followed in file order by an assistant message before
 *   the next user prompt. Adjacent triggers that start one turn count once. `plugin` counts the plugin prompts.
 * - chat: `notices` = the hooks module's $.ui.log rows (system, level notice, "sub-human: …": what the
 *   person sees), `pulls` = the room context for the model (since stage 8e a hook_additional_context beside the next
 *   prompt, "sub-human room context: …"; before, an isMeta row of origin plugin sub-human), and `turns` / `calls` = model
 *   turns (and distinct assistant messages) that started with nothing but such rows since the previous turn ended:
 *   a chat burst should cost 0. `callsPerBurst` = calls / notices.
 * - injected: chars of hook additionalContext the seat's model received: `join` (UserPromptExpansion, the
 *   /sub-human join block), `total` (every hook_additional_context attachment, incl. restores and digests).
 * - noise: UI lines per capture of the seat's pane: the plugin prompt's framing ("The sub-human
 *   plugin sent a message", one per row), "Waiting for N background agents",
 *   "hook error", "blocked by hook", "Invalid tool parameters"; `perCapture` = all of them / captures,
 *   `perCaptureExWaiting` without "Waiting for". The @room receipt ("⏺ ✓ sent") is counted
 *   apart as `receipts`, not noise. `red`: lines drawn mostly in a red foreground (from the .ansi capture; isRed) or
 *   reading "hook error".
 * - cards: for each consent card or plan-view review (an AskUserQuestion or ExitPlanMode call naming a proposal
 *   hash) in a member transcript,
 *   the model calls (distinct assistant message ids) from the entry that woke the turn to the card call
 *   (`toCard`, the card call included) and from the answer to the end of that turn (`after`).
 */
import fs from 'node:fs';
import path from 'node:path';
import * as paths from './lib/paths.ts';
import { readJson, jsonl, textOf } from './lib/io.ts';
import baselinesJson from './baselines.json' with { type: 'json' };
import type { Members } from '../plugin/sub-human/lib/room/types.ts';

/** A content block of a transcript message (text, tool_use, tool_result, …). */
export interface Block {
  type?: string;
  text?: string;
  name?: string;
  id?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: unknown;
}
/** A transcript message: an assistant's (id, model, usage) or a user's. */
export interface TMessage {
  id?: string;
  model?: string;
  content?: string | Block[];
  usage?: { input_tokens?: number, output_tokens?: number, cache_creation_input_tokens?: number, cache_read_input_tokens?: number };
}
/** One line of a Claude Code transcript (.jsonl), as far as the scripts read it. */
export interface TEntry {
  type?: string;
  subtype?: string;
  level?: string;
  timestamp?: string;
  uuid?: string;
  isSidechain?: boolean;
  isMeta?: boolean;
  agentSetting?: string;
  permissionMode?: string;
  operation?: string;
  reason?: string;
  content?: unknown;
  origin?: { kind?: string, name?: string, body?: string, verifiedPeerPid?: number };
  message?: TMessage;
  attachment?: { type?: string, hookEvent?: string, content?: unknown, planFilePath?: string };
  /** the transcript file it came from (checks/transcripts.ts entries) */
  _file?: string;
}
/** A capture's record in screens/index.json (scripts/snap.ts). */
export interface CaptureRec { scene: string, session: string, step: number, time: string, txt: string, room?: string, caption?: string }

/** One earlier run's totals (scripts/baselines.json runs). */
export interface BaselineRun {
  run: string;
  note: string;
  wakes: Record<string, number>;
  noise: Record<string, number>;
  joinChars: Record<string, number>;
  injected: Record<string, number>;
  red?: number;
  cardsPerCard?: number;
  cost?: string;
}
/** The behavioural checks' limits and the join-text sizes. */
export interface Thresholds {
  wakes: number;
  noisePerCapture: number;
  callsPerReview: number;
  roomClaudeJoinCalls: number;
  roomClaudeTaskCalls: number;
  joinText: number;
  joinBlock: number;
}
/** scripts/baselines.json. */
export interface Baselines {
  _doc: string;
  compare: { baseline: string, phase0: string, prev: string };
  thresholds: Thresholds;
  runs: Record<string, BaselineRun>;
  /** USD per million tokens [input, output, cache write, cache read] by model-name substring; 'default' otherwise */
  prices: Record<string, number[]>;
}

export const NOISE: Record<string, RegExp> = {
  plugin: /The sub-human plugin sent a message/, // one per plugin prompt row (its framing line)
  waiting: /Waiting for \d+ background agents?/,
  hookError: /hook error/i,
  blocked: /blocked by hook/i,
  invalid: /Invalid tool parameters/,
};
const REWAKE = 'sub-human: this session was resumed';

/** Earlier runs to compare against (scripts/baselines.json runs; compare picks which fill checks.json _metrics). */
export const BASELINES: Baselines = baselinesJson;
const baselineRun = (name: string): BaselineRun => {
  const r = BASELINES.runs[name];
  if (!r) throw new Error(`scripts/baselines.json: compare names ${name}, which runs does not hold`);
  return r;
};
export const BASELINE: BaselineRun = baselineRun(BASELINES.compare.baseline);
export const PHASE0: BaselineRun = baselineRun(BASELINES.compare.phase0);
export const PREV: BaselineRun = baselineRun(BASELINES.compare.prev);

/** A message's content blocks ([] for a string or none). */
export const blocksOf = (e: TEntry): Block[] => { const c = e.message && e.message.content; return Array.isArray(c) ? c : []; };

const isToolResult = (e: TEntry): boolean => { const c = blocksOf(e); return c.length > 0 && c.every(b => b && b.type === 'tool_result'); };

const projectsDir = (p?: string): string => p || paths.projectsDir();

/** The room's Claude session id from <home>/rooms/<code>/members.json (the newest room), or null. */
function roomClaudeSession(home: string | undefined, code: string | undefined): string | null {
  if (!home) return null;
  try {
    const rooms = path.join(home, 'rooms');
    const c = code || fs.readdirSync(rooms).map(d => ({ d, m: fs.statSync(path.join(rooms, d)).mtimeMs })).sort((a, b) => b.m - a.m).at(0)?.d;
    if (!c) return null;
    const o = readJson<Members>(path.join(rooms, c, 'members.json'), {}).claude;
    return (o && o.session_id) || null;
  } catch { return null; }
}

/** One transcript file and its entries. */
interface Transcript { file: string, es: TEntry[] }

/** Transcript files of a seat: [{file, es}] limited to the window. */
function transcripts(seat: string, from: string, to: string, projects: string | undefined, roomClaudeSid: string | null): Transcript[] {
  const base = projectsDir(projects);
  let files: string[] = [];
  if (seat === 'claude') {
    if (!roomClaudeSid) return [];
    try { for (const d of fs.readdirSync(base)) { const f = path.join(base, d, `${roomClaudeSid}.jsonl`); if (fs.existsSync(f)) files.push(f); } } catch { return []; }
  } else {
    const dir = path.join(base, path.basename(paths.seatProjectDir(seat)));
    try { files = fs.readdirSync(dir).filter(f => f.endsWith('.jsonl') && (!roomClaudeSid || f !== `${roomClaudeSid}.jsonl`)).map(f => path.join(dir, f)); } catch { return []; }
  }
  return files.map(f => ({ file: f, es: jsonl<TEntry>(f) }))
    .filter(({ es }) => seat === 'claude' || !es.some(e => e.agentSetting === 'sub-human:room-claude')) // another room's Claude in this folder
    .filter(({ es }) => es.some(e => e.timestamp && e.timestamp >= from && e.timestamp <= to))
    .map(t => ({ ...t, es: t.es.filter(e => !e.timestamp || (e.timestamp >= from && e.timestamp <= to)) }));
}

/** What started a room wake (metrics wakes): a plugin prompt, a peer delivery or the row-rewake. */
export type Trigger = 'plugin' | 'peer' | 'rewake';

/** kind of room trigger a user entry is, or null */
export function trigger(e: TEntry): Trigger | null {
  if (e.type !== 'user' || isToolResult(e)) return null;
  const k = e.origin && e.origin.kind;
  const t = textOf(e.message && e.message.content);
  if (k === 'peer') return 'peer';
  if (t.includes(REWAKE)) return 'rewake';
  if (k === 'plugin' && e.origin && e.origin.name === 'sub-human' && !e.isMeta) return 'plugin';
  return null;
}

/** The hooks module's chat row ($.ui.log: a system notice "sub-human: …"), or its isMeta copy for the model. */
export const isChatNotice = (e: TEntry): boolean => e.type === 'system' && e.level === 'notice' && typeof e.content === 'string' && e.content.startsWith('sub-human: ');
export const isPull = (e: TEntry): boolean => !!(e.type === 'user' && e.isMeta && e.origin && e.origin.kind === 'plugin' && e.origin.name === 'sub-human');

const HASH_RE = /proposal\s+([0-9a-f]{6,12})\b/;  // the member text asks for "proposal <hash>"; a model may write only 6 hex
/** One consent card or plan-view review: when, the proposal hash, model calls to open it and after the answer. */
export interface CardTurn { at: string | undefined, hash: string, toCard: number, after: number }

/** Consent-card calls in one transcript's entries: [{at, hash, toCard, after}]. */
export function cardTurns(es: TEntry[]): CardTurn[] {
  const out: CardTurn[] = [];
  const main = es.filter(e => !e.isSidechain && (e.type === 'user' || e.type === 'assistant'));
  for (const [i, e] of main.entries()) {
    if (e.type !== 'assistant') continue;
    // the card, or the plan view (ExitPlanMode "proposal <hash>": hooks/consent.ts shows the proposal in the plan dialog)
    const call = blocksOf(e).find(c => c && c.type === 'tool_use' && (c.name === 'AskUserQuestion' || c.name === 'ExitPlanMode') && HASH_RE.test(JSON.stringify(c.input || {})));
    if (!call) continue;
    // back to the entry that started this turn (a user entry that is not a tool result)
    const starts = (x: TEntry): boolean => !!(x.type === 'user' && !isToolResult(x) && (!x.isMeta || (x.origin && x.origin.kind === 'peer')));
    const s = main.slice(0, i).findLastIndex(starts);
    const ids = new Set<string | undefined>();
    for (const x of main.slice(s + 1, i + 1)) if (x.type === 'assistant') ids.add(x.message?.id || x.uuid);
    // forward to the end of the turn
    const after = new Set<string | undefined>();
    for (const x of main.slice(i + 1)) {
      if (starts(x)) break;
      if (x.type === 'assistant') { const id = x.message?.id || x.uuid; if (!ids.has(id)) after.add(id); }
    }
    out.push({ at: e.timestamp, hash: (HASH_RE.exec(JSON.stringify(call.input)) || ['', ''])[1] ?? '', toCard: ids.size, after: after.size });
  }
  // the card call and its answer can be split over several assistant entries with one message id: dedupe by call
  const seen = new Set<string>();
  return out.filter(c => { const k = c.at + c.hash; if (seen.has(k)) return false; seen.add(k); return true; });
}

/** A seat's room wakes, by what started them. */
export interface Wakes { turns: number, plugin: number, peer: number, rewake: number, rowNotifications: number, humanPrompts: number }
/** Chat rows, their copies, and the model turns and calls chat alone started. */
export interface Chat { notices: number, pulls: number, turns: number, calls: number, callsPerBurst?: number | null }
/** One seat's transcript metrics. */
export interface SeatMetrics {
  wakes: Wakes;
  chat: Chat;
  injected: { join: number, total: number, count: number, byEvent: Record<string, number> };
  cards: CardTurn[];
}

/** The hook_additional_context of an attachment, as a list. */
const contextOf = (c: unknown): unknown[] => [c || []].flat();

export function seatTranscriptMetrics(ts: Pick<Transcript, 'es'>[]): SeatMetrics {
  const w: Wakes = { turns: 0, plugin: 0, peer: 0, rewake: 0, rowNotifications: 0, humanPrompts: 0 };
  const chat: Chat = { notices: 0, pulls: 0, turns: 0, calls: 0 };
  const inj: SeatMetrics['injected'] = { join: 0, total: 0, count: 0, byEvent: {} };
  const cards: CardTurn[] = [];
  for (const { es } of ts) {
    let pending: Trigger | null = null; // a trigger waiting for its assistant message
    // chat: since the last turn end, did anything but chat rows arrive? (null: no turn open, 'chat': only chat)
    let since: 'other' | 'chat' | null = 'other', chatIds: Set<string | undefined> | null = null;
    for (const e of es) {
      if (e.type === 'system' && e.subtype === 'turn_duration') { since = null; chatIds = null; continue; }
      if (isChatNotice(e)) { chat.notices++; if (since === null) since = 'chat'; continue; }
      if (isPull(e)) { chat.pulls++; if (since === null) since = 'chat'; continue; }
      // a queued prompt (a notification, a wake) starts the next turn, even when its user entry is written later
      if ((e.type === 'user' && !e.isSidechain && !isToolResult(e) && !isPull(e)) || (e.type === 'queue-operation' && e.operation === 'enqueue')) since = 'other';
      // Claude Code's own "No response requested." on --continue is no model call
      if (e.type === 'assistant' && !e.isSidechain && since === 'chat' && e.message?.model !== '<synthetic>') {
        if (!chatIds) { chatIds = new Set(); chat.turns++; }
        const id = e.message?.id || e.uuid;
        if (!chatIds.has(id)) { chatIds.add(id); chat.calls++; }
      }
      if (e.attachment && e.attachment.type === 'hook_additional_context') {
        const n = contextOf(e.attachment.content).join('\n').length;
        inj.total += n; inj.count++;
        const ev = e.attachment.hookEvent || '?';
        inj.byEvent[ev] = (inj.byEvent[ev] || 0) + n;
        if (ev === 'UserPromptExpansion') inj.join += n;
        // the room context rides beside a prompt (a turn of its own's start is the prompt, not this)
        if (contextOf(e.attachment.content).some(c => String(c).startsWith('sub-human room context'))) chat.pulls++;
        continue;
      }
      if (e.isSidechain) continue;
      if (e.type === 'assistant') { if (pending) { w.turns++; pending = null; } continue; }
      // a peer delivery is written isMeta; any other meta entry is not a prompt
      if (e.type !== 'user' || (e.isMeta && !(e.origin && e.origin.kind === 'peer')) || isToolResult(e)) continue;
      const k = trigger(e);
      if (k) {
        w[k]++;
        pending = pending || k;
        continue;
      }
      pending = null; // a human prompt (or another notification) starts the next turn: not room-caused
      const kind = e.origin && e.origin.kind;
      if (kind === 'task-notification') w.rowNotifications++;
      else w.humanPrompts++;
    }
    cards.push(...cardTurns(es));
  }
  chat.callsPerBurst = chat.notices ? +(chat.calls / chat.notices).toFixed(2) : null;
  return { wakes: w, chat, injected: inj, cards };
}

const RED_256 = [1, 9, 124, 160, 161, 196, 197, 203, 204, 210];

/**
 * A line drawn in red: red (SGR 31/91, a 256-color red or a truecolor red) is the foreground of at least half its
 * visible non-space characters, as an error line is. Red tokens in syntax-highlighted code (a JSON string in a plan,
 * `await` in a diff) are a minority of their line and do not count.
 */
export function isRed(line: string): boolean {
  let red = false, n = 0, r = 0;
  const count = (s: string): void => { const k = s.replace(/\s/g, '').length; n += k; if (red) r += k; };
  let last = 0;
  for (const m of line.matchAll(/\x1b\[([0-9;]*)m/g)) {
    count(line.slice(last, m.index));
    last = m.index + m[0].length;
    const g = m[1] ?? '';
    const p = g === '' ? [0] : g.split(';').map(Number);
    for (let i = 0; i < p.length; i++) {
      const c = p[i];
      if (c === undefined) break;
      if (c === 0 || c === 39) red = false;
      else if (c === 31 || c === 91) red = true;
      else if ((c >= 30 && c <= 37) || (c >= 90 && c <= 97)) red = false;
      else if (c === 38 && p[i + 1] === 5) { const v = p[i + 2]; red = v !== undefined && RED_256.includes(v); i += 2; }
      else if (c === 38 && p[i + 1] === 2) { const [R = NaN, G = NaN, B = NaN] = p.slice(i + 2, i + 5); red = R >= 200 && G <= 115 && B <= 140 && R - G >= 120; i += 4; }
      else if (c === 48 && (p[i + 1] === 5 || p[i + 1] === 2)) i += p[i + 1] === 5 ? 2 : 4; // a background: skip its args
    }
  }
  count(line.slice(last).replace(/\x1b\[[0-9;]*[A-Za-z]/g, ''));
  return n > 0 && r * 2 >= n;
}

/** An @room receipt line: "⏺ ✓ sent" / "⏺ ⧗ queued: …" (0.5.0-beta.9), or the older "Operation stopped by hook: …". */
const RECEIPT = /^⏺ (?:Operation stopped by hook: )?[✓⧗] |Operation stopped by hook/;

/** A seat's noise counts: captures, lines, receipts, red, one per NOISE kind, and the per-capture ratios. */
export interface Noise {
  captures: number;
  lines: number;
  receipts: number;
  red: number;
  perCapture: number | null;
  perCaptureExWaiting: number | null;
  [kind: string]: number | null;
}

function noiseFor(screens: string | undefined, index: CaptureRec[], seat: string): Noise {
  const caps = index.filter(r => r.session === `sh-${seat}`);
  const n: { captures: number, lines: number, receipts: number, red: number, [kind: string]: number } = { captures: caps.length, lines: 0, receipts: 0, red: 0 };
  for (const k of Object.keys(NOISE)) n[k] = 0;
  for (const r of caps) {
    let t = '';
    try { t = fs.readFileSync(path.join(screens || '', r.txt), 'utf8'); } catch { continue; }
    for (const l of t.split('\n')) {
      if (RECEIPT.test(l)) n.receipts++;
      let hit = false;
      for (const [k, re] of Object.entries(NOISE)) if (re.test(l)) { n[k] = (n[k] ?? 0) + 1; hit = true; }
      if (hit) n.lines++;
    }
    let a: string | null = null;
    try { a = fs.readFileSync(path.join(screens || '', r.txt.replace(/\.txt$/, '.ansi')), 'utf8'); } catch { /* none */ }
    for (const l of (a || t).split('\n')) if ((a && isRed(l)) || /hook error/i.test(l.replace(/\x1b\[[0-9;]*m/g, ''))) n.red++;
  }
  return {
    ...n, // captures, lines, receipts, red first: n's own key order
    perCapture: caps.length ? +(n.lines / caps.length).toFixed(2) : null,
    perCaptureExWaiting: caps.length ? +((n.lines - (n.waiting ?? 0)) / caps.length).toFixed(2) : null,
  };
}

/** measure()'s options: the run's screens, the projects dir (default ~/.claude/projects), home, room and its people. */
export interface MeasureOpts { screens?: string, projects?: string, home?: string, code?: string, seats?: string[] | undefined }
/** One seat's measurements in a run. */
export interface SeatMeasure extends SeatMetrics { transcripts: string[], noise: Noise }

export function measure({ screens, projects, home, code, seats: people = ['alice', 'bob'] }: MeasureOpts = {}) {
  const SEATS = ['claude', ...people];
  const index = screens ? readJson<CaptureRec[]>(path.join(screens, 'index.json'), []) : [];
  const times = index.map(r => r.time).filter(Boolean).sort();
  const first = times.at(0), last = times.at(-1);
  if (first === undefined || last === undefined) return { error: `no captures in ${screens}` };
  // the run starts a little before the first capture (S1's /sub-human); stop 30 s after the last one
  const from = new Date(Date.parse(first) - 120_000).toISOString();
  const to = new Date(Date.parse(last) + 30_000).toISOString();
  const roomClaudeSid = roomClaudeSession(home || process.env.SUB_HUMAN_HOME, code);
  const seats: Record<string, SeatMeasure> = {};
  const all = { lines: 0, captures: 0, waiting: 0, red: 0 };
  let wakes = 0;
  const cards: (CardTurn & { seat: string })[] = [];
  for (const seat of SEATS) {
    const ts = transcripts(seat, from, to, projects, roomClaudeSid);
    const m = seatTranscriptMetrics(ts);
    const noise = noiseFor(screens, index, seat);
    seats[seat] = { transcripts: ts.map(t => path.basename(t.file).slice(0, 8)), ...m, noise };
    wakes += m.wakes.turns;
    if (seat !== 'claude') cards.push(...m.cards.map(c => ({ seat, ...c })));
    all.lines += noise.lines; all.captures += noise.captures; all.waiting += noise.waiting ?? 0; all.red += noise.red;
  }
  const kinds = Object.keys(NOISE);
  const seatOf = (s: string): SeatMeasure => { const m = seats[s]; if (!m) throw new Error(`no measure for ${s}`); return m; };
  const sum = (k: string): number => SEATS.reduce((a, s) => a + (seatOf(s).noise[k] ?? 0), 0);
  const avg = (k: 'toCard' | 'after'): number | null => (cards.length ? +(cards.reduce((a, c) => a + c[k], 0) / cards.length).toFixed(2) : null);
  const noise: Noise = {
    captures: all.captures, lines: all.lines,
    perCapture: all.captures ? +(all.lines / all.captures).toFixed(2) : null,
    perCaptureExWaiting: all.captures ? +((all.lines - all.waiting) / all.captures).toFixed(2) : null,
    ...Object.fromEntries(kinds.map(k => [k, sum(k)])),
    receipts: sum('receipts'),
    red: all.red,
  };
  return {
    window: { from, to },
    roomClaudeSession: roomClaudeSid,
    seats,
    total: {
      wakes,
      roomWakesMembers: people.reduce((a, s) => a + seatOf(s).wakes.turns, 0),
      pluginWakes: SEATS.reduce((a, s) => a + seatOf(s).wakes.plugin, 0),
      chat: (() => {
        const c: Chat = { notices: 0, pulls: 0, turns: 0, calls: 0 };
        for (const s of SEATS) for (const k of ['notices', 'pulls', 'turns', 'calls'] as const) c[k] += seatOf(s).chat[k];
        c.callsPerBurst = c.notices ? +(c.calls / c.notices).toFixed(2) : null;
        return c;
      })(),
      joinChars: SEATS.filter(s => s !== 'claude').map(s => seatOf(s).injected.join),
      injectedTotal: SEATS.reduce((a, s) => a + seatOf(s).injected.total, 0),
      cards: { count: cards.length, toCard: avg('toCard'), after: avg('after'), perCard: cards.length ? +(cards.reduce((a, c) => a + c.toCard + c.after, 0) / cards.length).toFixed(2) : null, list: cards },
      noise,
    },
  };
}

/** measure()'s answer: the run's metrics, or why there are none. */
export type Measured = ReturnType<typeof measure>;

if (import.meta.main) {
  const a = process.argv.slice(2), o: Record<string, string | undefined> = {};
  const it = a.values();
  for (const x of it) if (x.startsWith('--')) o[x.slice(2)] = it.next().value;
  const screens = path.resolve(o.screens || path.join(import.meta.dirname, '..', 'docs/rebuild/screens'));
  const seats = (readJson<{ seats?: string[] } | null>(path.join(screens, 'run.json'), {}) || {}).seats; // the run's two people (demo.sh plan-run)
  process.stdout.write(JSON.stringify(measure({ screens, home: o.home || paths.demoHome(), seats }), null, 1) + '\n');
}

