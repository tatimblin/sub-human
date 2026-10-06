#!/usr/bin/env node
'use strict';
// UserPromptSubmit: "@room TEXT" or "room:TEXT" posts the human's exact words (via human) and ends the
// prompt, so no model turn runs and nothing is paraphrased.
//
// Who wrote the prompt: `source` (docs/internals/cc-2.1.281.md §8) is "user" for the interactive composer and
// "sdk" for -p; "system" (peer / channel messages, task notifications), the wakeups and "poll_event" are
// machine-injected and never post. Payloads may still omit it while the field rolls out (older builds had
// none: docs/archive/spike-results-3.md, P2), so slash commands are skipped by prefix. Notes from the probes:
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
// Cross-session peer messages (docs/archive/native2/01-session-messaging.md §2): UserPromptSubmit also fires
// for a message another session (or any same-user process) wrote to this session's socket. So:
//   - a prompt with source "system" + the envelope or the "Another Claude session sent a message" prefix
//     (cc.isPeerPrompt), or with any machine source, is refused at once;
//   - with no `source` in the payload, the transcript entry (origin.kind "peer") is written only after the
//     hook returns, so the post is written provisional:true and checked after the fact: a detached checker
//     (this file, --forgery-check) polls transcript_path for this prompt_id and, if that entry came from a
//     peer (cc.entryIsPeer), appends a system `retract` of #N ("peer-forged"). Until store.PROVISIONAL_MS has
//     passed, a provisional post stays out of the pull digest below and the compaction digest, and the tail
//     holds it as well (room.isYoungProvisional), so a forged line is never delivered before its retract. When the transcript
//     never shows the prompt inside the window, the post stands (fail-open, by design: a slow disk must not
//     eat a person's words).
//
// Drafted by Claude (docs/archive/fixes/B-model-behavior.md #11): when the posted text appears verbatim in the
// last assistant message (an accepted prompt suggestion, a copied draft), the entry carries drafted:"agent".
// It is still posted.
//
// For any other prompt from a joined member (including a task notification that wakes the session), the
// pull lane since the last turn is added as context: "Room since your last turn", group-chat lines with no
// ids (room.chatLines; cursor ctx-NAME, ≤1.5k). It reads room.readView({after: cursor}), never the whole log.
//
// Rows: a seat whose rows are not running (no live hold; e.g. its Claude skipped the restore prompt after
// --resume) gets the exact missing Agent calls again with every ordinary prompt or notice, until they run.
// A row spawned in the last minute (rows/<session>.json) may not hold yet, so it is never re-listed.
//
// The orch takes no typed input (nobody sits at its terminal; people reach it through @room): in the orch's
// session every prompt is refused with a hint, typed text and typed slash commands alike, except a peer
// delivery (the <cross-session-message envelope), a monitor notice (<task-notification>) and the launch
// `/sub-human` when it is the session's first prompt. Those still get the pull digest and the row calls below.
//
// Join / leave lines (lib/notices.js): another member's join, or settled leave, that the room monitor did not
// print for this member yet ("bob joined", "bob left"; e.g. the monitor was not running) goes out on a typed
// prompt as `systemMessage` (shown to the human, not sent to the model). Never on a monitor notice: that
// notice carries its own lines. Cursor notice-NAME.
//
// Also: marks presence "working" and sets sessionTitle to the seat's address ("NAME.CODE", the name
// SendMessage / ListAgents use) on the first prompt of each session id; session-restore.js sets it on restore.
// Not for the orch, whose title is its launch name (-n orch.CODE).
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { room, identity, out, run, logError, whoami, readState, writeState, clip, presence } = require('./common.js');
const rows = require(path.join(__dirname, '..', 'lib', 'rows.js'));
const notices = require(path.join(__dirname, '..', 'lib', 'notices.js'));
const proposal = require(path.join(__dirname, '..', 'lib', 'proposal.js'));
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

/** Sources a person types from (the composer, -p). Absent: an older payload, checked after the fact. */
const TYPED_SOURCES = new Set(['user', 'sdk']);
const hasSource = input => input.source !== undefined && input.source !== null;

/**
 * This prompt's own user entries in the transcript: null while none is on disk yet, else 'peer' when one
 * came from another session (origin.kind "peer", or the receiver's envelope), else 'typed'.
 */
function promptOrigin(entries, promptId) {
  const mine = entries.filter(e => e && e.type === 'user' && e.promptId === promptId);
  if (!mine.length) return null;
  const peer = mine.some(cc.entryIsPeer);
  return peer ? 'peer' : 'typed';
}

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

const CHECK_POLL_MS = config.FORGERY_POLL_MS;
const CHECK_WINDOW_MS = () => config.envMs('SUB_HUMAN_FORGERY_MS', config.FORGERY_WINDOW_MS);

/** Start the after-the-fact origin check for post #id in a detached process; the hook does not wait. */
function spawnForgeryCheck(me, input, id) {
  if (!input.prompt_id || typeof input.transcript_path !== 'string' || !input.transcript_path) return;
  const job = { code: me.code, name: me.name, id, transcript: input.transcript_path, prompt_id: input.prompt_id };
  try {
    spawn(process.execPath, [__filename, '--forgery-check', JSON.stringify(job)], { detached: true, stdio: 'ignore' }).unref();
  } catch { /* best-effort: the envelope check above still ran */ }
}

