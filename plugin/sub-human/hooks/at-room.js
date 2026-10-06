#!/usr/bin/env node
'use strict';
// UserPromptSubmit: "@room TEXT" or "room:TEXT" posts the human's exact words (via human) and ends the
// prompt, so no model turn runs and nothing is paraphrased.
//
// The payload has no `source` field (spike 3, P2), so we skip slash commands by prefix. Notes from
// the probes:
//   - the TUI trims trailing whitespace before the hook sees the prompt (documented, accepted);
//   - a long paste arrives wrapped as \n\n<pasted_content id="N">\n…\n</pasted_content id="N">\n;
//     we unwrap it and record normalized:true (pasted tabs already became 4 spaces upstream);
//   - suppressOriginalPrompt only works inside hookSpecificOutput.
//   - Rendering (2.1.281, fixes/D #9): success is continue:false + stopReason, which keeps the human's
//     "❯ @room …" row and adds one "Operation stopped by hook: ✓ posted to CODE as #N" line. The model
//     sees the prompt and that line on its next turn natively, so no "unseen own posts" note is needed.
//     Refusals stay decision:block + suppressOriginalPrompt, so refused or forged text never reaches it.
//
// Cross-session peer messages (native2/01 §2): UserPromptSubmit also fires for a message another session
// (or any same-user process) wrote to this session's socket, with no origin field, and the transcript
// entry (origin.kind "peer") is written only after the hook returns. So:
//   - a prompt carrying the <cross-session-message …> envelope or the "Another Claude session sent a
//     message" prefix is refused at once;
//   - every post is then checked after the fact: a detached checker (this file, --forgery-check) polls
//     transcript_path for this prompt_id and, if that entry came from a peer, appends a system `retract`
//     of #N ("peer-forged"). The tail settle (1.5 s) is longer than the check, so a forged line is not pushed.
//
// Drafted by Claude (fixes/B #11): when the posted text appears verbatim in the last assistant message
// (an accepted prompt suggestion, a copied draft), the entry carries drafted:"agent". It is still posted.
//
// For any other prompt from a joined member (including a task notification that wakes the session), the
// pull lane since the last turn is added as context: "Room since your last turn" (cursor ctx-NAME, ≤1.5k).
//
// Rows: a seat whose rows are not running (no live hold; e.g. its Claude skipped the restore prompt after
// --resume) gets the exact missing Agent calls again with every ordinary prompt or notice, until they run.
// A row spawned in the last minute (rows/<session>.json) may not hold yet, so it is never re-listed.
//
// The orch takes no typed input (decision 4): in the orch's session every prompt is refused with a hint,
// typed text and typed slash commands alike, except a peer delivery (the <cross-session-message envelope),
// a monitor notice (<task-notification>) and the launch `/sub-human` when it is the session's first prompt.
// Those still get the pull digest and the row calls below.
//
// Also: marks presence "working" and sets sessionTitle to the seat's address ("NAME.CODE", the name
// SendMessage / ListAgents use) on the first prompt of each session id; session-restore.js sets it on restore.
// Not for the orch, whose title is its launch name (-n orch.CODE).
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { room, identity, out, run, whoami, readState, writeState, clip, presence } = require('./common.js');
const rows = require(path.join(__dirname, '..', 'lib', 'rows.js'));

const PASTE = /(?:\n\n)?<pasted_content id="?(\w+)"?>\n([\s\S]*?)\n?<\/pasted_content id="?\1"?>\n?/g;

function parse(prompt) {
  if (prompt.startsWith('@room ')) return prompt.slice('@room '.length);
  if (prompt === '@room') return '';
  if (prompt.startsWith('room:')) { const t = prompt.slice('room:'.length); return t.startsWith(' ') ? t.slice(1) : t; }
  return null;
}

function unwrap(text) {
  let normalized = false;
  const t = text.replace(PASTE, (_, _id, body) => { normalized = true; return body; });
  return { text: t, normalized };
}

const block = (reason, extra = {}) => out({
  decision: 'block', reason,
  hookSpecificOutput: { hookEventName: 'UserPromptSubmit', suppressOriginalPrompt: true, ...extra },
});

const PEER_ENVELOPE = /<cross-session-message\b/;
const PEER_PREFIX = /^\s*Another Claude session sent a message/;
const TAIL_BYTES = 512 * 1024;

const isPeer = prompt => PEER_PREFIX.test(prompt) || PEER_ENVELOPE.test(prompt.slice(0, 2000));

/** The last TAIL_BYTES of a JSONL transcript as parsed entries (oldest first); [] when unreadable. */
function transcriptTail(file) {
  if (typeof file !== 'string' || !file) return [];
  let text;
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const size = fs.fstatSync(fd).size;
      const n = Math.min(size, TAIL_BYTES);
      const buf = Buffer.alloc(n);
      fs.readSync(fd, buf, 0, n, size - n);
      text = buf.toString('utf8');
    } finally { fs.closeSync(fd); }
  } catch { return []; }
  const es = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    try { es.push(JSON.parse(line)); } catch { /* the cut first line, or a torn last one */ }
  }
  return es;
}

