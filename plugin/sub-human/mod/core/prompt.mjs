/**
 * plugin/sub-human/mod/core/prompt.mjs: the prompt gate and the UserPromptSubmit prefilter, as pure functions
 * (mod/prompt.mjs registers the hooks).
 *
 *   parse(prompt) -> text | null      "@room TEXT" / "room:TEXT" -> TEXT; anything else null. A copy of
 *                                     hooks/at-room.js parse() (test/mod-core.test.js asserts they agree)
 *   TYPED_ORIGINS                     the prompt.submit origins a person types from: composer (their own Enter),
 *                                     sdk (-p), bridge (the person typing through Remote Control). Only these
 *                                     may post @room
 *   gateVerdict(e) -> reason | null   prompt.submit: the drop reason for an @room that no person typed (a peer,
 *                                     a notification, a plugin, an unclassified socket write); null lets it on
 *   GATE_FAILED                       the refusal when nobody could check who wrote an @room; the same words as
 *                                     at-room's NO_ORIGIN, since the person does the same thing: types it again
 *   failClosed(prompt) -> result | null    the classic result refusing an @room the shim could not handle (an
 *                                     @room let through would reach the model as the person's words); null else
 *   shimFailed(run) -> bool           the shim did not handle the prompt: any exit but 0 (answered) or 2 (blocked)
 *   needsNode(e, hello, {delivering, reviewFlag}?) -> bool
 *                                     classic.UserPromptSubmit: false only when the mod is sure hooks/prompt.js
 *                                     would do nothing it needs: the hello is this session's, the prompt is not an
 *                                     @room (node signs the post, or writes the refusal), and either the session
 *                                     has no seat, or its seat is a member's (never the orch's: its refusal of
 *                                     typed input is node's), the mod's tail child delivers for it (the digest,
 *                                     notices and row calls are the child's) and consent said no review is open
 *   titleFor(hello, sid, titled) -> addr | null    the session title (members; the orch keeps its launch name),
 *                                     once per {sid, addr}: a /clear or a room switch titles again
 *   writesWorking(origin, hello, last) -> bool     the mod writes "working" presence: a typed prompt of a member
 *                                     or an unknown seat, unless the last presence it wrote or saw was "working"
 *   originKind(origin) -> kind        what the shim hands at-room as sub_human_origin: origin.kind, and for a
 *                                     plugin "plugin:<name>" (the mod's own wakes are "plugin:sub-human")
 *   originQueue()                     the prompt.submit -> classic.UserPromptSubmit hand-off of e.origin.kind
 *                                     (the classic payload has none): push(text, kind) -> item, drop(item),
 *                                     take(prompt) -> kind | null (only the item whose text is the prompt: any
 *                                     other could be another prompt's origin; at-room then refuses an @room)
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

export const failClosed = prompt => (isAtRoom(prompt) ? { block: GATE_FAILED, suppressOriginalPrompt: true } : null);

export const shimFailed = run => !run || (run.exitCode !== 0 && run.exitCode !== 2);

export function needsNode(e, hello, { delivering = false, reviewFlag } = {}) {
  if (!hello || !e || hello.sid !== e.session_id) return true; // not this session's hello: unsure
  if (isAtRoom(e.prompt)) return true;
  if (!hello.seat) return false;
  return hello.seat.role === 'orch' || !delivering || reviewFlag !== false;
}

export function titleFor(hello, sid, titled) {
  if (!hello || !hello.seat || hello.seat.role === 'orch' || typeof sid !== 'string' || hello.sid !== sid) return null;
  const addr = hello.seat.addr;
  return titled && typeof titled === 'object' && titled.sid === sid && titled.addr === addr ? null : addr;
}

export function writesWorking(origin, hello, last) {
  if (!origin || !TYPED_ORIGINS.includes(origin.kind) || last === 'working') return false;
  return !hello || (!!hello.seat && hello.seat.role !== 'orch');
}

export function originKind(origin) {
  if (!origin || typeof origin.kind !== 'string') return undefined;
  return origin.kind === 'plugin' && typeof origin.name === 'string' && origin.name ? `plugin:${origin.name}` : origin.kind;
}

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
