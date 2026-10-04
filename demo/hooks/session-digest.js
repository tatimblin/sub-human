#!/usr/bin/env node
'use strict';
// SessionStart(compact): re-inject the room digest verbatim after compaction (plan §3.7).
// The digest is generated from the log by room.digest(), capped at 9,500 chars (the CLI caps
// SessionStart context at 10k).
const { room, run, out } = require('./common.js');

const CAP = 9500;

run(() => {
  let d = room.digest();
  if (d.length > CAP) d = d.slice(0, CAP - 1) + '…';
  out({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: d } });
});
