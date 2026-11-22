/**
 * transcripts: the seats' and the room Claude's Claude Code transcripts (read-only), for checks/context.ts.
 *
 *   seatFiles(seat), entries(seat)             a seat's main transcript files and their entries ('claude': by session id)
 *   inSpan, toolUses, assistantIds             filters over entries
 *   peerIn, wakeIn, chatIn, pullIn             peer messages, room wakes, chat rows and their isMeta copies
 *   chatTurn, roomClaudeTurns, replyAfter, noModelTurn   which model turns room traffic started
 *   rowUserText, rowReply                      the row subagents' transcripts
 *   seatAgents(seat)                           a seat's subagents (subagents(): the room row, its hold calls, others)
 *   toolResults(es)                            the text of every tool_result (a tool's or a hook's answer)
 */
import fs from 'node:fs';
import path from 'node:path';
import * as metrics from '../metrics.ts';
import * as paths from '../lib/paths.ts';
import { readText, readJson, jsonl } from '../lib/io.ts';
import type { Block, TEntry } from '../metrics.ts';
import type { Span } from './captures.ts';
import type { LogEntry } from './log.ts';

const { blocksOf } = metrics;
const isToolResults = (e: TEntry): boolean => Array.isArray(e.message && e.message.content) && blocksOf(e).every(c => c && c.type === 'tool_result');

/** A tool call in a transcript, with the time of the entry it was in. */
export type ToolUse = Block & { at: string | undefined };

/** A transcript content block, as far as a tool_result's is read. */
const isBlock = (c: unknown): c is { type?: string; content?: unknown } => typeof c === 'object' && c !== null;
/** The text of every tool_result in a seat's transcript entries (what a tool or a hook answered its Claude). */
export const toolResults = (es: { message?: { content?: unknown } }[]): string[] => es.flatMap(e => {
  const content = e.message ? e.message.content : undefined;
  const blocks = Array.isArray(content) ? content.filter(isBlock) : [];
  return blocks.filter(c => c && c.type === 'tool_result').map(c => (typeof c.content === 'string' ? c.content : JSON.stringify(c.content ?? '')));
});

const inSpan = <E extends { timestamp?: string }>(es: E[], s: Span | null | undefined): (E & { timestamp: string })[] => (s ? es.filter((e): e is E & { timestamp: string } => !!e.timestamp && e.timestamp > s.from && e.timestamp <= s.to) : []);
const toolUses = (es: TEntry[], name?: string): ToolUse[] => es.filter(e => e.type === 'assistant' && !e.isSidechain).flatMap(e => blocksOf(e).filter(c => c && c.type === 'tool_use' && (!name || c.name === name || new RegExp(name).test(c.name || ''))).map(c => ({ ...c, at: e.timestamp })));
const assistantIds = (es: TEntry[]): Set<string | undefined> => new Set(es.filter(e => e.type === 'assistant' && !e.isSidechain).map(e => e.message?.id || e.uuid));
const peerIn = <E extends TEntry>(es: E[], from?: string): E[] => es.filter(e => e.type === 'user' && e.origin && e.origin.kind === 'peer' && (!from || String(e.origin.name || '').startsWith(from + '.')));
// room wakes: the hooks module's plugin prompt
const wakeIn = <E extends TEntry>(es: E[]): E[] => es.filter(e => metrics.trigger(e) === 'plugin');
// the hooks module's chat rows ($.ui.log, "sub-human: …") and their isMeta copies for the model: chat never wakes it
const chatIn = <E extends TEntry>(es: E[]): E[] => es.filter(metrics.isChatNotice);
const pullIn = <E extends TEntry>(es: E[]): E[] => es.filter(metrics.isPull);

/** The room row's one tool (agents/room.md). */
export const HOLD_TOOL = 'mcp__plugin_sub-human_room__hold';
/** One hold call of a subagent: when, the room it names, and its result's text (null: still blocking, or never answered). */
export interface HoldCall { at: string, room: string, result: string | null }
/**
 * A subagent of one session (PROJECT/SESSION/subagents/agent-ID.jsonl, its agentType and parent from agent-ID.meta.json):
 * `id` the agent id (ID), `parent` the agent that spawned it (meta parentAgentId: a keeper's is its room row), '' for
 * main's own.
 */
