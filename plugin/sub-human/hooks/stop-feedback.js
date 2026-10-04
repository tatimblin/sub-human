#!/usr/bin/env node
'use strict';
// Stop (members with pending_review): log a "Tell Claude what to change" decline as an objection.
// That decline fires no tool hook (spike 3, P5); the feedback exists only in the transcript as the
// ExitPlanMode tool_result: is_error:true, "…To tell you how to proceed, the user said:\n<text>\n\nNote: …"
// (the transcript line also carries userFeedback). We read the transcript tail backwards for the
// tool_result of the pending review's tool_use_id. A plain Esc decline leaves a rejection with no
// feedback: pending_review is cleared and nothing is logged. Never blocks the stop.
const fs = require('node:fs');
const { room, run, whoami, readPending, clearPending } = require('./common.js');

const TAIL_BYTES = 512 * 1024;
const SAID = 'the user said:\n';

function tailLines(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - TAIL_BYTES);
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    const lines = buf.toString('utf8').split('\n');
    if (start > 0) lines.shift(); // partial first line
    return lines;
  } finally { fs.closeSync(fd); }
}

const resultText = c => typeof c === 'string' ? c
  : Array.isArray(c) ? c.map(x => (x && typeof x.text === 'string') ? x.text : '').join('') : '';

/** Find the last rejected ExitPlanMode tool_result: {tool_use_id, feedback|null} or null. */
function findDecline(lines, wantId) {
  const exitIds = new Set();
  for (const l of lines) {
    if (!l.includes('"ExitPlanMode"')) continue;
    try {
      const d = JSON.parse(l);
      for (const c of (d.message && Array.isArray(d.message.content) ? d.message.content : [])) {
        if (c && c.type === 'tool_use' && c.name === 'ExitPlanMode') exitIds.add(c.id);
      }
    } catch { /* skip */ }
  }
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i];
    if (!l.includes('tool_result')) continue;
    let d;
    try { d = JSON.parse(l); } catch { continue; }
    const content = d.message && Array.isArray(d.message.content) ? d.message.content : [];
    for (const c of content) {
      if (!c || c.type !== 'tool_result' || c.is_error !== true) continue;
      if (wantId ? c.tool_use_id !== wantId : !exitIds.has(c.tool_use_id)) continue;
      const t = resultText(c.content);
      let feedback = typeof d.userFeedback === 'string' && d.userFeedback ? d.userFeedback : null;
      if (!feedback) {
        const at = t.indexOf(SAID);
        if (at >= 0) {
          const rest = t.slice(at + SAID.length);
          const end = rest.indexOf('\n\nNote:');
          feedback = end >= 0 ? rest.slice(0, end) : rest;
        }
      }
      return { tool_use_id: c.tool_use_id, feedback };
    }
  }
  return null;
}

run(input => {
  const me = whoami(input);
  if (!me || me.role === 'orch') return;
  const pending = readPending(me);
  if (!pending || !pending.hash) return;
  const tp = input.transcript_path;
  if (typeof tp !== 'string' || !tp) return;
  let lines;
  try { lines = tailLines(tp); } catch { return; }
  const hit = findDecline(lines, pending.tool_use_id || null);
  if (!hit) return;
  clearPending(me);
  if (!hit.feedback || !hit.feedback.trim()) return; // Esc: no sign-off, nothing to log
  room.append({ kind: 'objection', text: hit.feedback, plan_hash: pending.hash }, { via: 'human', from: me.name });
}, () => { /* never block or fail the stop */ });
