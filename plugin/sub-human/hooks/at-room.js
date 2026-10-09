#!/usr/bin/env node
'use strict';
// UserPromptSubmit: "@room TEXT" or "room:TEXT" posts the human's exact words (via human, signed with the seat key)
// and ends the prompt, so no model turn runs and nothing is paraphrased. "@claude TEXT" posts the same way with
// to=claude, which wakes the room's Claude; outside a room it is an ordinary prompt and passes through untouched.
// Only a leading tag counts: "@room @claude TEXT" is a plain post, and a tag later in the text is just words. No hooks.json entry: hooks/prompt.js runs
// handle(input) under mod/prompt.mjs's shim. In: the payload plus `sub_human_origin` and `sub_human_nonce`. An origin
// counts only with this session's lease nonce, and only a typed one (composer, sdk, bridge; cc CONTRACT
// prompt-origin-composer) may post: anything that can run node can claim an origin, only a lease reader the nonce.
// Out: continue:false + "✓ sent" (the person's row stays, the model sees it next turn), or decision:block +
// suppressOriginalPrompt (refused text never reaches the model). Failure: no origin, a bad nonce or no seat
// refuses, and the person types it again. In the room's Claude, a typed prompt is refused (it takes no typed input); with
// no origin it runs, so a reload never loses the room Claude's wakes. "working" presence is written here only when no
// origin came (with one, mod/prompt.mjs has written it).
// A post the store refuses (RATE, AUTH, or OFFLINE in a room hosted elsewhere whose link daemon is gone) blocks the
// prompt with the reason. In a room hosted elsewhere whose link is down, the daemon queues the signed post instead
// (lib/remote/outbox.js) and "⧗ queued" ends the prompt; it is sent, in order, when the link is back. A post sent
// over a slow link that the host has not answered in time is "⧗ sending (slow link)" (kept under its nonce: the late
// copy is the post), and a deadline whose outcome is unknown is "⧗ not confirmed", never "not posted". Typed through Remote Control (origin bridge), a refusal is also the
// systemMessage, which the module relays to the phone (a block line does not show there); "✓ sent" is not (the phone
// shows the person's own row, and a relay costs a model turn).
const path = require('node:path');
const { identity, room, out, run, whoami, presence } = require('./common.js');
const { oneLine } = require(path.join(__dirname, '..', 'lib', 'text.js'));
const config = require(path.join(__dirname, '..', 'lib', 'config.js'));
const cc = require(path.join(__dirname, '..', 'lib', 'cc.js'));
const seats = require(path.join(__dirname, '..', 'lib', 'seats.js'));

function parse(prompt) {
  if (prompt.startsWith('@room ')) return prompt.slice('@room '.length);
  if (prompt === '@room') return '';
  if (prompt.startsWith('room:')) { const t = prompt.slice('room:'.length); return t.startsWith(' ') ? t.slice(1) : t; }
  return null;
}

/** "@claude TEXT" -> TEXT (posted to=claude: a wake for the room's Claude); anything else null. A copy of
 * mod/core/prompt.mjs parseClaude (test/mod-core.test.js asserts they agree). */
function parseClaude(prompt) {
  if (prompt.startsWith('@claude ')) return prompt.slice('@claude '.length);
  if (prompt === '@claude') return '';
  return null;
}

/** A person typing through Remote Control sees no block line there: a refusal also goes out as systemMessage, which
 * mod/prompt.mjs relays to the phone (mod/deliver.mjs relay). "✓ sent" stays a stop line only. */
let toPhone = false;
const phoneNote = text => (toPhone ? { systemMessage: `sub-human: ${text}` } : {});

const block = (reason, extra = {}) => out({
  decision: 'block', reason, ...phoneNote(reason),
  hookSpecificOutput: { hookEventName: 'UserPromptSubmit', suppressOriginalPrompt: true, ...extra },
});

const TAIL_BYTES = config.TRANSCRIPT_TAIL_BYTES;
/** The last TAIL_BYTES of a JSONL transcript as parsed entries (oldest first); [] when unreadable. */
const transcriptTail = file => cc.readEntries(file, { tailBytes: TAIL_BYTES });
const contentText = cc.contentText;

/** prompt.submit origins a person types from (mod/core/prompt.mjs TYPED_ORIGINS; bridge is the person typing
 * through Remote Control). */
const TYPED_ORIGINS = new Set(['composer', 'sdk', 'bridge']);

/** The text of the last assistant turn before this prompt (all its text blocks), or ''. */
function lastAssistantText(entries, promptId) {
  const parts = [];
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (!e || e.isSidechain) continue;
    if (e.type === 'assistant') { parts.unshift(contentText(e.message && e.message.content)); continue; }
    if (e.type !== 'user' || (promptId && e.promptId === promptId)) continue;
    const c = e.message && e.message.content;
    const toolResult = Array.isArray(c) && c.length && c.every(b => b && b.type === 'tool_result');
    if (!toolResult && !e.isMeta && parts.length) break; // the human prompt that started that turn
  }
  return parts.join('\n');
}

const DRAFT_MIN = 20; // shorter texts ("ok", "yes, ship it") show up in Claude's prose by chance

/** True when the posted text is Claude's wording: "@room TEXT" or "@claude TEXT" in its last message, or a longer
 * TEXT verbatim. */
function draftedByAgent(text, assistant) {
  const t = oneLine(text), a = oneLine(assistant);
  if (!t || !a) return false;
  return a.includes('@room ' + t) || a.includes('room:' + t) || a.includes('@claude ' + t) || (t.length >= DRAFT_MIN && a.includes(t));
}

