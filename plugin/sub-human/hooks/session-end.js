#!/usr/bin/env node
'use strict';
// SessionEnd: log member_left (via system) and mark the member left, unless reason is "clear"
// (/clear and the clear-context plan approval both end with reason "clear" and keep the process).
// A departed member stays a required approver of the current plan until a new plan excludes them.
const { identity, room, run, whoami } = require('./common.js');

run(input => {
  if (input.reason === 'clear') return;
  const me = whoami(input);
  if (!me) return;
  room.append({ kind: 'member_left', text: `${me.name} left (${input.reason || 'session ended'})` }, { via: 'system', from: me.name, system: true });
  try { identity.leave(me.code, me.name); } catch { /* the log entry is what counts */ }
});
