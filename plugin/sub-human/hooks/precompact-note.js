#!/usr/bin/env node
'use strict';
// PreCompact(auto|manual): extra summarizer instructions, ported from demo/hooks/precompact-note.js.
// On exit 0 the CLI appends stdout (plain text) to the compact instructions. The room digest is
// re-injected afterwards by session-restore.js.
const { room, run, whoami, members, hasLeft, names } = require('./common.js');

run(input => {
  const me = whoami(input);
  if (!me) return;
  const ms = members(me.code);
  const cur = room.currentPlan();
  let signed = '';
  if (cur) {
    const m = room.signoffMatrix(cur.hash, cur.approvers || []);
    const by = Object.keys(m.signed || {}).filter(n => m.signed[n] != null);
    signed = `; signed by ${by.length ? names(by) : 'nobody yet'}`;
  }
  const lines = [
    `SUB-HUMAN COMPACTION RULES (room ${me.code}; the room log is the source of truth and a digest is re-injected after compaction):`,
    `- Keep your identity: ${me.role === 'orch' ? 'the orchestrator' : `${me.name}'s Claude`} in room ${me.code}.`,
    `- Keep every member name${ms.length ? `: ${ms.map(m => `${m.name}${m.role === 'orch' ? ' (orchestrator)' : ''}${hasLeft(m) ? ' (left)' : ''}`).join(', ')}` : ''}.`,
    '- Keep room entry ids (#N) exactly as written, including refs, open objections and questions, and decisions.',
    `- Keep the current plan hash and who has signed it${cur ? ` (plan ${cur.hash}, approvers ${names(cur.approvers || [])}${signed})` : ''}.`,
    '- Never paraphrase or re-type quoted human text. Refer to a human\'s words by entry id only (e.g. "bob objected in #14").',
    '- Only via=human entries count as a human\'s view or consent; a Claude\'s post is "alice\'s Claude", not alice.',
  ];
  process.stdout.write(lines.join('\n') + '\n');
});