// ---------- the room's Claude takes no typed input ----------
const LAUNCH = /^\/(?:sub-human:)?sub-human(?:\s|$)/;
const roomClaudeHint = me => `the room's Claude takes no typed input; type @claude in your own session, or ask your Claude to message ${identity.address(me.name, me.code)}`;

/** True when no earlier prompt of this session is in its transcript (a fresh session has none, or no file). */
function firstPrompt(input) {
  const es = transcriptTail(input.transcript_path);
  return !es.some(e => e && e.type === 'user' && !e.isMeta && e.promptId && e.promptId !== input.prompt_id && !e.isSidechain);
}

/** For a room Claude session: null when the prompt may run (anything not typed, the launch command), else the refusal. */
function roomClaudeRefusal(me, input, prompt, origin) {
  if (origin === null || !TYPED_ORIGINS.has(origin)) return null;
  return LAUNCH.test(prompt) && firstPrompt(input) ? null : roomClaudeHint(me);
}

/** The same words as the mod's GATE_FAILED (test/mod-core-prompt.test.js): either way the person types it again. */
const NO_ORIGIN = '✗ not posted: sub-human could not check who wrote this @room. Type it again.';

/** True when the input carries this session's module nonce (its lease's): the origin beside it is the module's. */
function attested(input) {
  const sid = input.session_id;
  if (typeof sid !== 'string' || typeof input.sub_human_nonce !== 'string') return false;
  const lease = identity.readModLease(sid);
  return !!lease && lease.session_id === sid && typeof lease.nonce === 'string' && lease.nonce === input.sub_human_nonce;
}

/** The UserPromptSubmit handler: writes its one output (if any) through common.js out(). hooks/prompt.js calls it. */
function handle(input) {
  const prompt = typeof input.prompt === 'string' ? input.prompt : '';
  // The origin the shim says the prompt came from (prompt.submit e.origin.kind), or null; it posts only attested.
  const claimed = typeof input.sub_human_origin === 'string' ? input.sub_human_origin : null;
  toPhone = claimed === 'bridge';
  const raw = prompt.startsWith('/') ? null : parse(prompt);
  const wake = raw === null && !prompt.startsWith('/') ? parseClaude(prompt) : null;
  const tag = wake !== null ? '@claude' : '@room';
  const me = whoami(input);
  if (me && me.role === 'claude') { // the origin unchecked: a forged one here only refuses more
    const refusal = roomClaudeRefusal(me, input, prompt, claimed);
    if (refusal) return block(refusal);
  }
  if (me && claimed === null) presence(me, 'working');
  if (raw === null && (wake === null || !me)) return; // outside a room, @claude is an ordinary prompt

  // not in a room first: typing it again would not help there
  if (!me) return block('✗ not posted: this session is not in a room. Join one first with /sub-human NAME [CODE].');
  const origin = claimed !== null && attested(input) ? claimed : null;
  if (origin === null) return block(NO_ORIGIN.replace('@room', tag));
  if (!TYPED_ORIGINS.has(origin)) {
    return block(`✗ not posted: this prompt was not typed by you (origin "${origin.slice(0, 40)}"). Only your own typed ${tag} posts as your words.`);
  }
  // A long paste arrives wrapped in <pasted_content>: post the person's text, marked normalized.
  const { text, normalized } = cc.unwrapPasted(raw !== null ? raw : wake);
  if (!text.trim()) return block(`✗ not posted: there is nothing after ${tag}.`);
  const entry = { kind: 'say', text };
  if (wake !== null) entry.to = identity.ROOM_CLAUDE;
  if (normalized) entry.normalized = true;
  if (draftedByAgent(text, lastAssistantText(transcriptTail(input.transcript_path), input.prompt_id))) entry.drafted = 'agent';
  let placed;
  try { placed = room.open(me.code).append(entry, { via: 'human', from: me.name, queue: true }); } catch (err) {
    if (!(err instanceof room.RoomError)) throw err;
    // it went out but no answer came in time: it may still land, so never "not posted" (typing it again would post twice)
    if (err.unknown) return block(`⧗ not confirmed: ${err.message}. Watch the room for it before you type it again.`);
    return block(`✗ not posted: ${err.message}`); // OFFLINE (the outbox full, the daemon gone), RATE, AUTH
  }
  if (placed && placed.slow) { // sent, the host slow to answer: the daemon holds it under its nonce until it does
    const q = `⧗ sending (slow link): room ${me.code} has not confirmed this post yet; it shows in the room once the host has it. No need to type it again`;
    return out({ continue: false, stopReason: q, ...phoneNote(q), hookSpecificOutput: { hookEventName: 'UserPromptSubmit' } });
  }
  if (placed && placed.queued) { // a room hosted elsewhere, its link down: the daemon holds it (lib/remote/outbox.js)
    const q = `⧗ queued: room ${me.code} is offline; this post is sent when the link is back (${placed.queued} waiting)`;
    return out({ continue: false, stopReason: q, ...phoneNote(q), hookSpecificOutput: { hookEventName: 'UserPromptSubmit' } });
  }
  // @claude on the host with no room's Claude running (it stopped, or never bound): start it, as a rejoin would
  const start = wake !== null ? seats.ensureRoomClaude(me.code, input.cwd, me.name) : '';
  const sent = `✓ sent${normalized ? ' (pasted text unwrapped)' : ''}${entry.drafted ? " (Claude's wording)" : ''}${start}`;
  out({ continue: false, stopReason: sent, hookSpecificOutput: { hookEventName: 'UserPromptSubmit' } });
}

module.exports = { handle, parse, parseClaude, TYPED_ORIGINS, NO_ORIGIN };

// hooks/prompt.js calls handle(); the direct run is for the tests and scripts/demo-lib.js synthetic-claude-prompt.
if (require.main === module) run(handle);
