#!/usr/bin/env node
'use strict';
// SubagentStop(seat-.*): seats do not end their turn; they park in mcp__room__await_human.
// Blocks the stop with decision:"block" unless a shutdown entry for this seat is newer than the
// seat's latest start OR resume (to=<human>, to=all, or to=room), or stop_hook_active is set (we
// already blocked once; letting it stop avoids a loop). When the stop is allowed the roster marks
// the seat not live. SubagentStart re-fires with the same agent_id when SendMessage resumes a stopped
// background agent (verified live on 2.1.281), so seat-register posts a fresh seat_up on every
// resume; that seat_up is the "since" here, so the shutdown that stopped the seat last time never
// stops it again.
const { room, run, out, seatHuman, readRoster, updateRoster } = require('./common.js');

run(input => {
  const human = seatHuman(input.agent_type);
  if (!human) return;
  const r = readRoster()[human] || {};
  const entries = room.readAll();
  const lastUp = entries.filter(e => e.kind === 'seat_up' && e.agent_id === input.agent_id).at(-1);
  const since = Math.max(r.agent_id === input.agent_id ? Number(r.up_id) || 0 : 0, lastUp ? lastUp.id : 0);
  const shutdown = entries.find(e => e.kind === 'shutdown' && e.id > since && [human, 'all', 'room'].includes(e.to || 'room'));
  const ownLast = entries.filter(e => e.from === human && e.via === 'agent').at(-1);

  if (shutdown || input.stop_hook_active) {
    updateRoster(ro => {
      if (ro[human] && (!ro[human].agent_id || ro[human].agent_id === input.agent_id)) {
        ro[human].live = false;
        ro[human].stopped_at = new Date().toISOString();
        ro[human].stop_reason = shutdown ? `shutdown #${shutdown.id}` : 'stop_hook_active';
      }
    });
    return;
  }
  const after = Math.max(Number(r.last_seq) || 0, ownLast ? ownLast.id : 0);
  out({ decision: 'block', reason: `call mcp__room__await_human again (after_seq=${after} or the last seq you handled). A seat ends only on kind=shutdown.` });
});
