#!/usr/bin/env node
'use strict';
// SessionStart(compact|clear|resume): ported from demo/hooks/session-digest.js.
// /clear and resume give a new session_id; CLAUDE_PID stays the same, so we find the member by pid,
// rebind the new session_id, and re-inject the role text plus the digest (capped at 9,500 chars).
// A clear with a pending room review means the clear-context approve path ran: warn the Claude.
const { identity, run, out, whoami, contextBlock, readPending, clearPending, clip } = require('./common.js');

run(input => {
  const me = whoami(input);
  if (!me) return;
  if (input.session_id && me.session_id !== input.session_id) identity.rebindSession(me.pid, input.session_id);
  let warn = '';
  if (input.source === 'clear' && me.role !== 'orch' && readPending(me)) {
    clearPending(me);
    warn = 'The previous plan approval was a ROOM REVIEW, not a go-ahead. Do NOT implement it; wait for an assignment from the room.\n\n';
  }
  const text = clip(warn + contextBlock(me, `restored after ${input.source || 'start'}`));
  out({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: text } });
});