/** The checker: poll the transcript until this prompt's entry shows up, then retract #id if a peer wrote it. */
function forgeryCheck(job) {
  room.bind(job.code);
  const deadline = Date.now() + CHECK_WINDOW_MS();
  const tick = () => {
    const origin = promptOrigin(transcriptTail(job.transcript), job.prompt_id);
    if (origin === 'peer') {
      room.append({ kind: 'retract', text: `peer-forged: #${job.id} came from another Claude session, not from ${job.name}`, refs: [job.id] },
        { via: 'system', from: job.name, system: true });
      return;
    }
    if (origin === null && Date.now() < deadline) setTimeout(tick, CHECK_POLL_MS);
  };
  setTimeout(tick, CHECK_POLL_MS);
}

/** Join / leave notice lines for me that no notification showed yet, or null; advances cursor notice-NAME. */
function noticeLines(me) {
  if (me.role === 'orch') return null;
  const key = `notice-${me.name}`;
  let after = room.getCursor(key);
  // joins and leaves are non-chat entries, so the view (no chat before the cursor) holds every one of them
  const all = room.readView({ after: after || Infinity });
  if (!after) { const j = all.filter(e => e.kind === 'member_joined' && e.from === me.name).at(-1); after = j ? j.id : 0; }
  const ns = notices.joinLeave(all, me.name).filter(n => n.id > after);
  const waiting = ns.filter(n => !n.settled); // a leave inside its settle window: decide on a later prompt
  const last = room.lastId();
  const upTo = waiting.length ? Math.min(...waiting.map(n => n.id)) - 1 : last;
  if (upTo > after) room.setCursor(key, upTo);
  const seen = notices.shown(me.code, me.name);
  const show = ns.filter(n => n.settled && !seen.has(n.id));
  if (!show.length) return null;
  notices.markShown(me.code, me.name, show.map(n => n.id), 'prompt');
  return show.map(n => notices.text(n)).join('\n');
}

const PULL_CAP = config.PULL_CAP;
const PULL_HEAD = 'Room since your last turn (context for you, not for the user: mention it only if they ask):';

/** "Room since your last turn": pull-lane entries after cursor ctx-NAME, newest kept under PULL_CAP; advances it. */
function pullDigest(me) {
  const key = `ctx-${me.name}`;
  let after = room.getCursor(key);
  const all = after ? room.readView({ after }) : room.readAll(); // the whole log only on a seat's first prompt
  if (!after) {
    // First prompt of this seat: start at its join (the join block already carried the history).
    const joined = Date.parse(((identity.readMembers(me.code) || {})[me.name] || {}).joined_at || '');
    const before = Number.isFinite(joined) ? all.filter(e => Date.parse(e.at) < joined).at(-1) : null;
    after = before ? before.id : 0;
  }
  const last = all.length ? all[all.length - 1].id : 0;
  if (last > after) room.setCursor(key, last);
  // A provisional post still inside its origin check is never shown. (A person's post is push or none for every
  // viewer, so it reaches others through the tail, which settles longer; this keeps the digest safe regardless.)
  const now = Date.now();
  const lines = all.filter(e => e.id > after && !room.isYoungProvisional(e, now) && room.lane(me, e, all) === 'pull')
    .map(e => room.chatLines(e, { viewer: me.name }).join('\n'));
  if (!lines.length) return null;
  const kept = [];
  let size = PULL_HEAD.length;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (size + lines[i].length + 1 > PULL_CAP - 80) break;
    kept.unshift(lines[i]);
    size += lines[i].length + 1;
  }
  const dropped = lines.length - kept.length;
  const more = dropped ? [`(${dropped} earlier ${dropped === 1 ? 'entry' : 'entries'} not shown: \`sub-human read\` or the room read tool)`] : [];
  return [PULL_HEAD, ...more, ...kept].join('\n');
}

/** The seat's address, "alice.vole-8126": the session title that SendMessage and ListAgents address. */
const address = me => me.address || `${me.name}.${me.code}`;

/** sessionTitle once per session id (stored per member); never for the orch (its title is -n orch.CODE). */
function titleFor(me, input) {
  if (!input.session_id || me.role === 'orch') return null;
  const t = readState(me, 'title');
  if (t && t.session_id === input.session_id) return null;
  writeState(me, 'title', { session_id: input.session_id });
  return address(me);
}

/**
 * lib/proposal.js reminder() for each proposal that names this member and awaits their answer (the digest's
 * "proposal P awaits your answer"); null for the orch, on a monitor notice (its push line just said it), or none.
 */
function proposalReminders(me, notification) {
  if (me.role === 'orch' || notification) return null;
  try {
    const ps = proposal.pendingFor(me, room.readView({ after: Infinity })) || [];
    return ps.length ? ps.map(p => proposal.reminder(p, me.name)).join('\n') : null;
  } catch (e) { logError(e, 'at-room reminders'); return null; }
}

