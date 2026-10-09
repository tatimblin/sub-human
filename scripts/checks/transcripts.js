'use strict';
/**
 * transcripts: the seats' and the room Claude's Claude Code transcripts (read-only), for checks/context.js.
 *
 *   seatFiles(seat), entries(seat)             a seat's main transcript files and their entries ('claude': by session id)
 *   inSpan, toolUses, assistantIds             filters over entries
 *   peerIn, wakeIn, chatIn, pullIn             peer messages, room wakes, chat rows and their isMeta copies
 *   chatTurn, roomClaudeTurns, replyAfter, noModelTurn   which model turns room traffic started
 *   rowUserText, rowReply                      the row subagents' transcripts
 */
const fs = require('node:fs');
const path = require('node:path');
const metrics = require('../metrics.js');
const paths = require('../lib/paths.js');
const { readText, jsonl } = require('../lib/io.js');

const isToolResults = e => Array.isArray(e.message && e.message.content) && e.message.content.every(c => c && c.type === 'tool_result');

const inSpan = (es, s) => (s ? es.filter(e => e.timestamp && e.timestamp > s.from && e.timestamp <= s.to) : []);
const toolUses = (es, name) => es.filter(e => e.type === 'assistant' && !e.isSidechain).flatMap(e => (e.message.content || []).filter(c => c && c.type === 'tool_use' && (!name || c.name === name || new RegExp(name).test(c.name))).map(c => ({ ...c, at: e.timestamp })));
const assistantIds = es => new Set(es.filter(e => e.type === 'assistant' && !e.isSidechain).map(e => e.message.id || e.uuid));
const peerIn = (es, from) => es.filter(e => e.type === 'user' && e.origin && e.origin.kind === 'peer' && (!from || String(e.origin.name || '').startsWith(from + '.')));
// room wakes: the hooks module's plugin prompt
const wakeIn = es => es.filter(e => metrics.trigger(e) === 'plugin');
// the hooks module's chat rows ($.ui.log, "sub-human: …") and their isMeta copies for the model: chat never wakes it
const chatIn = es => es.filter(metrics.isChatNotice);
const pullIn = es => es.filter(metrics.isPull);

/** Each entry of a seat's row-subagent transcripts (…/SESSION/subagents/*.jsonl), with its file name. */
function* rowEntries(seat) {
  const dir = paths.seatProjectDir(seat);
  let ds = [];
  try { ds = fs.readdirSync(dir).filter(d => fs.existsSync(path.join(dir, d, 'subagents'))); } catch { return; }
  for (const d of ds) for (const f of fs.readdirSync(path.join(dir, d, 'subagents')).filter(x => x.endsWith('.jsonl'))) {
    for (const e of jsonl(path.join(dir, d, 'subagents', f))) yield { e, file: f };
  }
}
/** A user message matching re delivered to one of a seat's row subagents after `since`. */
function rowUserText(seat, since, re) {
  for (const { e, file } of rowEntries(seat)) {
    if (e.type !== 'user' || !e.timestamp || e.timestamp < since) continue;
    const c = e.message && e.message.content;
    const t = typeof c === 'string' ? c : Array.isArray(c) ? c.filter(x => x && x.type === 'text').map(x => x.text).join('\n') : '';
    if (re.test(t)) return { at: e.timestamp, file };
  }
  return null;
}
/** A row subagent's "read-only row" text in a seat's subagent transcripts after `since`. */
function rowReply(seat, since) {
  for (const { e, file } of rowEntries(seat)) {
    if (e.type !== 'assistant' || !e.timestamp || e.timestamp < since) continue;
    const tx = (e.message.content || []).find(c => c && c.type === 'text' && /read-only row/.test(c.text));
    if (tx) return { at: e.timestamp, text: tx.text, file };
  }
  return null;
}

