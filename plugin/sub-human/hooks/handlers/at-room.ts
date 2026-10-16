// plugin/sub-human/hooks/handlers/at-room.ts: UserPromptSubmit: "@room TEXT" posts the human's exact words (via human, signed with the seat key)
// and ends the prompt, so no model turn runs and nothing is paraphrased. "@claude TEXT" posts the same way with
// to=claude, which wakes the room's Claude; outside a room it is an ordinary prompt and passes through untouched.
// Only a leading tag counts: "@room @claude TEXT" is a plain post, and a tag later in the text is just words. No hooks.json entry: hooks/handlers/prompt.ts runs
// handle(input) under mod/prompt.ts's shim. In: the payload plus `sub_human_origin` and `sub_human_nonce`. An origin
// counts only with this session's lease nonce, and only a typed one (composer, sdk, bridge; cc CONTRACT
// prompt-origin-composer) may post: anything that can run node can claim an origin, only a lease reader the nonce.
// Out: continue:false + "✓ sent" (the person's row stays, the model sees it next turn), or decision:block +
// suppressOriginalPrompt (refused text never reaches the model). Failure: no origin, a bad nonce or no seat
// refuses, and the person types it again. In the room's Claude, a typed prompt is refused (it takes no typed input); with
// no origin it runs, so a reload never loses the room Claude's wakes. It writes no presence: the module is its one writer
// (mod/prompt.ts, through hooks/handlers/presence.ts).
// A post the store refuses (RATE, AUTH, or OFFLINE in a room hosted elsewhere whose link daemon is gone) blocks the
// prompt with the reason. In a room hosted elsewhere whose link is down, the daemon queues the signed post instead
// (lib/remote/outbox.ts) and "⧗ queued" ends the prompt; it is sent, in order, when the link is back. A post sent
// over a slow link that the host has not answered in time is "⧗ sending (slow link)" (kept under its nonce: the late
// copy is the post), and a deadline whose outcome is unknown is "⧗ not confirmed", never "not posted". Typed through Remote Control (origin bridge), a refusal is also the
// systemMessage, which the module relays to the phone (a block line does not show there); "✓ sent" is not (the phone
// shows the person's own row, and a relay costs a model turn).
import * as identity from '../../lib/identity.ts';
import * as room from '../../lib/room.ts';
import { oneLine } from '../../lib/text.ts';
import * as config from '../../lib/config.ts';
import * as cc from '../../lib/cc.ts';
import * as seats from '../../lib/seats.ts';
import * as seatKey from '../seat-key.ts';
import { whoami } from '../seat.ts';
import { out } from '../reply.ts';
import type { HookSpecificOutput, PromptIn } from '../types.ts';
import type { Identity } from '../../lib/identity.ts';
import type { TranscriptEntry } from '../../lib/cc.ts';
// how a prompt is read is the module's (mod/core): one parser, one list of typed origins, one wording per refusal
import { parse, parseClaude, TYPED_ORIGINS, NO_ORIGIN, NOT_IN_ROOM } from '../../mod/core/prompt.ts';
import { attested as leaseAttests } from '../../mod/core/state.ts';

// it signs the person's own words (via=human): the seat-key signer, in this process only (hooks/seat-key.ts)
seatKey.arm();

/** A person typing through Remote Control sees no block line there: a refusal also goes out as systemMessage, which
 * mod/prompt.ts relays to the phone (mod/deliver.ts relay). "✓ sent" stays a stop line only. */
let toPhone = false;
const phoneNote = (text: string) => (toPhone ? { systemMessage: `sub-human: ${text}` } : {});

const block = (reason: string, extra: Partial<HookSpecificOutput> = {}) => out({
  decision: 'block', reason, ...phoneNote(reason),
  hookSpecificOutput: { hookEventName: 'UserPromptSubmit', suppressOriginalPrompt: true, ...extra },
});

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

/** True when the posted text is Claude's wording: "@room TEXT" or "@claude TEXT" in its last message, or a longer
 * TEXT verbatim. */
function draftedByAgent(text: string, assistant: string): boolean {
  const t = oneLine(text), a = oneLine(assistant);
  if (!t || !a) return false;
  return a.includes('@room ' + t) || a.includes('@claude ' + t) || (t.length >= DRAFT_MIN && a.includes(t));
}

// ---------- the room's Claude takes no typed input ----------
const LAUNCH = /^\/(?:sub-human:)?sub-human(?:\s|$)/;
const roomClaudeHint = (me: Identity) => `the room's Claude takes no typed input; type @claude in your own session, or ask your Claude to message ${identity.address(me.name, me.code)}`;

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
  toPhone = claimed === 'bridge';
  const raw = prompt.startsWith('/') ? null : parse(prompt);
  const wake = raw === null && !prompt.startsWith('/') ? parseClaude(prompt) : null;
  const tag = wake !== null ? '@claude' : '@room';
  const me = whoami(input);
  if (me && me.role === 'claude') { // the origin unchecked: a forged one here only refuses more
    const refusal = roomClaudeRefusal(me, input, prompt, claimed);
    if (refusal) return block(refusal);
  }
  if (raw === null && (wake === null || !me)) return; // outside a room, @claude is an ordinary prompt

  // not in a room first: typing it again would not help there
  if (!me) return block(NOT_IN_ROOM);
  const origin = claimed !== null && attested(input) ? claimed : null;
  if (origin === null) return block(NO_ORIGIN.replace('@room', tag));
  if (!TYPED_ORIGINS.includes(origin)) {
    return block(`✗ not posted: this prompt wasn't typed by you (it came from "${origin.slice(0, 40)}"). Only your own typed ${tag} posts as your words.`);
  }
  // A long paste arrives wrapped in <pasted_content>: post the person's text, marked normalized.
  const { text, normalized } = cc.unwrapPasted(raw !== null ? raw : wake);
  if (!text.trim()) return block(`✗ not posted: there is nothing after ${tag}.`);
  const entry: { kind: 'say'; text: string; to?: string; normalized?: true; drafted?: 'agent' } = { kind: 'say', text };
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
    const q = `⧗ sending (slow connection): room ${me.code} hasn't confirmed this post yet; it shows in the room once the host has it. No need to type it again`;
    return out({ continue: false, stopReason: q, ...phoneNote(q), hookSpecificOutput: { hookEventName: 'UserPromptSubmit' } });
  }
  if (placed && placed.queued) { // a room hosted elsewhere, its link down: the daemon holds it (lib/remote/outbox.ts)
    const q = `⧗ queued: room ${me.code} is offline; this post goes out when the connection is back (${placed.queued} waiting)`;
    return out({ continue: false, stopReason: q, ...phoneNote(q), hookSpecificOutput: { hookEventName: 'UserPromptSubmit' } });
  }
  // @claude on the host with no room's Claude running (it stopped, or never bound): start it, as a rejoin would
  const start = wake !== null ? seats.ensureRoomClaude(me.code, input.cwd, me.name) : '';
  // it names who reads it, so under the stop's frame (cc CONTRACT ups-stop-frame) it reads as done, not as an error
  const head = wake !== null ? "✓ sent; the room's Claude will answer" : `✓ sent to room ${me.code} (Claude wasn't asked)`;
  const sent = `${head}${normalized ? ' (pasted text unwrapped)' : ''}${entry.drafted ? " (Claude's wording)" : ''}${start}`;
  out({ continue: false, stopReason: sent, hookSpecificOutput: { hookEventName: 'UserPromptSubmit' } });
}

// hooks/handlers/prompt.ts calls handle(); `hooks/run.ts at-room` is for the tests and scripts/demo-lib.js
// synthetic-claude-prompt.
export { handle };
