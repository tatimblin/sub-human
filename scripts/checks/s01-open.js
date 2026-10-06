'use strict';
// S1: alice joins, no room open: the room is created and the headless orch spawned
const fs = require('node:fs');
const path = require('node:path');
const { panelRows } = require('../lib/panes.js');

module.exports = {
  scene: 'S1',
  run(x, { det }, T) {
    const { code, roomDir, members, job, orchSid } = x;
    const ms = x.st('S1', 1, 'members.json', members);
    det('Room created: log, members.json with alice (member) and the orch (job id)', fs.existsSync(path.join(roomDir, 'log.jsonl')) && ms.alice && ms.alice.role === 'member' && ms.orch && ms.orch.job,
      `${roomDir}: alice ${ms.alice ? ms.alice.role : 'missing'}, orch job ${ms.orch ? ms.orch.job : 'missing'}`);
    const ag = x.st('S1', 1, 'agents.json', []);
    const a = ag.find(r => r.id === job || r.sessionId === orchSid);
    det(`The orch is a background job titled orch.${code} (claude agents --json), not a tmux seat`, a && a.kind === 'background' && a.name === `orch.${code}`,
      a ? `id ${a.id} kind ${a.kind} name ${a.name} state ${a.state} cwd ${a.cwd}` : `no agent with id ${job} in state/S1/1/agents.json`);
    const oc = x.cap('S1', 'orch') || '';
    det('The orch bound itself as orch of the room (agent sub-human:orchestrator, pid, session id)', ms.orch && ms.orch.role === 'orch' && ms.orch.pid && ms.orch.session_id && /@sub-human:orchestrator/.test(oc),
      `members.json orch role=${ms.orch && ms.orch.role} pid=${ms.orch && ms.orch.pid}; "${(/UserPromptExpansion says: [^\n]*/.exec(oc) || ['no join line'])[0]}" in ${x.capName('S1', 'orch')} (claude logs ${job})`);
    const rcpt = /sub-human: opened room ([a-z]+-\d{4}) as alice · others: \/sub-human NAME/.exec(x.cap('S1', 'alice') || '');
    det('alice\'s join line: "opened room CODE as alice · others: /sub-human NAME"', rcpt && rcpt[1] === code, rcpt ? rcpt[0] : `not in ${x.capName('S1', 'alice')}`);
    const ar = panelRows(x.cap('S1', 'alice'));
    det(`alice's panel: one ${code} row`, ar.filter(r => !r.nested).length === 1 && ar[0].label === code, ar.map(r => r.line).join(' | ') || 'no rows');
    const orr = panelRows(oc);
    const holds = x.st('S1', 1, 'holds-orch.json', {});
    det('The orch\'s panel lists alice', orr.some(r => r.label === 'alice') && (holds.members || []).includes('alice'),
      `orch rows: ${orr.map(r => r.line).join(' | ') || 'none'}; rows/holds-orch.json members ${JSON.stringify(holds.members || [])}`);
    const t1 = x.nativeTasks('S1', 1).find(t => t.id === '1');
    det(`Room task #1 "room ${code} open" on the orch's native list (in_progress, owner room)`, t1 && t1.subject === `room ${code} open` && t1.status === 'in_progress' && t1.owner === 'room',
      t1 ? `~/.claude/tasks/sh-${code}/1.json: "${t1.subject}" ${t1.status} owner ${t1.owner}` : 'no 1.json in the S1 copy of the native list');
    const j = x.entries('alice').filter(e => e.attachment && e.attachment.type === 'hook_additional_context' && e.attachment.hookEvent === 'UserPromptExpansion').map(e => [].concat(e.attachment.content).join('\n'))[0] || '';
    const fillLen = j.split('\n\nROWS\n')[0].length;
    det(`Member join block small: text ≤ ${T.joinText} chars, with ROWS ≤ ${T.joinBlock.toLocaleString('en-US')}`, j && fillLen <= T.joinText && j.length <= T.joinBlock,
      `alice's join additionalContext ${j.length} chars (mechanics text ${fillLen}, ROWS ${j.length - fillLen})`);
  },
};
