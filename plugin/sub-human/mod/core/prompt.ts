/**
 * plugin/sub-human/mod/core/prompt.ts: the prompt gate and the UserPromptSubmit prefilter, as pure functions
 * (mod/prompt.ts registers the hooks). In: a prompt.submit event, or a classic UserPromptSubmit payload plus the
 * hello. Out: a drop reason, whether node must run, the session title, the merged classic result, and an @room
 * receipt's row without Claude Code's "Operation stopped by hook: " frame (receiptBook).
 * Failure: closed for an @room, and an @claude in a room (GATE_FAILED, failClosed): either let through would reach the model as the
 * person's words. Anything else unsure runs node.
 * The tag parsers, TYPED_ORIGINS and the refusal wordings are owned here: hooks/handlers/at-room.ts imports them, so the
 * module and node read a prompt the same way.
 */
import type { Hello, OriginLike, RunOutput, ShimResult } from './types.ts';

/** A prompt.submit event as the gate reads it. */
type SubmitLike = { text?: unknown; origin?: OriginLike } | null | undefined;
/** A hello, or anything with a seat field (the gate only asks whether there is a seat). */
type SeatedLike = Pick<Hello, 'seat'> | { seat?: unknown } | null | undefined;

/** The prompt.submit origins a person types from: composer (their own Enter), sdk (-p), bridge (the person typing
 * through Remote Control). Only these may post @room. */
export const TYPED_ORIGINS: readonly string[] = Object.freeze(['composer', 'sdk', 'bridge']);

/** "@room TEXT" -> TEXT; anything else null (hooks/handlers/at-room.ts posts TEXT). */
export function parse(prompt: unknown): string | null {
  if (typeof prompt !== 'string') return null;
  return tagged(prompt, /^@room(?=\s|$)/);
}

/** The text after a leading tag: the tag, then one whitespace character (a space, or the newline Ctrl+J
 * puts after it), dropped, or nothing. */
export function tagged(prompt: string, tag: RegExp): string | null {
  const m = tag.exec(prompt);
  if (!m) return null;
  return prompt.slice(m[0].length).replace(/^\s/, '');
}

export const isAtRoom = (text: unknown) => parse(text) !== null;

/** "@claude TEXT" -> TEXT; anything else null. In a room it posts like @room and wakes the room's Claude; outside one
 * it is a plain prompt. */
export function parseClaude(prompt: unknown): string | null {
  if (typeof prompt !== 'string') return null;
  return tagged(prompt, /^@claude(?=\s|$)/);
}

export const isAtClaude = (text: unknown) => parseClaude(text) !== null;

/** A prompt that posts as the person's words: an @room, or an @claude in a seated session (hello.seat). */
export const posts = (text: unknown, hello: SeatedLike) => isAtRoom(text) || (isAtClaude(text) && !!(hello && hello.seat));

const kindOf = (e: SubmitLike): string => (e && e.origin && typeof e.origin.kind === 'string' ? e.origin.kind : 'unclassified');

/** prompt.submit: the drop reason for an @room (or, in a room, an @claude) no person typed (a peer, a notification,
 * a plugin, an unclassified socket write); null lets it on. hello: the session's, for whether it is seated. */
export function gateVerdict(e: SubmitLike, hello: SeatedLike): string | null {
  if (!e || !posts(e.text, hello)) return null;
  const kind = kindOf(e);
  if (TYPED_ORIGINS.includes(kind)) return null;
  const tag = isAtRoom(e.text) ? '@room' : '@claude';
  const who = kind === 'peer' || kind === 'peer-send-message' ? 'another Claude session' : `"${kind.slice(0, 40)}"`;
  return `✗ not posted: this ${tag} came from ${who}, not from you. Only your own typed ${tag} posts as your words.`;
}

/** Where the person types from, by a typed prompt's origin: bridge (Remote Control, e.g. a phone) true; composer or
 * sdk (this terminal, -p) false; any other origin says nothing (undefined). */
