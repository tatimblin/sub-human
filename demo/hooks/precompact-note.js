#!/usr/bin/env node
'use strict';
// PreCompact(auto|manual): extra summarizer instructions. On exit 0 the CLI appends stdout (plain
// text) to the compact instructions. In 2.1.281 the CLI drops these instructions for compactions
// inside a subagent, so this only shapes the orchestrator's summary.
const { room, run, readRoster } = require('./common.js');

run(() => {
  const roster = Object.values(readRoster()).filter(r => r && r.human);
  const plan = room.currentPlan();
  const lines = [
    'ROOM COMPACTION RULES (the room log is the source of truth; a digest is re-injected after compaction):',
    '- Keep every seat\'s human name and agent_id' + (roster.length ? `: ${roster.map(r => `${r.human}=${r.agent_id || '?'}${r.live ? '' : ' (stopped)'}`).join(', ')}` : '') + '.',
    '- Keep room entry ids (#N) exactly as written, including ids cited as refs, open objections and questions, and decisions.',
    `- Keep the current plan path and plan hash${plan ? ` (${plan.path} plan=${plan.hash})` : ''} and who has signed it.`,
    '- Never paraphrase or re-type quoted human text. Refer to a human\'s words by entry id only (e.g. "bob objected in #14").',
    '- Only via=human entries count as a human\'s view or consent; a seat\'s post is "alice\'s Claude", not alice.',
  ];
  process.stdout.write(lines.join('\n') + '\n');
});
