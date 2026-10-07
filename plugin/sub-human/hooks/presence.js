#!/usr/bin/env node
'use strict';
// Notification(idle_prompt|permission_prompt) and StopFailure: write this member's presence to
// presence/<name> = {state, at, detail?} (identity.writePresence, a room document). Row text (lib/rows.js)
// reads it; nothing goes to the room log, so presence never wakes anyone.
//   idle_prompt        -> idle         the human is idle at their prompt
//   permission_prompt  -> permission   their Claude is waiting on them
//   StopFailure        -> error        their Claude stalled; detail = the error code (rate_limit, …)
//   Working            -> working      not a hook event: mod/prompt.mjs runs this with {hook_event_name:
//                                     "Working"} on the person's typed prompt, since the shim does not start
//                                     node for every prompt
// join.js and session-restore.js write "working" too, and at-room.js when no origin came.
// Output: none (StopFailure ignores it).
const { run, whoami, presence } = require('./common.js');

const BY_TYPE = { idle_prompt: 'idle', permission_prompt: 'permission' };

run(input => {
  const me = whoami(input);
  if (!me) return;
  if (input.hook_event_name === 'Working') return presence(me, 'working');
  if (input.hook_event_name === 'StopFailure') {
    const err = input.error && typeof input.error === 'object' ? input.error.type || input.error.code : input.error;
    return presence(me, 'error', err ? String(err) : 'stop failure');
  }
  const state = BY_TYPE[input.notification_type];
  if (state) presence(me, state);
});
