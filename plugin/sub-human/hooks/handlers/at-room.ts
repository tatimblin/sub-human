// plugin/sub-human/hooks/handlers/at-room.ts: UserPromptSubmit: "@room TEXT" posts the human's exact words (via human, signed with the seat key)
// and ends the prompt, so no model turn runs and nothing is paraphrased. "@claude TEXT" is an ordinary prompt to the
// person's own Claude (the room's session reads nothing). Only a leading tag counts: a tag later in the text is just words. No hooks.json entry: hooks/handlers/prompt.ts runs
// handle(input) under mod/prompt.ts's shim. In: the payload plus `sub_human_origin` and `sub_human_nonce`. An origin
// counts only with this session's lease nonce, and only a typed one (composer, sdk, bridge; cc CONTRACT
// prompt-origin-composer) may post: anything that can run node can claim an origin, only a lease reader the nonce.
// Out: continue:false + "✓ sent" (the person's row stays, the model sees it next turn); a refusal of the person's own
// typed words (no seat, nothing after the tag, the room refused it) is a stop too, with the reason (refuse); decision:
// block + suppressOriginalPrompt only where the text must never reach the model as the person's (no or another origin;
// in the room's Claude a typed prompt is a stop with its hint, which the model reads as a refusal). Failure: no origin, a bad nonce or no seat
// refuses, and the person types it again. In the room's session, a typed prompt is refused (it takes no typed input);
// with no origin it runs, so a reload never loses its rows turn. It writes no presence: the module is its one writer
// (mod/prompt.ts, through hooks/handlers/presence.ts).
// A post the store refuses (RATE, AUTH, OFFLINE with the outbox full or the link over for good) blocks the prompt with
// the reason. In a room hosted elsewhere whose link is down, the daemon queues the signed post instead
// (lib/remote/outbox.ts) and "⧗ queued" ends the prompt; it is sent, in order, when the link is back. With no daemon
// running (killed, crashed), the mirror store queues it itself and starts the daemon: "⧗ queued; restarting the link". A post sent
// over a slow link that the host has not answered in time is "⧗ sending (slow link)" (kept under its nonce: the late
// copy is the post), and a deadline whose outcome is unknown is "⧗ not confirmed", never "not posted".
import * as identity from '../../lib/identity.ts';
import * as room from '../../lib/room.ts';
import { oneLine } from '../../lib/text.ts';
import * as config from '../../lib/config.ts';
import * as cc from '../../lib/cc/transcript.ts';
import * as seatKey from '../seat-key.ts';
import { whoami } from '../seat.ts';
import { out } from '../reply.ts';
import type { HookSpecificOutput, PromptIn } from '../types.ts';
import type { Identity } from '../../lib/identity.ts';
import type { TranscriptEntry } from '../../lib/cc/transcript.ts';
// how a prompt is read is the module's (mod/core): one parser, one list of typed origins, one wording per refusal
import { parse, unwrapLead, TYPED_ORIGINS, NO_ORIGIN, NOT_IN_ROOM } from '../../mod/core/prompt.ts';
import { attested as leaseAttests } from '../../mod/core/state.ts';

// it signs the person's own words (via=human): the seat-key signer, in this process only (hooks/seat-key.ts)
seatKey.arm();

const block = (reason: string, extra: Partial<HookSpecificOutput> = {}) => out({
  decision: 'block', reason,
  hookSpecificOutput: { hookEventName: 'UserPromptSubmit', suppressOriginalPrompt: true, ...extra },
});

/** A refusal of the person's own typed words, to type again (no seat, nothing after the tag, the room refused or the
 * outcome is unknown): a stop with the reason, as "✓ sent" is (cc CONTRACT ups-stop-frame; mod/prompt.ts draws its
 * warning row as the reason alone). A block would draw "UserPromptSubmit operation blocked by hook:" and put the
 * prompt back in the input, where refusals piled up and a later Enter sent them all. block stays for a prompt whose
 * words must not reach the model as the person's (no or another origin). */