export interface SubAgent { session: string, file: string, id: string, parent: string, agentType: string, first: string, prompt: string, holds: HoldCall[], modelText: string[], drawn: DrawnLine[] }
/** One line a chat row drew: a line of a turn.step answer of the module's (answeredWithoutRequest), and when. */
export interface DrawnLine { at: string, text: string }

const textOfContent = (c: string | Block[] | undefined): string => (typeof c === 'string' ? c : (c || []).filter(b => b.type === 'text').map(b => b.text ?? '').join('\n'));

const isText = (c: unknown): c is { type: 'text', text: string } => typeof c === 'object' && c !== null && 'type' in c && c.type === 'text' && 'text' in c && typeof c.text === 'string';
/** One subagent transcript and its meta file, read. */
function subagent(dir: string, session: string, f: string): SubAgent {
  const meta = readJson<{ agentType?: unknown, parentAgentId?: unknown } | null>(path.join(dir, f.replace(/\.jsonl$/, '.meta.json')), null);
  const es = jsonl<TEntry>(path.join(dir, f));
  const results = new Map<string, string>();
  for (const e of es) {
    if (e.type !== 'user') continue;
    // a result's text: a string, or its text blocks (2.1.296 writes an MCP result as [{type: text, text}])
    for (const c of blocksOf(e)) if (c.type === 'tool_result' && c.tool_use_id) results.set(c.tool_use_id, typeof c.content === 'string' ? c.content : Array.isArray(c.content) && c.content.some(isText) ? c.content.filter(isText).map(t => t.text).join('\n') : JSON.stringify(c.content ?? ''));
  }
  const holds: HoldCall[] = es.filter(e => e.type === 'assistant').flatMap(e => blocksOf(e).filter(c => c.type === 'tool_use' && c.name === HOLD_TOOL)
    .map(c => ({ at: e.timestamp ?? '', room: typeof c.input?.room === 'string' ? c.input.room : '', result: (c.id ? results.get(c.id) : undefined) ?? null })));
  // text its model wrote: an assistant entry the hooks module did not answer (a turn.step answer is marked
  // answeredWithoutRequest: cc CONTRACT step-answered-without-request)
  const modelText = es.filter(e => e.type === 'assistant' && !e.answeredWithoutRequest)
    .flatMap(e => blocksOf(e).filter(c => c.type === 'text' && (c.text ?? '').trim()).map(c => c.text ?? ''));
  // what the module drew in the row (room-chat on: mod/chat.ts answers each step with the waiting lines; "·" is nothing)
  const drawn: DrawnLine[] = es.filter(e => e.type === 'assistant' && e.answeredWithoutRequest)
    .flatMap(e => blocksOf(e).filter(c => c.type === 'text').flatMap(c => (c.text ?? '').split('\n')).filter(l => l.trim() && l.trim() !== '·').map(text => ({ at: e.timestamp ?? '', text })));
  const u = es.find(e => e.type === 'user');
  return { session, file: f, id: f.replace(/^agent-/, '').replace(/\.jsonl$/, ''), parent: meta && typeof meta.parentAgentId === 'string' ? meta.parentAgentId : '',
    agentType: meta && typeof meta.agentType === 'string' ? meta.agentType : '', first: es.find(e => e.timestamp)?.timestamp ?? '',
    prompt: textOfContent(u && u.message ? u.message.content : undefined), holds, modelText, drawn };
}

/**
 * Every subagent of every session in a Claude Code project dir (a seat's: paths.seatProjectDir), oldest first: the room
 * row (agentType sub-human:room, prompt "room: CODE", its hold calls), a Claude's own subagents, and any participant row
 * an older build spawned. A subagent whose meta file is missing has agentType ''. `session`: only that session's.
 */
