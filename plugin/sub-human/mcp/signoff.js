'use strict';
/**
 * plugin/sub-human/mcp/signoff.js: the room's native sign-off form (room-server plug-in, owner C).
 * Shaped after Claude Code's own plan-approval dialog, within what MCP elicitation can render (2.1.281).
 *
 *   create(ctx) -> {tools, call(name, me, args, meta), tick(), stop()}
 *
 * Each Claude Code session runs its own room server, so this module serves exactly one human. A poller
 * (every SUB_HUMAN_FORM_POLL_MS, default 1 s, started here) resolves ctx.whoami() and reads the log. When
 * the current plan_rev names me as an approver, I am not the orch, the plan is not decided, and I have no
 * via=human signoff/objection on that hash, it sends one `elicitation/create` to the client.
 *
 * Renderer facts this design rests on (Claude Code 2.1.281, verified in the binary and live):
 *  - the message shows at most 4 lines (more become 3 lines + "… (+N more lines)"); each line is cut at
 *    the terminal width. Not configurable, no expand key.
 *  - a schema with ZERO properties starts with focus on [Accept]: Enter = accept, ↓/↑/←/→ move to
 *    [Decline], Enter = decline, Esc = cancel. No hidden keys, nothing "required" to trip over.
 *  - field descriptions are one line in the fullscreen TUI; enum fields need → to expand. So neither is used.
 *
 * Stage 1, "decide" (zero properties). Message, exactly 4 lines:
 *     Room CODE · plan HASH6 (rev N) · full plan: <plans/HASH.md>
 *     <plan.packed(text)[0]>
 *     <plan.packed(text)[1]>   (or a ⚠ note when the form comes back, e.g. after a too-fast Enter)
 *     Approve this plan?  Accept (Enter) = Approve · Decline (↓ Enter) = Object, say why · Esc = later
 *   accept  -> signoff via=human, from=me, plan_hash=the form's hash. An accept that arrives sooner than
 *              SUB_HUMAN_FORM_MIN_MS (default 1 s) after the form was sent is treated as a stray Enter typed
 *              for the prompt: nothing is recorded and the form comes straight back with a ⚠ note.
 *   decline -> stage 2 at once.
 * Stage 2, "reason" (one required string, minLength 1; Enter in the box moves to [Accept], Enter sends):
 *     [⚠ note ·] Object to plan HASH6 (rev N) · room CODE
 *     Type what the room should change, then press Enter twice. Sent exactly as typed; it blocks the plan.
 *     Decline = back to Approve/Object · Esc = later
 *   accept  -> objection via=human with text = the reason, byte for byte. A blank reason is not recorded:
 *              stage 2 comes back with a ⚠ note.
 *   decline -> stage 1 again at once.
 * Esc (cancel) or a client error at either stage -> nothing logged; stage 1 is re-offered after
 * SUB_HUMAN_REOFFER_MS (default 10 min), or at once through the review tool.
 *
 * A newer plan_rev (or a decision, or leaving the room) while a form is open cancels the stale form:
 * the server sends `notifications/cancelled {requestId, reason}` and Claude Code closes it. A late
 * answer to a cancelled form is ignored.
 *
 * Tool review(): re-offer the form now (the model calls it when the human says "review", or voices
 * approval/objection in chat while a sign-off is pending). Returns at once; the answer goes to the room,
 * never to the model. Without the client's elicitation capability it returns an error.
 */

const envMs = (k, d) => (Number(process.env[k]) > 0 ? Number(process.env[k]) : d);
const envMs0 = (k, d) => (process.env[k] !== undefined && Number(process.env[k]) >= 0 ? Number(process.env[k]) : d);

const ASK = 'Approve this plan?  Accept (Enter) = Approve · Decline (↓ Enter) = Object, say why · Esc = later';
const REASON_HOW = 'Type what the room should change, then press Enter twice. Sent exactly as typed; it blocks the plan.';
const REASON_KEYS = 'Decline = back to Approve/Object · Esc = later';
const NOTE_FAST = '⚠ Not recorded: that Enter came too fast (a stray key?). Press Enter again to approve.';
const NOTE_BLANK = '⚠ An objection needs a reason.';

const TOOLS = [{
  name: 'review',
  description: 'Re-open the room\'s sign-off form in your human\'s terminal. Call it when your human says "review", wants the form back, or says in chat that they approve or object while their sign-off is pending. Their answer goes straight to the room; you never see or choose it. Never sign off or object for them.',
  inputSchema: { type: 'object', properties: {} },
}];