const refuse = (reason: string) => out({ continue: false, stopReason: reason, hookSpecificOutput: { hookEventName: 'UserPromptSubmit' } });

const TAIL_BYTES = config.TRANSCRIPT_TAIL_BYTES;
/** The last TAIL_BYTES of a JSONL transcript as parsed entries (oldest first); [] when unreadable. */
const transcriptTail = (file: string | undefined): TranscriptEntry[] => cc.readEntries(file, { tailBytes: TAIL_BYTES });
const contentText = cc.contentText;

/** The text of the last assistant turn before this prompt (all its text blocks), or ''. */
function lastAssistantText(entries: TranscriptEntry[], promptId: string | undefined): string {
  const parts: string[] = [];
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (!e || e.isSidechain) continue;
    if (e.type === 'assistant') { parts.unshift(contentText(e.message && e.message.content)); continue; }
    if (e.type !== 'user' || (promptId && e.promptId === promptId)) continue;
    const c = e.message && e.message.content;
    const toolResult = Array.isArray(c) && c.length && c.every((b: { type?: unknown } | null) => b && b.type === 'tool_result');
    if (!toolResult && !e.isMeta && parts.length) break; // the human prompt that started that turn
  }
  return parts.join('\n');
}

const DRAFT_MIN = 20; // shorter texts ("ok", "yes, ship it") show up in Claude's prose by chance

/** True when the posted text is Claude's wording: "@room TEXT" in its last message, or a longer TEXT verbatim. */
function draftedByAgent(text: string, assistant: string): boolean {
  const t = oneLine(text), a = oneLine(assistant);
  if (!t || !a) return false;
  return a.includes('@room ' + t) || (t.length >= DRAFT_MIN && a.includes(t));
}

/** draftedByAgent over the transcript's last assistant turn; false when the transcript gives no readable assistant text
 * (none, unreadable, a shape these readers do not know): the person's words post alone, never blocked by the read. */
function drafted(text: string, input: PromptIn): boolean {
  try { return draftedByAgent(text, lastAssistantText(transcriptTail(input.transcript_path), input.prompt_id)); } catch { return false; }
}

// ---------- the room's session takes no typed input ----------
const LAUNCH = /^\/(?:sub-human:)?sub-human(?:\s|$)/;
const roomClaudeHint = (me: Identity) => `✗ the room's session (${identity.address(me.name, me.code)}) takes no typed input; type in your own session: @room for the room, or ask your own Claude`;

/** True when no earlier prompt of this session is in its transcript (a fresh session has none, or no file). */
function firstPrompt(input: PromptIn): boolean {
  const es = transcriptTail(input.transcript_path);
  return !es.some(e => e && e.type === 'user' && !e.isMeta && e.promptId && e.promptId !== input.prompt_id && !e.isSidechain);
}

/** For a room Claude session: null when the prompt may run (anything not typed, the launch command), else the refusal. */
function roomClaudeRefusal(me: Identity, input: PromptIn, prompt: string, origin: string | null): string | null {
  if (origin === null || !TYPED_ORIGINS.includes(origin)) return null;
  return LAUNCH.test(prompt) && firstPrompt(input) ? null : roomClaudeHint(me);
}

/** True when the input carries this session's module nonce (its lease's): the origin beside it is the module's. */
function attested(input: PromptIn): boolean {
  const sid = input.session_id;
  if (typeof sid !== 'string' || typeof input.sub_human_nonce !== 'string') return false;
  return leaseAttests(identity.readModLease(sid), sid, input.sub_human_nonce);
}

/** The UserPromptSubmit handler: writes its one output (if any) through hooks/reply.ts out(). hooks/handlers/prompt.ts
 * calls it. */