export function subagents(projectDir: string, session?: string | null): SubAgent[] {
  let ds: string[] = [];
  try { ds = fs.readdirSync(projectDir).filter(d => (!session || d === session) && fs.existsSync(path.join(projectDir, d, 'subagents'))); } catch { return []; }
  const out: SubAgent[] = [];
  for (const d of ds) {
    const dir = path.join(projectDir, d, 'subagents');
    let files: string[] = [];
    try { files = fs.readdirSync(dir).filter(x => x.endsWith('.jsonl')); } catch { continue; }
    for (const f of files) out.push(subagent(dir, d, f));
  }
  return out.sort((a, b) => (a.first < b.first ? -1 : a.first > b.first ? 1 : 0));
}
/**
 * A room row: the agent type the hooks module spawns (agents/room.md), or, with no meta file, its prompt: "chat: CODE"
 * (0.8.0, room-chat on: the row idles, its keeper holds) or "room: CODE" (room-chat off: the row itself holds).
 */
export const isRoomRow = (s: SubAgent, code: string): boolean => {
  const p = s.prompt.trim(), named = /^(?:room|chat): (\S+)$/.exec(p);
  // a row whose prompt names another room is that room's (an earlier run's, in the same seat folder)
  if (named && named[1] !== code) return false;
  return s.agentType === 'sub-human:room' || (!s.agentType && !!named);
};
/** A room row that is the room's chat (room-chat on): its prompt "chat: CODE". */
export const isChatRow = (s: SubAgent, code: string): boolean => isRoomRow(s, code) && s.prompt.trim() === `chat: ${code}`;
/** A chat row's keeper (agents/keeper.md, the row's background child): its type, or, with no meta file, "keep: CODE". */
export const isKeeper = (s: SubAgent, code: string): boolean => {
  const named = /^keep: (\S+)$/.exec(s.prompt.trim());
  if (named && named[1] !== code) return false;
  return s.agentType === 'sub-human:keeper' || (!s.agentType && !!named);
};
/** Whether s's last hold call for code has no result (still blocking). */
const blocking = (s: SubAgent, code: string): boolean => s.holds.filter(h => h.room === code).at(-1)?.result === null;
/** A room row (room-chat off) or a keeper (on) of room code whose hold is blocking (its last hold call for code has no result). */
export const holdingRow = (s: SubAgent, code: string): boolean => (isRoomRow(s, code) || isKeeper(s, code)) && blocking(s, code);
/**
 * Whether a session's subagents (subagents(dir, sid)) hold room code: room-chat off, a room row whose hold blocks;
 * on, a chat row and, in the same session, a keeper of the room whose hold ({room, take}) blocks.
 */
export const rowHolds = (all: readonly SubAgent[], code: string): boolean => all.some(s => {
  if (!isRoomRow(s, code)) return false;
  if (!isChatRow(s, code) && blocking(s, code)) return true;
  return all.some(k => k.session === s.session && isKeeper(k, code) && (!k.parent || k.parent === s.id) && blocking(k, code));
});
/** Every line the chat rows of room code among `all` drew (room-chat on), oldest first. */
export const drawnIn = (all: readonly SubAgent[], code: string): DrawnLine[] =>
  all.filter(s => isChatRow(s, code)).flatMap(s => s.drawn).sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
/** Whether room row `row` held code at all: its own hold call (room-chat off), or its keeper's (on). */
export const rowHeld = (all: readonly SubAgent[], row: SubAgent, code: string): boolean =>
  row.holds.some(h => h.room === code) || all.some(k => k.session === row.session && isKeeper(k, code) && (!k.parent || k.parent === row.id) && k.holds.some(h => h.room === code));
/** The cap on a row's keepers (mod/core/room-chat.ts KEEPER_MAX in KEEPER_WINDOW_MS): the most started in any window. */
export const KEEPERS_MAX = 5, KEEPERS_WINDOW_MS = 10 * 60_000;
/**
 * The keepers room row `row` started (meta parentAgentId), oldest first; `woke` how many followed a keeper whose hold
 * ended on a WAKE (a room line for the row: its job, mcp/hold.ts), and `peak` the most of the others (spawns after a
 * death, the first one included) in any KEEPERS_WINDOW_MS: the cap counts those only (mod/chat.ts).
 */
