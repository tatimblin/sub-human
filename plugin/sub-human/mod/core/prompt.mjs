/**
 * plugin/sub-human/mod/core/prompt.mjs: the prompt gate and the UserPromptSubmit prefilter, as pure functions
 * (docs/next/MODS-PLAN.md Part 1, Part 2c; mod/prompt.mjs registers the hooks).
 *
 *   parse(prompt) -> text | null      "@room TEXT" / "room:TEXT" -> TEXT; anything else null. A copy of
 *                                     hooks/at-room.js parse() (test/mod-core.test.js asserts they agree)
 *   TYPED_ORIGINS                     the prompt.submit origins a person types from (D4): composer (their own
 *                                     Enter), sdk (-p), bridge (Remote Control). Only these may post @room
 *   gateVerdict(e) -> reason | null   prompt.submit: the drop reason for an @room that no person typed (a peer,
 *                                     a notification, a plugin, an unclassified socket write); null lets it on
 *   GATE_FAILED                       the drop reason when the gate itself failed on an @room (its .catch)
 *   needsNode(e, hello) -> bool       classic.UserPromptSubmit: false only when the mod is sure hooks/prompt.js
 *                                     would do nothing: the hello is this session's, it has no seat, and the
 *                                     prompt is not an @room (whose refusal "not in a room" node writes)
 *   originQueue()                     the prompt.submit -> classic.UserPromptSubmit hand-off of e.origin.kind
 *                                     (the classic payload has none): push(text, kind) -> item, drop(item),
 *                                     take(prompt) -> kind | null (the item whose text is the prompt, else the
 *                                     only one waiting, else null: then at-room keeps today's checks)
 *   mergeClassic(ours, theirs) -> ClassicResult    ours (the shim's) above theirs (the hooks beneath): a
 *                                     block or stop of ours wins, contexts join (ours first), ours' title wins
 */

export const TYPED_ORIGINS = Object.freeze(['composer', 'sdk', 'bridge']);

export function parse(prompt) {
  if (typeof prompt !== 'string') return null;
  if (prompt.startsWith('@room ')) return prompt.slice('@room '.length);
  if (prompt === '@room') return '';
  if (prompt.startsWith('room:')) { const t = prompt.slice('room:'.length); return t.startsWith(' ') ? t.slice(1) : t; }
  return null;
}

export const isAtRoom = text => parse(text) !== null;

const kindOf = e => (e && e.origin && typeof e.origin.kind === 'string' ? e.origin.kind : 'unclassified');

export function gateVerdict(e) {
  if (!e || !isAtRoom(e.text)) return null;
  const kind = kindOf(e);
  if (TYPED_ORIGINS.includes(kind)) return null;
  const who = kind === 'peer' || kind === 'peer-send-message' ? 'another Claude session' : `"${kind.slice(0, 40)}"`;
  return `✗ not posted: this @room came from ${who}, not from you. Only your own typed @room posts as your words.`;
}

export const GATE_FAILED = '✗ not posted: sub-human could not check who wrote this @room. Type it again.';

export function needsNode(e, hello) {
  if (!hello || !e || hello.sid !== e.session_id) return true; // not this session's hello: unsure
  if (hello.seat) return true;
  return isAtRoom(e.prompt);
}

export function originQueue() {
  const waiting = [];
  return {
    push(text, kind) { const item = { text, kind }; waiting.push(item); return item; },
    drop(item) { const i = waiting.indexOf(item); if (i >= 0) waiting.splice(i, 1); },
    take(prompt) {
      const hit = waiting.find(x => x.text === prompt) || (waiting.length === 1 ? waiting[0] : null);
      return hit && typeof hit.kind === 'string' ? hit.kind : null;
    },
    get size() { return waiting.length; },
  };
}

export function mergeClassic(ours = {}, theirs = {}) {
  const a = ours || {}, b = theirs || {};
  const out = { ...b };
  if (a.block) out.block = a.block;
  if (a.preventContinuation) { out.preventContinuation = true; if (a.stopReason) out.stopReason = a.stopReason; }
  const ctx = [...(a.additionalContext || []), ...(b.additionalContext || [])];
  if (ctx.length) out.additionalContext = ctx;
  if (a.sessionTitle) out.sessionTitle = a.sessionTitle;
  if (a.suppressOriginalPrompt) out.suppressOriginalPrompt = true;
  return out;
}