const contentText = c => typeof c === 'string' ? c
  : Array.isArray(c) ? c.map(b => (b && b.type === 'text' && typeof b.text === 'string') ? b.text : '').join('\n') : '';

/**
 * This prompt's own user entries in the transcript: null while none is on disk yet, else 'peer' when one
 * came from another session (origin.kind "peer", or the receiver's envelope), else 'typed'.
 */
function promptOrigin(entries, promptId) {
  const mine = entries.filter(e => e && e.type === 'user' && e.promptId === promptId);
  if (!mine.length) return null;
  const peer = mine.some(e => (e.origin && e.origin.kind === 'peer') || isPeer(contentText(e.message && e.message.content)));
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

const squash = s => String(s).replace(/\s+/g, ' ').trim();
const DRAFT_MIN = 20; // shorter texts ("ok", "yes, ship it") show up in Claude's prose by chance

/** True when the posted text is Claude's wording: "@room TEXT" in its last message, or a longer TEXT verbatim. */
function draftedByAgent(text, assistant) {
  const t = squash(text), a = squash(assistant);
  if (!t || !a) return false;
  return a.includes('@room ' + t) || a.includes('room:' + t) || (t.length >= DRAFT_MIN && a.includes(t));
}

const CHECK_POLL_MS = 150;
const CHECK_WINDOW_MS = () => Number(process.env.SUB_HUMAN_FORGERY_MS) || 1200;

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

const PULL_CAP = 1500;
const PULL_HEAD = 'Room since your last turn (pull lane; full text: the room MCP tool read({ids})):';

/** "Room since your last turn": pull-lane entries after cursor ctx-NAME, newest kept under PULL_CAP; advances it. */
function pullDigest(me) {
  const key = `ctx-${me.name}`;
  let after = room.getCursor(key);
  const all = room.readAll();
  if (!after) {
    // First prompt of this seat: start at its join (the join block already carried the history).
    const joined = Date.parse(((identity.readMembers(me.code) || {})[me.name] || {}).joined_at || '');
    const before = Number.isFinite(joined) ? all.filter(e => Date.parse(e.at) < joined).at(-1) : null;
    after = before ? before.id : 0;
  }
  const last = all.length ? all[all.length - 1].id : 0;
  if (last > after) room.setCursor(key, last);
  const lines = all.filter(e => e.id > after && room.lane(me, e, all) === 'pull').map(e => room.line(e));
  if (!lines.length) return null;
  const kept = [];
  let size = PULL_HEAD.length;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (size + lines[i].length + 1 > PULL_CAP - 80) break;
    kept.unshift(lines[i]);
    size += lines[i].length + 1;
  }
  const dropped = lines.length - kept.length;
  const more = dropped ? [`(${dropped} earlier ${dropped === 1 ? 'entry' : 'entries'} not shown: \`sub-human read\` or read({ids}))`] : [];
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
    const proposal = require(path.join(__dirname, '..', 'lib', 'proposal.js'));
    const ps = proposal.pendingFor(me) || [];
    return ps.length ? ps.map(p => proposal.reminder(p, me.name)).join('\n') : null;
  } catch { return null; }
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
  if (/^\s*<cross-session-message\b/.test(prompt) || PEER_PREFIX.test(prompt)) return null;
  if (prompt.startsWith('<task-notification>')) return null;
  if (LAUNCH.test(prompt) && firstPrompt(input)) return null;
  return orchHint(me);
}

const SPAWN_GRACE_MS = 60 * 1000;

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
  const notification = prompt.startsWith('<task-notification>');
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
    const text = [pull, proposalReminders(me, notification), missingRowsText(me, input)].filter(Boolean).join('\n\n') || null;
    if (text || title) out({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', ...(text ? { additionalContext: clip(text) } : {}), ...top } });
    return;
  }

  if (isPeer(prompt)) {
    return block('✗ not posted: this prompt came from another Claude session, not from you. Only your own typed @room posts as your words.', top);
  }
  if (!me) return block('✗ not posted: this session is not in a room. Join one first with /sub-human NAME [CODE].');
  const { text, normalized } = unwrap(raw);
  if (!text.trim()) return block('✗ not posted: there is nothing after @room.', top);
  const entry = { kind: 'say', text };
  if (normalized) entry.normalized = true;
  if (draftedByAgent(text, lastAssistantText(transcriptTail(input.transcript_path), input.prompt_id))) entry.drafted = 'agent';
  const e = room.append(entry, { via: 'human', from: me.name });
  spawnForgeryCheck(me, input, e.id);
  out({
    continue: false,
    stopReason: `✓ posted to ${me.code} as #${e.id}${normalized ? ' (pasted text unwrapped)' : ''}${entry.drafted ? " (Claude's wording)" : ''}`,
    hookSpecificOutput: { hookEventName: 'UserPromptSubmit', ...top },
  });
});