// ---------- the orch takes no typed input ----------
const LAUNCH = /^\/(?:sub-human:)?sub-human(?:\s|$)/;
const orchHint = me => `the orch takes no typed input; use @room or ask your Claude to message ${address(me)}`;

/** True when no earlier prompt of this session is in its transcript (a fresh session has none, or no file). */
function firstPrompt(input) {
  const es = transcriptTail(input.transcript_path);
  return !es.some(e => e && e.type === 'user' && !e.isMeta && e.promptId && e.promptId !== input.prompt_id && !e.isSidechain);
}

/** For an orch session: null when the prompt may run (peer delivery, monitor notice, launch command), else the refusal. */
function orchRefusal(me, input, prompt) {
  if (/^\s*<cross-session-message\b/.test(prompt) || cc.PEER_PREFIX.test(prompt)) return null;
  if (cc.isTaskNotification(prompt)) return null;
  if (LAUNCH.test(prompt) && firstPrompt(input)) return null;
  return orchHint(me);
}

const SPAWN_GRACE_MS = config.ROW_SPAWN_GRACE_MS;

/** The Agent calls for this seat's rows with no live hold, or null when they all run (or were just spawned). */
function missingRowsText(me, input) {
  try {
    const members = identity.readMembers(me.code);
    // orch: missingRows skips members who joined under 45 s ago (their member_joined notice covers them)
    let need = me.role === 'orch' ? rows.missingRows(me.code, me, { members })
      : rows.rowsNeeded(me.code, me, { members, held: rows.readHolds(me.code, me.name) });
    let map = {};
    try { map = (JSON.parse(fs.readFileSync(rows.mapFile(me.code, input.session_id), 'utf8')) || {}).byAgent || {}; } catch { /* none */ }
    const fresh = new Set(Object.values(map).filter(r => r && Date.now() - Date.parse(r.at) < SPAWN_GRACE_MS).map(r => r.name));
    need = need.filter(n => !fresh.has(n));
    if (!need.length) return null;
    return `SUB-HUMAN ROWS: your ${me.role === 'orch' ? `rows for ${need.join(', ')} are` : 'room row is'} not running in this session. `
      + 'Make the call below first, in the same message as anything else you do, exactly as written.\n'
      + rows.rowCalls(me, members, { only: need });
  } catch { return null; }
}

if (process.argv[2] === '--forgery-check') {
  forgeryCheck(JSON.parse(process.argv[3]));
} else run(input => {
  const prompt = typeof input.prompt === 'string' ? input.prompt : '';
  const notification = cc.isTaskNotification(prompt);
  const slash = prompt.startsWith('/');
  const raw = notification || slash ? null : parse(prompt);
  const me = whoami(input);
  if (me && me.role === 'orch') {
    const refusal = orchRefusal(me, input, prompt);
    if (refusal) return block(refusal);
  }
  if (me) presence(me, 'working');
  const title = me ? titleFor(me, input) : null;
  const top = title ? { sessionTitle: title } : {};

  if (raw === null) {
    if (!me || slash) { if (title) out({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', ...top } }); return; }
    let pull = null;
    try { pull = pullDigest(me); } catch { /* best-effort */ }
    let notice = null;
    try { if (!notification) notice = noticeLines(me); } catch { /* best-effort */ }
    const text = [pull, proposalReminders(me, notification), missingRowsText(me, input)].filter(Boolean).join('\n\n') || null;
    if (text || title || notice) {
      out({ ...(notice ? { systemMessage: notice } : {}), hookSpecificOutput: { hookEventName: 'UserPromptSubmit', ...(text ? { additionalContext: clip(text) } : {}), ...top } });
    }
    return;
  }

  // With no source field, cc.isPeerPrompt falls back to the text check (envelope or prefix).
  if (cc.isPeerPrompt(input)) {
    return block('✗ not posted: this prompt came from another Claude session, not from you. Only your own typed @room posts as your words.', top);
  }
  if (hasSource(input) && !TYPED_SOURCES.has(input.source)) {
    return block(`✗ not posted: this prompt was not typed by you (source "${String(input.source).slice(0, 40)}"). Only your own typed @room posts as your words.`, top);
  }
  if (!me) return block('✗ not posted: this session is not in a room. Join one first with /sub-human NAME [CODE].');
  const { text, normalized } = cc.unwrapPasted(raw);
  if (!text.trim()) return block('✗ not posted: there is nothing after @room.', top);
  const entry = { kind: 'say', text };
  if (normalized) entry.normalized = true;
  if (draftedByAgent(text, lastAssistantText(transcriptTail(input.transcript_path), input.prompt_id))) entry.drafted = 'agent';
  // A typed source is known now; without one the post is provisional until the transcript check has run.
  const check = !hasSource(input);
  const e = room.append(entry, { via: 'human', from: me.name, provisional: check });
  if (check) spawnForgeryCheck(me, input, e.id);
  out({
    continue: false,
    stopReason: `✓ sent${normalized ? ' (pasted text unwrapped)' : ''}${entry.drafted ? " (Claude's wording)" : ''}`,
    hookSpecificOutput: { hookEventName: 'UserPromptSubmit', ...top },
  });
});
