'use strict';
/**
 * plugin/sub-human/mcp/signoff.js: the room's native sign-off form (room-server plug-in, owner C).
 * Ported from the E2 prototype (/tmp/exp-2/plugin/mcp/room-server.js, docs/experiments/E2-native-signoff.md).
 *
 *   create(ctx) -> {tools, call(name, me, args, meta), tick(), stop()}
 *
 * Each Claude Code session runs its own room server, so this module serves exactly one human. A poller
 * (every SUB_HUMAN_FORM_POLL_MS, default 1 s, started here) resolves ctx.whoami() and reads the log. When
 * the current plan_rev names me as an approver, I am not the orch, the plan is not decided, and I have no
 * via=human signoff/objection on that hash, it sends one `elicitation/create` to the client:
 *
 *   message (Claude Code shows only the first 3 lines, so it is exactly 3):
 *     sub-human · room CODE · plan HASH6 (rev N)
 *     <plan.summary(text, 1)>
 *     Full plan: <plans/HASH.md>   (or: sub-human plan)
 *   requestedSchema: decision (approve | object, with titles; required) and reason (optional string).
 *     decision.description carries plan.summary(text, 3) joined with " · ".
 *
 * Answers (written straight to the log; no model turn sees them):
 *   accept + approve  -> signoff   via=human, from=me, plan_hash=the form's hash
 *   accept + object   -> objection via=human with text = the reason, byte for byte. An empty (or blank)
 *                        reason is not recorded: the form is re-asked at once with "⚠ an objection needs a
 *                        reason" on line 1 (the choice E2 verified; nothing is made up for the human).
 *   decline / cancel (Esc) / client error -> nothing logged; re-offered after SUB_HUMAN_REOFFER_MS
 *                        (default 10 min), or at once through the review tool.
 * A newer plan_rev (or a decision, or leaving the room) while a form is open cancels the stale form the
 * way E2 verified: the server sends `notifications/cancelled {requestId, reason}` for its own
 * elicitation request id, and Claude Code closes that form. A late answer to a cancelled form is ignored.
 *
 * Tool review(): re-offer the form now (the model calls it when the human says "review"). Returns at once;
 * the answer goes to the room, never to the model. Without the client's elicitation capability it returns
 * an error telling the human to update Claude Code.
 */

const envMs = (k, d) => (Number(process.env[k]) > 0 ? Number(process.env[k]) : d);

const SCHEMA_REASON = 'Required to object. Sent to the room exactly as typed.';

const TOOLS = [{
  name: 'review',
  description: 'Re-open the room\'s sign-off form in your human\'s terminal. Call it when your human says "review" or wants the form back after dismissing it. Their answer goes straight to the room; you never see or choose it. Never sign off or object for them.',
  inputSchema: { type: 'object', properties: {} },
}];