function handle(input: PromptIn): void {
  const prompt = typeof input.prompt === 'string' ? input.prompt : '';
  // The origin the shim says the prompt came from (prompt.submit e.origin.kind), or null; it posts only attested.
  const claimed = typeof input.sub_human_origin === 'string' ? input.sub_human_origin : null;
  const raw = prompt.startsWith('/') ? null : parse(prompt);
  const me = whoami(input);
  if (me && me.role === 'claude') { // the origin unchecked: a forged one here only refuses more
    const refusal = roomClaudeRefusal(me, input, prompt, claimed);
    // a stop, as members' refusals are (item 13): no "UserPromptSubmit operation blocked by hook:" frame, nothing put
    // back in the input; the hint is the stop's reason, which the room's Claude reads too (it acts on nothing typed)
    if (refusal) return refuse(refusal);
  }
  if (raw === null) return;

  // not in a room first: typing it again would not help there
  if (!me) return refuse(NOT_IN_ROOM);
  const origin = claimed !== null && attested(input) ? claimed : null;
  if (origin === null) return block(NO_ORIGIN);
  if (!TYPED_ORIGINS.includes(origin)) {
    return block(`✗ not posted: this prompt wasn't typed by you (it came from "${origin.slice(0, 40)}"). Only your own typed @room posts as your words.`);
  }
  // A long paste arrives wrapped in <pasted_content>: post the person's text, marked normalized.
  const { text, normalized: inner } = cc.unwrapPasted(raw);
  const normalized = inner || unwrapLead(prompt).unwrapped; // a paste that started the prompt held the tag
  if (!text.trim()) return refuse('✗ not posted: there is nothing after @room.');
  const entry: { kind: 'say'; text: string; normalized?: true; drafted?: 'agent' } = { kind: 'say', text };
  if (normalized) entry.normalized = true;
  if (drafted(text, input)) entry.drafted = 'agent';
  let placed;
  try { placed = room.open(me.code).append(entry, { via: 'human', from: me.name, queue: true }); } catch (err) {
    if (!(err instanceof room.RoomError)) throw err;
    // it went out but no answer came in time: it may still land, so never "not posted" (typing it again would post twice)
    if (err.unknown) return refuse(`⧗ not confirmed: ${err.message}. Watch the room for it before you type it again.`);
    return refuse(`✗ not posted: ${err.message}`); // OFFLINE (the outbox full, the link over for good), RATE, AUTH
  }
  if (placed && placed.slow) { // sent, the host slow to answer: the daemon holds it under its nonce until it does
    const q = `⧗ sending (slow connection): room ${me.code} hasn't confirmed this post yet; it shows in the room once the host has it. No need to type it again`;
    return out({ continue: false, stopReason: q, hookSpecificOutput: { hookEventName: 'UserPromptSubmit' } });
  }
  if (placed && placed.queued) { // a room hosted elsewhere, its link down: the daemon holds it (lib/remote/outbox.ts)
    const q = placed.restarting // no daemon was running: the post is queued here and the daemon started again
      ? `⧗ queued; restarting the link: room ${me.code}'s connection wasn't running, so it is starting again; this post goes out once it's back (${placed.queued} waiting)`
      : `⧗ queued: room ${me.code} is offline; this post goes out when the connection is back (${placed.queued} waiting)`;
    return out({ continue: false, stopReason: q, hookSpecificOutput: { hookEventName: 'UserPromptSubmit' } });
  }
  // it names who reads it, so under the stop's frame (cc CONTRACT ups-stop-frame) it reads as done, not as an error
  const sent = `✓ sent to room ${me.code} (Claude wasn't asked)${normalized ? ' (pasted text unwrapped)' : ''}${entry.drafted ? " (Claude's wording)" : ''}`;
  out({ continue: false, stopReason: sent, hookSpecificOutput: { hookEventName: 'UserPromptSubmit' } });
}

// hooks/handlers/prompt.ts calls handle(); `hooks/run.ts at-room` is for the tests and scripts/demo-lib.ts
// synthetic-claude-prompt.
export { handle };