/** The helpers that read a seat's own transcript files (the room Claude's found by its session id under projects/). */
function transcripts({ roomClaudeSid, projects }) {
  const seatFiles = seat => {
    if (seat === 'claude') { const f = []; try { for (const d of fs.readdirSync(projects)) { const p = path.join(projects, d, `${roomClaudeSid}.jsonl`); if (roomClaudeSid && fs.existsSync(p)) f.push(p); } } catch { /* none */ } return f; }
    const dir = paths.seatProjectDir(seat);
    // not a room Claude's transcript (this run's, or an earlier run's room Claude that also started in alice's folder)
    const isRoomClaude = f => f === `${roomClaudeSid}.jsonl` || /"agentSetting":"sub-human:room-claude"/.test((readText(path.join(dir, f)) || '').slice(0, 2000));
    try { return fs.readdirSync(dir).filter(f => f.endsWith('.jsonl') && !isRoomClaude(f)).map(f => path.join(dir, f)); } catch { return []; }
  };
  const tcache = {};
  const entries = seat => (tcache[seat] = tcache[seat] || seatFiles(seat).flatMap(f => jsonl(f).map(e => ({ ...e, _file: path.basename(f) }))).filter(e => e.agentSetting !== 'sub-human:room-claude' || seat === 'claude'));
  /** A transcript's main-thread entries of the file `ref` (an entry) came from, and ref's index in them; null if not found. */
  const around = (seat, ref) => {
    const f = ref && seatFiles(seat).find(x => path.basename(x) === ref._file);
    if (!f) return null;
    const es = jsonl(f).filter(e => !e.isSidechain);
    return { es, i: es.findIndex(e => e.uuid === ref.uuid) };
  };
  /**
   * Whether chat row `note` (an entry of seat's transcripts) started a model turn: idle when it arrived (the last
   * turn had ended: a turn_duration, or nothing, since the last prompt) and an assistant message follows before
   * any other prompt. {woke, idle, evidence}.
   */
  function chatTurn(seat, note) {
    const at = around(seat, note);
    if (!at) return { woke: false, idle: null, evidence: 'no chat row' };
    const { es, i } = at;
    if (i < 0) return { woke: false, idle: null, evidence: 'chat row not found' };
    const isPrompt = e => e.type === 'user' && !metrics.isPull(e) && !isToolResults(e) && (!e.isMeta || (e.origin && e.origin.kind === 'peer'));
    let idle = true;
    for (let j = i - 1; j >= 0; j--) {
      const e = es[j];
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
  const roomClaudeTurns = s => assistantIds(inSpan(entries('claude'), s)).size;

  /** The assistant turn a wake started in seat's transcript: its text (all text blocks, in order) and tool names, up to the next prompt or notice. */
  function replyAfter(seat, wake) {
    const at = around(seat, wake);
    if (!at || at.i < 0) return null;
    const text = [], tools = [];
    for (const e of at.es.slice(at.i + 1)) {
      if (e.type === 'user' && !e.isMeta && !isToolResults(e)) break;
      if (e.type !== 'assistant') continue;
      for (const c of e.message.content || []) {
        if (c && c.type === 'text') text.push(c.text);
        if (c && c.type === 'tool_use') tools.push(c.name);
      }
    }
    return { text: text.join('\n'), tools };
  }
  /** Whether a room post `e` (an @room receipt) started no model turn in seat's transcripts: {pass, evidence}. */
  function noModelTurn(seat, e) {
    if (!e) return { pass: false, evidence: 'no entry' };
    for (const f of seatFiles(seat)) {
      const es = jsonl(f);
      const q = es.find(x => x.type === 'queue-operation' && x.operation === 'remove' && x.reason === 'dropped_by_hook' && typeof x.content === 'string' && x.content.endsWith(e.text));
      if (q) return { pass: true, evidence: `${path.basename(f).slice(0, 8)}…: queued prompt removed by the hook (#${e.id}); it never reached the model` };
      // the receipt carries no id: the first "✓ sent" system line at or after the entry (within 10 s)
      const i = es.findIndex(x => x.type === 'system' && typeof x.content === 'string' && /✓ sent/.test(x.content) && x.timestamp >= new Date(Date.parse(e.at) - 2000).toISOString() && x.timestamp <= new Date(Date.parse(e.at) + 10_000).toISOString());
      if (i < 0) continue;
      for (let j = i + 1; j < es.length; j++) {
        const x = es[j];
        // the next prompt: a typed one, a wake, or a peer message (written isMeta, origin peer)
        if ((x.type === 'user' && (!x.isMeta || (x.origin && x.origin.kind === 'peer'))) || (x.type === 'queue-operation' && x.operation === 'enqueue')) return { pass: true, evidence: `${path.basename(f).slice(0, 8)}…: hook receipt for #${e.id}, no assistant message before the next prompt or notice` };
        if (x.type === 'assistant') return { pass: false, evidence: `assistant message right after the receipt for #${e.id}` };
      }
      return { pass: true, evidence: `${path.basename(f).slice(0, 8)}…: hook receipt for #${e.id} is the last turn activity` };
    }
    return { pass: false, evidence: `no hook receipt for #${e.id} in ${seat}'s transcripts` };
  }
  return { seatFiles, entries, inSpan, toolUses, assistantIds, peerIn, wakeIn, chatIn, pullIn, chatTurn, roomClaudeTurns, replyAfter, noModelTurn, rowUserText, rowReply };
}

module.exports = { transcripts };