export function rowKeepers(all: readonly SubAgent[], row: SubAgent, code: string): { keepers: SubAgent[], woke: number, peak: number } {
  const keepers = all.filter(k => k.session === row.session && isKeeper(k, code) && k.parent === row.id).sort((a, b) => (a.first < b.first ? -1 : a.first > b.first ? 1 : 0));
  const afterWake = (i: number): boolean => i > 0 && /^\s*WAKE\b/.test(keepers[i - 1]?.holds.filter(h => h.room === code).at(-1)?.result ?? '');
  const counted = keepers.filter((_k, i) => !afterWake(i));
  const ts = counted.map(k => Date.parse(k.first)).filter(t => !Number.isNaN(t)).sort((a, b) => a - b);
  let peak = 0;
  for (const [i, t] of ts.entries()) peak = Math.max(peak, ts.slice(i).filter(u => u - t < KEEPERS_WINDOW_MS).length);
  return { keepers, woke: keepers.length - counted.length, peak };
}
/**
 * What a session's room rows nest (room-chat on: each row's only child its keeper): the subagents whose parent is a
 * room row of code and that are not its keeper. [] is right.
 */
export const rowStrays = (all: readonly SubAgent[], code: string): SubAgent[] => {
  const rows = new Set(all.filter(s => isRoomRow(s, code)).map(s => s.id));
  return all.filter(s => !!s.parent && rows.has(s.parent) && !isKeeper(s, code));
};

/** Each entry of a seat's row-subagent transcripts (…/SESSION/subagents/*.jsonl), with its file name. */
function* rowEntries(seat: string): Generator<{ e: TEntry, file: string }> {
  const dir = paths.seatProjectDir(seat);
  let ds: string[] = [];
  try { ds = fs.readdirSync(dir).filter(d => fs.existsSync(path.join(dir, d, 'subagents'))); } catch { return; }
  for (const d of ds) for (const f of fs.readdirSync(path.join(dir, d, 'subagents')).filter(x => x.endsWith('.jsonl'))) {
    for (const e of jsonl<TEntry>(path.join(dir, d, 'subagents', f))) yield { e, file: f };
  }
}
/** A user message matching re delivered to one of a seat's row subagents after `since`. */
function rowUserText(seat: string, since: string, re: RegExp): { at: string, file: string } | null {
  for (const { e, file } of rowEntries(seat)) {
    if (e.type !== 'user' || !e.timestamp || e.timestamp < since) continue;
    const c = e.message && e.message.content;
    const t = typeof c === 'string' ? c : Array.isArray(c) ? c.filter(x => x && x.type === 'text').map(x => x.text).join('\n') : '';
    if (re.test(t)) return { at: e.timestamp, file };
  }
  return null;
}
/** A row subagent's "read-only row" text in a seat's subagent transcripts after `since`. */
function rowReply(seat: string, since: string): { at: string, text: string, file: string } | null {
  for (const { e, file } of rowEntries(seat)) {
    if (e.type !== 'assistant' || !e.timestamp || e.timestamp < since) continue;
    const tx = blocksOf(e).find(c => c && c.type === 'text' && /read-only row/.test(c.text || ''));
    if (tx) return { at: e.timestamp, text: tx.text || '', file };
  }
  return null;
}

/** The helpers that read a seat's own transcript files (the room Claude's found by its session id under projects/). */
/** chatTurn's answer: whether a chat row started a model turn. */
export interface ChatTurn { woke: boolean, idle: boolean | null, evidence: string }