export function onRemote(origin: OriginLike | null | undefined): boolean | undefined {
  const kind = origin && origin.kind;
  if (kind === 'bridge') return true;
  return kind === 'composer' || kind === 'sdk' ? false : undefined;
}

/** The refusal when nobody could check who wrote an @room, here or in at-room (no origin, or one without the nonce): the
 * person does the same thing either way (types it again). */
export const GATE_FAILED = '✗ not posted: sub-human could not check who wrote this @room. Type it again.';
/** at-room's name for it. */
export const NO_ORIGIN = GATE_FAILED;
/** An @room typed in a session with no seat (at-room, and the module when it is sure there is none). */
export const NOT_IN_ROOM = '✗ not posted: this session isn\'t in a room. Join one first: /sub-human';

/** An @room in a session whose hello is this session's and has no seat: at-room's refusal, given without a node start
 * (at-room would say the same: there is no seat to sign it with). null otherwise. */
export const unseatedRefusal = (e: { session_id?: unknown; prompt?: unknown } | null | undefined, hello: Hello | null | undefined): ShimResult | null => (
  e && hello && hello.sid === e.session_id && !hello.seat && isAtRoom(e.prompt) ? { block: NOT_IN_ROOM, suppressOriginalPrompt: true } : null);

export const failClosed = (prompt: unknown, hello?: SeatedLike): ShimResult | null => (posts(prompt, hello)
  ? { block: isAtRoom(prompt) ? GATE_FAILED : GATE_FAILED.replace('@room', '@claude'), suppressOriginalPrompt: true } : null);

/** The shim did not handle the prompt: any exit but 0 (answered) or 2 (blocked). */
export const shimFailed = (run: RunOutput | null | undefined) => !run || (run.exitCode !== 0 && run.exitCode !== 2);

/**
 * classic.UserPromptSubmit: false only when the mod is sure hooks/handlers/prompt.ts would do nothing it needs: the hello is
 * this session's, the prompt is not an @room (node signs the post or writes the refusal), and either the session has
 * no seat, or its seat is a member's (the room Claude's refusal of typed input is node's), the tail child delivers for it
 * (the digest, notices and row calls are the child's) and consent said no review is open.
 */
export function needsNode(
  e: { session_id?: unknown; prompt?: unknown } | null | undefined, hello: Hello | null | undefined,
  { delivering = false, reviewFlag }: { delivering?: boolean; reviewFlag?: unknown } = {},
): boolean {
  if (!hello || !e || hello.sid !== e.session_id) return true; // not this session's hello: unsure
  if (posts(e.prompt, hello)) return true;
  if (!hello.seat) return false;
  return hello.seat.role === 'claude' || !delivering || reviewFlag !== false;
}

/** The session title (members; the room's Claude keeps its launch name), once per {sid, addr}: a /clear or a room switch
 * titles again. */
export function titleFor(hello: Hello | null | undefined, sid: unknown, titled: unknown): string | null {
  if (!hello || !hello.seat || hello.seat.role === 'claude' || typeof sid !== 'string' || hello.sid !== sid) return null;
  const addr = hello.seat.addr;
  const t = titled && typeof titled === 'object' ? titled as { sid?: unknown; addr?: unknown } : null;
  return t && t.sid === sid && t.addr === addr ? null : addr;
}

/** The mod writes "working" presence for a typed prompt of a member or an unknown seat, unless the last presence it
 * wrote or saw was "working". */
export function writesWorking(origin: OriginLike | null | undefined, hello: Hello | null | undefined, last: unknown): boolean {
  if (!origin || !TYPED_ORIGINS.includes(String(origin.kind)) || last === 'working') return false;
  return !hello || (!!hello.seat && hello.seat.role !== 'claude');
}