function create(ctx) {
  const POLL_MS = envMs('SUB_HUMAN_FORM_POLL_MS', 1000);
  const REOFFER_MS = envMs('SUB_HUMAN_REOFFER_MS', 10 * 60 * 1000);
  const room = ctx.room;
  const planLib = ctx.planLib;
  const log = (...a) => { try { if (ctx.log) ctx.log('signoff:', ...a); } catch { /* debug only */ } };

  let open = null;            // {id, code, name, hash, cancelled}
  const dismissed = new Map(); // `${code}/${hash}` -> ms of the last decline/cancel
  let needReason = null;       // `${code}/${hash}` whose objection came without a reason
  let stopped = false;

  const canElicit = () => { try { const c = ctx.clientCaps && ctx.clientCaps(); return !!(c && c.elicitation); } catch { return false; } };
  const key = (code, hash) => `${code}/${hash}`;

  function answered(name, hash, entries) {
    let last = null;
    for (const e of entries) {
      if (e.via === 'human' && e.from === name && e.plan_hash === hash && (e.kind === 'signoff' || e.kind === 'objection')) last = e;
    }
    return last;
  }

  function revNumber(entries, cur) {
    let n = 0;
    for (const e of entries) { if (e.kind === 'plan_rev' && e.plan_hash) { n++; if (e.id === cur.id) return n; } }
    return n;
  }

  function form(me, cur, entries) {
    const bytes = planLib.canonical(me.code, cur.hash);
    const text = bytes ? bytes.toString('utf8') : '';
    const warn = needReason === key(me.code, cur.hash) ? ' · ⚠ an objection needs a reason' : '';
    const message = [
      `sub-human · room ${me.code} · plan ${cur.hash.slice(0, 6)} (rev ${revNumber(entries, cur)})${warn}`,
      planLib.summary(text, 1) || '(plan text unavailable)',
      `Full plan: ${planLib.planPath(me.code, cur.hash)}   (or: sub-human plan)`,
    ].join('\n');
    const longer = planLib.summary(text, 3).split('\n').filter(Boolean).join(' · ');
    const requestedSchema = {
      type: 'object',
      properties: {
        decision: {
          type: 'string', title: 'Decision', enum: ['approve', 'object'],
          enumNames: ['Approve (sign off)', 'Object (blocks the plan)'],
          ...(longer ? { description: longer } : {}),
        },
        reason: { type: 'string', title: 'Reason (if objecting)', description: SCHEMA_REASON },
      },
      required: ['decision'],
    };
    return { message, requestedSchema };
  }

  function offer(me, cur, entries, why) {
    const params = form(me, cur, entries);
    const r = ctx.request('elicitation/create', params);
    const done = r && typeof r.then === 'function' ? r : r && r.done;
    const f = { id: r ? r.id : undefined, code: me.code, name: me.name, hash: cur.hash, cancelled: false };
    open = f;
    log('offer', why, f.id, cur.hash);
    Promise.resolve(done).then(res => onAnswer(f, res), err => {
      log('error', f.id, err && (err.message || JSON.stringify(err)));
      if (open === f) open = null;
      if (!f.cancelled) dismissed.set(key(f.code, f.hash), Date.now());
    });
    return f;
  }

  function onAnswer(f, res) {
    if (open === f) open = null;
    if (f.cancelled) { log('late answer to a cancelled form ignored', f.id); return; }
    const k = key(f.code, f.hash);
    if (!res || res.action !== 'accept') { dismissed.set(k, Date.now()); log('dismissed', res && res.action); return; }
    const c = res.content || {};
    const reason = typeof c.reason === 'string' ? c.reason : '';
    room.bind(f.code);
    if (c.decision === 'object') {
      if (!reason.trim()) { needReason = k; dismissed.delete(k); setImmediate(tick); return; }
      if (needReason === k) needReason = null;
      const e = room.append({ kind: 'objection', text: reason, plan_hash: f.hash }, { via: 'human', from: f.name });
      log('objection', e.id);
      return;
    }
    if (c.decision === 'approve') {
      if (needReason === k) needReason = null;
      const text = `${f.name} approved plan ${f.hash}` + (reason.trim() ? `\n${reason}` : '');
      const e = room.append({ kind: 'signoff', text, plan_hash: f.hash }, { via: 'human', from: f.name });
      log('signoff', e.id);
      return;
    }
    dismissed.set(k, Date.now());
  }

  function cancel(f, reason) {
    f.cancelled = true;
    if (open === f) open = null;
    log('cancel', f.id, reason);
    if (f.id === undefined || f.id === null) return;
    const params = { requestId: f.id, reason };
    if (typeof ctx.cancelRequest === 'function') ctx.cancelRequest(f.id, reason);
    else ctx.notify('notifications/cancelled', params);
  }

  /** One poll: cancel a stale form, or offer a due one. */
  function tick() {
    if (stopped || !canElicit()) return;
    let me;
    try { me = ctx.whoami(); } catch { return; }
    if (open && (!me || me.code !== open.code || me.name !== open.name || me.role === 'orch')) {
      return cancel(open, `${open.name} is no longer in room ${open.code}`);
    }
    if (!me || me.role === 'orch') return;
    let entries;
    try { room.bind(me.code); entries = room.readAll(); } catch { return; }
    const cur = room.currentPlan(entries);
    if (open) {
      if (!cur) return;
      if (cur.hash !== open.hash) cancel(open, `plan ${open.hash} was replaced by ${cur.hash}`);
      else if (room.decided(cur.hash, entries)) return cancel(open, `plan ${cur.hash} is decided`);
      else if (!cur.approvers.includes(me.name)) return cancel(open, `${me.name} is no longer an approver`);
      else return;
    }
    if (!cur || !cur.approvers.includes(me.name) || room.decided(cur.hash, entries)) return;
    const k = key(me.code, cur.hash);
    if (answered(me.name, cur.hash, entries) && needReason !== k) return;
    const d = dismissed.get(k);
    if (d && Date.now() - d < REOFFER_MS) return;
    offer(me, cur, entries, needReason === k ? 'reason' : 'push');
  }

  const timer = setInterval(() => { try { tick(); } catch (e) { log('tick error', e && e.message); } }, POLL_MS);
  if (timer.unref) timer.unref();

  function review(me) {
    if (!canElicit()) {
      return ctx.text('This Claude Code cannot show the room\'s sign-off form: its MCP client does not support elicitation. Tell your human to update Claude Code (`claude update`) and restart this session; until then they cannot sign off or object to the plan.', true);
    }
    if (me.role === 'orch') return ctx.text('The orchestrator never signs off; the form goes to the approvers.', true);
    room.bind(me.code);
    const entries = room.readAll();
    const cur = room.currentPlan(entries);
    if (!cur) return ctx.text('There is no plan to review yet.');
    if (!cur.approvers.includes(me.name)) {
      return ctx.text(`${me.name} is not an approver of plan ${cur.hash}. ${me.name} can still block it by objecting in the room (@room).`);
    }
    const dec = room.decided(cur.hash, entries);
    if (dec) return ctx.text(`Plan ${cur.hash} is already decided (#${dec.id}).`);
    if (open && open.hash === cur.hash && open.code === me.code) {
      return ctx.text(`The sign-off form for plan ${cur.hash} is already open in ${me.name}'s terminal.`);
    }
    if (open) cancel(open, `plan ${open.hash} was replaced by ${cur.hash}`);
    dismissed.delete(key(me.code, cur.hash));
    offer(me, cur, entries, 'review');
    return ctx.text(`Opened the sign-off form for plan ${cur.hash} in ${me.name}'s terminal. Their answer goes straight to the room; do not post about it.`);
  }

  function call(name, me, args, meta) { // eslint-disable-line no-unused-vars
    if (name === 'review') return review(me);
    return null;
  }

  function stop() {
    stopped = true;
    clearInterval(timer);
  }

  return { tools: TOOLS, call, tick, stop, state: () => ({ open, dismissed: new Map(dismissed), needReason }) };
}

module.exports = { create, TOOLS };