export function transcripts({ roomClaudeSid, projects }: { roomClaudeSid: string | null | undefined, projects: string }) {
  const seatFiles = (seat: string): string[] => {
    if (seat === 'claude') { const f: string[] = []; try { for (const d of fs.readdirSync(projects)) { const p = path.join(projects, d, `${roomClaudeSid}.jsonl`); if (roomClaudeSid && fs.existsSync(p)) f.push(p); } } catch { /* none */ } return f; }
    const dir = paths.seatProjectDir(seat);
    // not a room Claude's transcript (this run's, or an earlier run's room Claude that also started in alice's folder)
    const isRoomClaude = (f: string): boolean => f === `${roomClaudeSid}.jsonl` || /"agentSetting":"sub-human:room-claude"/.test((readText(path.join(dir, f)) || '').slice(0, 2000));
    try { return fs.readdirSync(dir).filter(f => f.endsWith('.jsonl') && !isRoomClaude(f)).map(f => path.join(dir, f)); } catch { return []; }
  };
  const tcache: Record<string, TEntry[]> = {};
  const entries = (seat: string): TEntry[] => (tcache[seat] = tcache[seat] || seatFiles(seat).flatMap(f => jsonl<TEntry>(f).map(e => ({ ...e, _file: path.basename(f) }))).filter(e => e.agentSetting !== 'sub-human:room-claude' || seat === 'claude'));
  /** A transcript's main-thread entries of the file `ref` (an entry) came from, and ref's index in them; null if not found. */
  const around = (seat: string, ref: TEntry | null | undefined): { es: TEntry[], i: number } | null => {
    const f = ref && seatFiles(seat).find(x => path.basename(x) === ref._file);
    if (!f) return null;
    const es = jsonl<TEntry>(f).filter(e => !e.isSidechain);
    return { es, i: es.findIndex(e => e.uuid === ref.uuid) };
  };
  /**
   * Whether chat row `note` (an entry of seat's transcripts) started a model turn: idle when it arrived (the last
   * turn had ended: a turn_duration, or nothing, since the last prompt) and an assistant message follows before
   * any other prompt. {woke, idle, evidence}.
   */
  function chatTurn(seat: string, note: TEntry): ChatTurn {
    const at = around(seat, note);
    if (!at) return { woke: false, idle: null, evidence: 'no chat row' };
    const { es, i } = at;
    if (i < 0) return { woke: false, idle: null, evidence: 'chat row not found' };
    const isPrompt = (e: TEntry): boolean => !!(e.type === 'user' && !metrics.isPull(e) && !isToolResults(e) && (!e.isMeta || (e.origin && e.origin.kind === 'peer')));
    let idle = true;
    for (const e of es.slice(0, i).reverse()) {
      if (e.type === 'system' && e.subtype === 'turn_duration') break;
      if (isPrompt(e) || e.type === 'assistant') { idle = false; break; }
    }
    if (!idle) return { woke: false, idle, evidence: 'arrived during a running turn (folded in, no turn of its own)' };
    for (const e of es.slice(i + 1)) {
      if (isPrompt(e)) return { woke: false, idle, evidence: `idle; the next turn began with a prompt (${(e.origin && e.origin.kind) || e.type})` };
      if (e.type === 'assistant') return { woke: true, idle, evidence: `idle, then an assistant message at ${String(e.timestamp).slice(11, 19)} with no prompt` };
    }
    return { woke: false, idle, evidence: 'idle; no model call after it' };
  }
  const roomClaudeTurns = (s: Span | null | undefined): number => assistantIds(inSpan(entries('claude'), s)).size;

  /** The assistant turn a wake started in seat's transcript: its text (all text blocks, in order) and tool names, up to the next prompt or notice. */
  function replyAfter(seat: string, wake: TEntry): { text: string, tools: (string | undefined)[] } | null {
    const at = around(seat, wake);
    if (!at || at.i < 0) return null;
    const text: (string | undefined)[] = [], tools: (string | undefined)[] = [];
    for (const e of at.es.slice(at.i + 1)) {
      if (e.type === 'user' && !e.isMeta && !isToolResults(e)) break;
      if (e.type !== 'assistant') continue;
      for (const c of blocksOf(e)) {
        if (c && c.type === 'text') text.push(c.text);
        if (c && c.type === 'tool_use') tools.push(c.name);
      }
    }
    return { text: text.join('\n'), tools };
  }
  /** Whether a room post `e` (an @room receipt) started no model turn in seat's transcripts: {pass, evidence}. */
  function noModelTurn(seat: string, e: LogEntry | null | undefined): { pass: boolean, evidence: string } {
    if (!e) return { pass: false, evidence: 'no entry' };
    for (const f of seatFiles(seat)) {
      const es = jsonl<TEntry>(f);
      const q = es.find(x => x.type === 'queue-operation' && x.operation === 'remove' && x.reason === 'dropped_by_hook' && typeof x.content === 'string' && x.content.endsWith(String(e.text)));
      if (q) return { pass: true, evidence: `${path.basename(f).slice(0, 8)}…: queued prompt removed by the hook (#${e.id}); it never reached the model` };
      // the receipt carries no id: the first receipt at or after the entry (within 10 s): a "✓ sent" system line (before
      // the quiet release), or the model's copy of the stop, "sub-human: @room message sent. No reply." (mod/core/prompt.ts
      // RECEIPT_FOR_MODEL; the drawn stop row is QUIET_ROW, the person's own row being the receipt)
      const near = (t: string | undefined): boolean => !!t && t >= new Date(Date.parse(e.at) - 2000).toISOString() && t <= new Date(Date.parse(e.at) + 10_000).toISOString();
      const i = es.findIndex(x => near(x.timestamp) && ((x.type === 'system' && typeof x.content === 'string' && /✓ sent/.test(x.content))
        || (x.type === 'user' && !!x.isMeta && /^sub-human: @room message sent\b/.test(textOfContent(x.message?.content)))));
      if (i < 0) continue;
      for (const x of es.slice(i + 1)) {
        // the next prompt: a typed one, a wake, or a peer message (written isMeta, origin peer)
        if ((x.type === 'user' && (!x.isMeta || (x.origin && x.origin.kind === 'peer'))) || (x.type === 'queue-operation' && x.operation === 'enqueue')) return { pass: true, evidence: `${path.basename(f).slice(0, 8)}…: hook receipt for #${e.id}, no assistant message before the next prompt or notice` };
        if (x.type === 'assistant') return { pass: false, evidence: `assistant message right after the receipt for #${e.id}` };
      }
      return { pass: true, evidence: `${path.basename(f).slice(0, 8)}…: hook receipt for #${e.id} is the last turn activity` };
    }
    return { pass: false, evidence: `no hook receipt for #${e.id} in ${seat}'s transcripts` };
  }
  /**
   * The copies for seat's Claude of room text `want` (a whole line of it) after `at`: isMeta rows (pulls) and contexts
   * held for its next prompt (mod/deliver.ts holdPullEvent: "room since your last turn"), and whether the seat has had a
   * main prompt since (`prompted`: false, a held copy has not ridden yet, so none can be seen).
   */
  function copiesOf(seat: string, want: string, at: string): { pulls: number, held: number, prompted: boolean } {
    const es = entries(seat).filter(e => !e.isSidechain && e.timestamp !== undefined && e.timestamp > at);
    const has = (t: string): boolean => t.split('\n').some(l => l === want || l.endsWith(want));
    const pulls = es.filter(e => metrics.isPull(e) && has(textOfContent(e.message?.content))).length;
    const held = es.filter(e => e.attachment && e.attachment.type === 'hook_additional_context' && [e.attachment.content].flat().some(c => typeof c === 'string' && has(c))).length;
    const prompted = es.some(e => e.type === 'user' && !isToolResults(e) && (!e.isMeta || metrics.trigger(e) === 'plugin'));
    return { pulls, held, prompted };
  }
  /** A seat's subagents ('claude': the room session's, in whichever project dir its session is). */
  const seatAgents = (seat: string): SubAgent[] => (seat === 'claude'
    ? seatFiles('claude').flatMap(f => subagents(path.dirname(f), roomClaudeSid))
    : subagents(paths.seatProjectDir(seat)));
  return { seatFiles, entries, inSpan, toolUses, assistantIds, peerIn, wakeIn, chatIn, pullIn, chatTurn, roomClaudeTurns, replyAfter, noModelTurn, rowUserText, rowReply, seatAgents, copiesOf };
}