/** What the shim hands at-room as sub_human_origin: origin.kind, and "plugin:<name>" for a plugin (the mod's own
 * wakes are "plugin:sub-human"). */
export function originKind(origin: OriginLike | null | undefined): string | undefined {
  if (!origin || typeof origin.kind !== 'string') return undefined;
  return origin.kind === 'plugin' && typeof origin.name === 'string' && origin.name ? `plugin:${origin.name}` : origin.kind;
}

/** The prompt.submit -> classic.UserPromptSubmit hand-off of e.origin.kind (the classic payload has none). take()
 * matches only the item whose text is the prompt: any other could be another prompt's origin, so at-room refuses. */
export function originQueue() {
  const waiting: { text: unknown; kind: unknown }[] = [];
  return {
    push(text: unknown, kind: unknown) { const item = { text, kind }; waiting.push(item); return item; },
    drop(item: { text: unknown; kind: unknown }) { const i = waiting.indexOf(item); if (i >= 0) waiting.splice(i, 1); },
    take(prompt: unknown): string | null {
      const hit = waiting.find(x => x.text === prompt);
      return hit && typeof hit.kind === 'string' ? hit.kind : null;
    },
    get size() { return waiting.length; },
  };
}

/** Ours (the shim's) above theirs (the hooks beneath): a block or stop of ours wins, contexts join (ours first), our
 * title wins. */
export function mergeClassic(ours: ShimResult | null = {}, theirs: ShimResult | null | undefined = {}): ShimResult {
  const a = ours || {}, b = theirs || {};
  const out: ShimResult = { ...b };
  if (a.block) out.block = a.block;
  if (a.preventContinuation) { out.preventContinuation = true; if (a.stopReason) out.stopReason = a.stopReason; }
  const ctx = [...(a.additionalContext || []), ...(b.additionalContext || [])];
  if (ctx.length) out.additionalContext = ctx;
  if (a.sessionTitle) out.sessionTitle = a.sessionTitle;
  if (a.suppressOriginalPrompt) out.suppressOriginalPrompt = true;
  return out;
}

/** How Claude Code draws a UserPromptSubmit stop: a warning row "Operation stopped by hook: <stopReason>" (cc
 * CONTRACT ups-stop-frame). An @room's receipt ("✓ sent", "⧗ queued: …") is such a stop. */
export const STOP_FRAME = 'Operation stopped by hook: ';

/** A row as session.append hands it, as far as receiptBook reads it. */
type RowLike = { type?: unknown; content?: unknown };

/**
 * The receipts this module's prompt hook stopped a prompt with, waiting for their warning row (session.append, door
 * notice). expect(reason) as the stop leaves the hook; rewrite(row) answers that row with the frame cut off, the
 * receipt alone (cc CONTRACT session-append-notice-rewrite), or null for any other row. Only a system row that is
 * exactly the frame around a waiting receipt is ours: another plugin's stop, a second copy, or a row after a reload
 * keeps the engine's words. A receipt whose row never came (a block beneath won) is forgotten after `max` more.
 */
export function receiptBook(max = 8) {
  const waiting: string[] = [];
  return {
    expect(reason: unknown) {
      if (typeof reason !== 'string' || !reason) return;
      waiting.push(reason);
      if (waiting.length > max) waiting.shift();
    },
    rewrite<M extends RowLike>(row: M | null | undefined): M | null {
      if (!row || row.type !== 'system' || !Array.isArray(row.content) || row.content.length !== 1) return null;
      const block = row.content[0] as { type?: unknown; text?: unknown } | null;
      if (!block || block.type !== 'text' || typeof block.text !== 'string' || !block.text.startsWith(STOP_FRAME)) return null;
      const i = waiting.indexOf(block.text.slice(STOP_FRAME.length));
      if (i < 0) return null;
      const [reason] = waiting.splice(i, 1);
      return { ...row, content: [{ type: 'text', text: reason }] };
    },
    get size() { return waiting.length; },
  };
}
