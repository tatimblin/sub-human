/**
 * plugin/sub-human/mod/core/prompt.mjs: the prompt gate and the UserPromptSubmit prefilter, as pure functions
 * (mod/prompt.mjs registers the hooks). In: a prompt.submit event, or a classic UserPromptSubmit payload plus the
 * hello. Out: a drop reason, whether node must run, the session title, the merged classic result.
 * Failure: closed for an @room, and an @claude in a room (GATE_FAILED, failClosed): either let through would reach the model as the
 * person's words. Anything else unsure runs node.
 */

/** The prompt.submit origins a person types from: composer (their own Enter), sdk (-p), bridge (the person typing
 * through Remote Control). Only these may post @room. */
export const TYPED_ORIGINS = Object.freeze(['composer', 'sdk', 'bridge']);

/** "@room TEXT" -> TEXT; anything else null. A copy of hooks/at-room.js parse() (test/mod-core.test.js
 * asserts they agree). */
export function parse(prompt) {
  if (typeof prompt !== 'string') return null;
  if (prompt.startsWith('@room ')) return prompt.slice('@room '.length);
  if (prompt === '@room') return '';
  return null;
}

export const isAtRoom = text => parse(text) !== null;

/** "@claude TEXT" -> TEXT; anything else null. A copy of hooks/at-room.js parseClaude() (test/mod-core.test.js
 * asserts they agree). In a room it posts like @room and wakes the room's Claude; outside one it is a plain prompt. */
export function parseClaude(prompt) {
  if (typeof prompt !== 'string') return null;
  if (prompt.startsWith('@claude ')) return prompt.slice('@claude '.length);
  if (prompt === '@claude') return '';
  return null;
}

export const isAtClaude = text => parseClaude(text) !== null;

/** A prompt that posts as the person's words: an @room, or an @claude in a seated session (hello.seat). */
export const posts = (text, hello) => isAtRoom(text) || (isAtClaude(text) && !!(hello && hello.seat));

const kindOf = e => (e && e.origin && typeof e.origin.kind === 'string' ? e.origin.kind : 'unclassified');

/** prompt.submit: the drop reason for an @room (or, in a room, an @claude) no person typed (a peer, a notification,
 * a plugin, an unclassified socket write); null lets it on. hello: the session's, for whether it is seated. */
export function gateVerdict(e, hello) {
  if (!e || !posts(e.text, hello)) return null;
  const kind = kindOf(e);
  if (TYPED_ORIGINS.includes(kind)) return null;
  const tag = isAtRoom(e.text) ? '@room' : '@claude';
  const who = kind === 'peer' || kind === 'peer-send-message' ? 'another Claude session' : `"${kind.slice(0, 40)}"`;
  return `✗ not posted: this ${tag} came from ${who}, not from you. Only your own typed ${tag} posts as your words.`;
}

/** Where the person types from, by a typed prompt's origin: bridge (Remote Control, e.g. a phone) true; composer or
 * sdk (this terminal, -p) false; any other origin says nothing (undefined). */
export function onRemote(origin) {
  const kind = origin && origin.kind;
  if (kind === 'bridge') return true;
  return kind === 'composer' || kind === 'sdk' ? false : undefined;
}

/** The refusal when nobody could check who wrote an @room: at-room's NO_ORIGIN words, since the person does the same
 * thing either way (types it again). */
export const GATE_FAILED = '✗ not posted: sub-human could not check who wrote this @room. Type it again.';

export const failClosed = (prompt, hello) => (posts(prompt, hello)
  ? { block: isAtRoom(prompt) ? GATE_FAILED : GATE_FAILED.replace('@room', '@claude'), suppressOriginalPrompt: true } : null);

/** The shim did not handle the prompt: any exit but 0 (answered) or 2 (blocked). */
export const shimFailed = run => !run || (run.exitCode !== 0 && run.exitCode !== 2);

/**
 * classic.UserPromptSubmit: false only when the mod is sure hooks/prompt.js would do nothing it needs: the hello is
 * this session's, the prompt is not an @room (node signs the post or writes the refusal), and either the session has
 * no seat, or its seat is a member's (the room Claude's refusal of typed input is node's), the tail child delivers for it
 * (the digest, notices and row calls are the child's) and consent said no review is open.
 */
export function needsNode(e, hello, { delivering = false, reviewFlag } = {}) {
  if (!hello || !e || hello.sid !== e.session_id) return true; // not this session's hello: unsure
  if (posts(e.prompt, hello)) return true;
  if (!hello.seat) return false;
  return hello.seat.role === 'claude' || !delivering || reviewFlag !== false;
}

/** The session title (members; the room's Claude keeps its launch name), once per {sid, addr}: a /clear or a room switch
 * titles again. */
export function titleFor(hello, sid, titled) {
  if (!hello || !hello.seat || hello.seat.role === 'claude' || typeof sid !== 'string' || hello.sid !== sid) return null;
  const addr = hello.seat.addr;
  return titled && typeof titled === 'object' && titled.sid === sid && titled.addr === addr ? null : addr;
}

/** The mod writes "working" presence for a typed prompt of a member or an unknown seat, unless the last presence it
 * wrote or saw was "working". */
export function writesWorking(origin, hello, last) {
  if (!origin || !TYPED_ORIGINS.includes(origin.kind) || last === 'working') return false;
  return !hello || (!!hello.seat && hello.seat.role !== 'claude');
}

/** What the shim hands at-room as sub_human_origin: origin.kind, and "plugin:<name>" for a plugin (the mod's own
 * wakes are "plugin:sub-human"). */
export function originKind(origin) {
  if (!origin || typeof origin.kind !== 'string') return undefined;
  return origin.kind === 'plugin' && typeof origin.name === 'string' && origin.name ? `plugin:${origin.name}` : origin.kind;
}

/** The prompt.submit -> classic.UserPromptSubmit hand-off of e.origin.kind (the classic payload has none). take()
 * matches only the item whose text is the prompt: any other could be another prompt's origin, so at-room refuses. */
export function originQueue() {
  const waiting = [];
  return {
    push(text, kind) { const item = { text, kind }; waiting.push(item); return item; },
    drop(item) { const i = waiting.indexOf(item); if (i >= 0) waiting.splice(i, 1); },
    take(prompt) {
      const hit = waiting.find(x => x.text === prompt);
      return hit && typeof hit.kind === 'string' ? hit.kind : null;
    },
    get size() { return waiting.length; },
  };
}

/** Ours (the shim's) above theirs (the hooks beneath): a block or stop of ours wins, contexts join (ours first), our
 * title wins. */
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