function create(ctx) {
  const POLL_MS = envMs('SUB_HUMAN_FORM_POLL_MS', 1000);
  const REOFFER_MS = envMs('SUB_HUMAN_REOFFER_MS', 10 * 60 * 1000);
  const MIN_MS = envMs0('SUB_HUMAN_FORM_MIN_MS', 1000);
  const room = ctx.room;
  const planLib = ctx.planLib;
  const log = (...a) => { try { if (ctx.log) ctx.log('signoff:', ...a); } catch { /* debug only */ } };

  let open = null;             // {id, code, name, hash, stage, sent, cancelled}
  const dismissed = new Map(); // `${code}/${hash}` -> ms of the last Esc / error
  const next = new Map();      // `${code}/${hash}` -> {stage, note}: the form to show next, at once
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

  function form(me, cur, entries, stage, note) {
    const h6 = cur.hash.slice(0, 6);
    const rev = revNumber(entries, cur);
    if (stage === 'reason') {
      const pre = note ? `${note} · ` : '';
      return {
        message: [`${pre}Object to plan ${h6} (rev ${rev}) · room ${me.code}`, REASON_HOW, REASON_KEYS].join('\n'),
        requestedSchema: {
          type: 'object',
          properties: { reason: { type: 'string', title: 'What should change?', minLength: 1 } },
          required: ['reason'],
        },
      };
    }
    const bytes = planLib.canonical(me.code, cur.hash);
    const text = bytes ? bytes.toString('utf8') : '';
    const lines = planLib.packed(text, note ? 1 : 2);
    if (!lines.length) lines.push('(plan text unavailable)');
    if (note) lines.push(note);
    else if (lines.length < 2) lines.push(' ');
    return {
      message: [
        `Room ${me.code} · plan ${h6} (rev ${rev}) · full plan: ${planLib.planPath(me.code, cur.hash)}`,
        ...lines,
        ASK,
      ].join('\n'),
      requestedSchema: { type: 'object', properties: {} },
    };
  }

  function offer(me, cur, entries, why) {
    const k = key(me.code, cur.hash);
    const n = next.get(k) || { stage: 'decide' };
    next.delete(k);
    const params = form(me, cur, entries, n.stage, n.note);
    const r = ctx.request('elicitation/create', params);
    const done = r && typeof r.then === 'function' ? r : r && r.done;
    const f = { id: r ? r.id : undefined, code: me.code, name: me.name, hash: cur.hash, stage: n.stage, sent: Date.now(), cancelled: false };
    open = f;
    log('offer', why, n.stage, f.id, cur.hash);
    Promise.resolve(done).then(res => onAnswer(f, res), err => {
      log('error', f.id, err && (err.message || JSON.stringify(err)));
      if (open === f) open = null;
      if (!f.cancelled) dismissed.set(key(f.code, f.hash), Date.now());
    });
    return f;
  }

  /** Show `stage` (with an optional note) right away instead of waiting out a dismissal. */
  function again(f, stage, note) {
    const k = key(f.code, f.hash);
    next.set(k, { stage, ...(note ? { note } : {}) });
    dismissed.delete(k);
    setImmediate(() => { try { tick(); } catch (e) { log('tick error', e && e.message); } });
  }

  function onAnswer(f, res) {
    if (open === f) open = null;
    if (f.cancelled) { log('late answer to a cancelled form ignored', f.id); return; }
    const k = key(f.code, f.hash);
    const action = res && res.action;
    if (action !== 'accept' && action !== 'decline') { next.delete(k); dismissed.set(k, Date.now()); log('dismissed', action); return; }
    if (f.stage === 'decide') {
      if (action === 'decline') return again(f, 'reason');
      if (Date.now() - f.sent < MIN_MS) { log('too fast', Date.now() - f.sent); return again(f, 'decide', NOTE_FAST); }
      room.bind(f.code);
      const e = room.append({ kind: 'signoff', text: `${f.name} approved plan ${f.hash}`, plan_hash: f.hash }, { via: 'human', from: f.name });
      log('signoff', e.id);
      return;
    }
    // stage 'reason'
    if (action === 'decline') return again(f, 'decide');
    const c = (res && res.content) || {};
    const reason = typeof c.reason === 'string' ? c.reason : '';
    if (!reason.trim()) return again(f, 'reason', NOTE_BLANK);
    room.bind(f.code);
    const e = room.append({ kind: 'objection', text: reason, plan_hash: f.hash }, { via: 'human', from: f.name });
    log('objection', e.id);
  }

  function cancel(f, reason) {
    f.cancelled = true;
    if (open === f) open = null;
    log('cancel', f.id, reason);
    if (f.id === undefined || f.id === null) return;
    if (typeof ctx.cancelRequest === 'function') ctx.cancelRequest(f.id, reason);
    else ctx.notify('notifications/cancelled', { requestId: f.id, reason });
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
    if (answered(me.name, cur.hash, entries) && !next.has(k)) return;
    const d = dismissed.get(k);
    if (d && Date.now() - d < REOFFER_MS) return;
    offer(me, cur, entries, next.has(k) ? 'again' : 'push');
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
    const k = key(me.code, cur.hash);
    dismissed.delete(k);
    next.delete(k);
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

  return { tools: TOOLS, call, tick, stop, state: () => ({ open, dismissed: new Map(dismissed), next: new Map(next) }) };
}

module.exports = { create, TOOLS };
