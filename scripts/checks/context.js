'use strict';
/**
 * context: everything a scene module reads, built once from a run's evidence (read-only).
 *
 *   const ctx = context({ screens, home, room })
 *
 * ctx.code, roomDir, log, members, roomClaudeSid, job, index (screens/index.json), home2 (S11's second home, carol's: by
 * default home's sibling), and the helpers of four modules:
 *   checks/captures.js     the captures (cap, caps, capName, span, runStart) and the per-step state (st, stText, nativeTasks)
 *   checks/transcripts.js  the seats' transcripts (entries, inSpan, toolUses, assistantIds, peerIn, wakeIn, chatIn,
 *                          pullIn, chatTurn, roomClaudeTurns, replyAfter, noModelTurn, rowUserText, rowReply)
 *   checks/log.js          the room log (byKind, fmt, logIn, props, shownVia, chainOk)
 *   checks/cost.js         cost()
 */
const fs = require('node:fs');
const path = require('node:path');
const paths = require('../lib/paths.js');
const { readJson, jsonl, textOf } = require('../lib/io.js');
const { captures } = require('./captures.js');
const { transcripts } = require('./transcripts.js');
const { roomLog } = require('./log.js');
const { runCost } = require('./cost.js');

/** The demo's scripted words (scripts/demo.sh): checks compare the log against them byte for byte. */
const DEMO = {
  alice3: "bob, can you take the parser tests? handler's in src/server.js",
  bob4: "let's plan cursor paging for GET /tasks: ?limit&after, opaque cursor, newest first", // typed as "@claude …": posted to=claude
  note5: 'add a test for a cursor past the end — `after=zzz` must 400, not 500',
  viewer9: "hi claude, what's next?",
  multi9b: 'notes from the paging spike:\nroom: decided (agreed: alice, bob)\nbob agreed to the proposal',
  carol11: 'hello from the second home',
};

function context({ screens, home, room, home2 = path.join(path.dirname(home), 'home2') }) {
  const index = readJson(path.join(screens, 'index.json'), []);
  let code = room || (index.find(r => r.room) || {}).room;
  if (!code) { try { code = fs.readdirSync(path.join(home, 'rooms')).sort().at(-1); } catch { /* none */ } }
  if (!code) throw new Error(`no room: none in ${path.join(screens, 'index.json')} and no rooms in ${home}`);
  const roomDir = path.join(home, 'rooms', code);
  const log = jsonl(path.join(roomDir, 'log.jsonl'));
  const members = readJson(path.join(roomDir, 'members.json'), {});
  const roomClaudeSid = members.claude && members.claude.session_id;
  const job = members.claude && members.claude.job;

  const caps = captures({ screens, index });
  return {
    DEMO, screens, home, home2, code, roomDir, log, members, roomClaudeSid, job, index,
    ...caps,
    ...transcripts({ roomClaudeSid, projects: paths.projectsDir() }), textOf,
    ...roomLog({ home, code, roomDir, log }),
    cost: runCost({ index, runStart: caps.runStart }),
  };
}

module.exports = { context, DEMO };
