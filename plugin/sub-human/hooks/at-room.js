#!/usr/bin/env node
'use strict';
// UserPromptSubmit: "@room TEXT" or "room:TEXT" posts the human's exact words (via human) and ends the
// prompt, so no model turn runs and nothing is paraphrased. hooks/prompt.js runs handle(input) (with consent.js's
// prompt handler, in one process); mod/prompt.mjs runs that through the classic.UserPromptSubmit shim, which is
// the only way this hook runs (no hooks.json entry).
//
// Who wrote the prompt: the shim adds `sub_human_origin`, the engine's origin kind for the prompt (prompt.submit
// e.origin; cc CONTRACT prompt-origin-composer): only composer (the person's own Enter), sdk (-p) and bridge
// (Remote Control) may post. The mod's prompt.submit gate drops any other @room before this hook runs; this hook
// refuses it again, and refuses an @room with no origin at all (the hand-off lost to a reload): the person types
// it again. Notes from the probes:
//   - the TUI trims trailing whitespace before the hook sees the prompt (documented, accepted);
//   - a long paste arrives wrapped as \n\n<pasted_content id="N">\n…\n</pasted_content id="N">\n;
//     we unwrap it (cc.unwrapPasted) and record normalized:true (pasted tabs already became 4 spaces upstream);
//   - suppressOriginalPrompt only works inside hookSpecificOutput.
//   - Rendering (docs/archive/fixes/D-hook-rendering.md #9): success is continue:false + stopReason, which keeps
//     the human's "❯ @room …" row and adds one "Operation stopped by hook: ✓ sent" line (no entry id: people
//     never see ids). The model sees the prompt and that line on its next turn natively, so no "unseen own
//     posts" note is needed. Refusals stay decision:block + suppressOriginalPrompt, so refused or forged text
//     never reaches it.
//
// The post is signed with the seat's key (hooks/seat-key.js, armed by common.js): only a hook can write
// via=human, and readers mark an unsigned via=human line "(unverified)".
//
// Drafted by Claude (docs/archive/fixes/B-model-behavior.md #11): when the posted text appears verbatim in the
// last assistant message (an accepted prompt suggestion, a copied draft), the entry carries drafted:"agent".
// It is still posted.
//
// Everything else a prompt used to carry (the "Room since your last turn" digest, reminders, missing row calls,
// join / leave lines) is the hooks module's tail child's now (lib/tail.js events pull, rows, chat), and the
// session title is set by mod/prompt.mjs.
//
// The orch takes no typed input (nobody sits at its terminal; people reach it through @room): in the orch's
// session a typed prompt (origin composer, sdk, bridge) is refused with a hint, unless it is the launch
// `/sub-human` as the session's first prompt. Anything else (a peer, the mod's own wake "plugin:sub-human") runs.
// With no origin (a lost hand-off) the prompt runs: the orch's wakes must not be lost to a reload.
//
// Also: marks presence "working".
const path = require('node:path');
const { room, out, run, whoami, presence } = require('./common.js');
const { oneLine } = require(path.join(__dirname, '..', 'lib', 'text.js'));
const config = require(path.join(__dirname, '..', 'lib', 'config.js'));
const cc = require(path.join(__dirname, '..', 'lib', 'cc.js'));

function parse(prompt) {
  if (prompt.startsWith('@room ')) return prompt.slice('@room '.length);
  if (prompt === '@room') return '';
  if (prompt.startsWith('room:')) { const t = prompt.slice('room:'.length); return t.startsWith(' ') ? t.slice(1) : t; }
  return null;
}

const block = (reason, extra = {}) => out({
  decision: 'block', reason,
  hookSpecificOutput: { hookEventName: 'UserPromptSubmit', suppressOriginalPrompt: true, ...extra },
});

const TAIL_BYTES = config.TRANSCRIPT_TAIL_BYTES;
/** The last TAIL_BYTES of a JSONL transcript as parsed entries (oldest first); [] when unreadable. */
const transcriptTail = file => cc.readEntries(file, { tailBytes: TAIL_BYTES });
const contentText = cc.contentText;

/** prompt.submit origins a person types from (mod/core/prompt.mjs TYPED_ORIGINS; D4 adds Remote Control's bridge). */
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

/** True when the posted text is Claude's wording: "@room TEXT" in its last message, or a longer TEXT verbatim. */
function draftedByAgent(text, assistant) {
  const t = oneLine(text), a = oneLine(assistant);
  if (!t || !a) return false;
  return a.includes('@room ' + t) || a.includes('room:' + t) || (t.length >= DRAFT_MIN && a.includes(t));
}

/** The seat's address, "alice.vole-8126": the session title that SendMessage and ListAgents address. */
const address = me => me.address || `${me.name}.${me.code}`;

// ---------- the orch takes no typed input ----------
const LAUNCH = /^\/(?:sub-human:)?sub-human(?:\s|$)/;
const orchHint = me => `the orch takes no typed input; use @room or ask your Claude to message ${address(me)}`;

/** True when no earlier prompt of this session is in its transcript (a fresh session has none, or no file). */
function firstPrompt(input) {
  const es = transcriptTail(input.transcript_path);
  return !es.some(e => e && e.type === 'user' && !e.isMeta && e.promptId && e.promptId !== input.prompt_id && !e.isSidechain);
}

/** For an orch session: null when the prompt may run (anything not typed, the launch command), else the refusal. */
function orchRefusal(me, input, prompt, origin) {
  if (origin === null || !TYPED_ORIGINS.has(origin)) return null;
  return LAUNCH.test(prompt) && firstPrompt(input) ? null : orchHint(me);
}

const NO_ORIGIN = '✗ not posted: sub-human could not check who wrote this @room. Type it again.';

/** The UserPromptSubmit handler: writes its one output (if any) through common.js out(). hooks/prompt.js calls it. */
function handle(input) {
  const prompt = typeof input.prompt === 'string' ? input.prompt : '';
  // The mod's attested origin (prompt.submit e.origin.kind, through the classic.UserPromptSubmit shim), or null.
  const origin = typeof input.sub_human_origin === 'string' ? input.sub_human_origin : null;
  const raw = prompt.startsWith('/') ? null : parse(prompt);
  const me = whoami(input);
  if (me && me.role === 'orch') {
    const refusal = orchRefusal(me, input, prompt, origin);
    if (refusal) return block(refusal);
  }
  if (me) presence(me, 'working');
  if (raw === null) return;

  if (origin === null) return block(NO_ORIGIN);
  if (!TYPED_ORIGINS.has(origin)) {
    return block(`✗ not posted: this prompt was not typed by you (origin "${origin.slice(0, 40)}"). Only your own typed @room posts as your words.`);
  }
  if (!me) return block('✗ not posted: this session is not in a room. Join one first with /sub-human NAME [CODE].');
  const { text, normalized } = cc.unwrapPasted(raw);
  if (!text.trim()) return block('✗ not posted: there is nothing after @room.');
  const entry = { kind: 'say', text };
  if (normalized) entry.normalized = true;
  if (draftedByAgent(text, lastAssistantText(transcriptTail(input.transcript_path), input.prompt_id))) entry.drafted = 'agent';
  room.open(me.code).append(entry, { via: 'human', from: me.name });
  out({
    continue: false,
    stopReason: `✓ sent${normalized ? ' (pasted text unwrapped)' : ''}${entry.drafted ? " (Claude's wording)" : ''}`,
    hookSpecificOutput: { hookEventName: 'UserPromptSubmit' },
  });
}

module.exports = { handle, parse, TYPED_ORIGINS };

if (require.main === module) run(handle);
