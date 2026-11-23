// plans: the author's side (ARCHITECTURE §7 "Group plan" steps 1–2, "Sent plan"). A plan is written in plan mode as
// ever; at approval (ExitPlanMode's result) the person is asked once: keep it, make it a room plan, or send it (R18).
// The next version of a room plan this session stored asks nothing and is drawn in one line; a session with nobody to
// answer (`-p`) shares nothing.
// A room plan is stored with `plan edit` and the people the person picks are asked with `plan ask`; a sent plan is
// stored as theirs and sent with their branch, the files they touched and a note. The approval is passed on as it came:
// no plan file is written and no mode is changed (R19). Claude's `plan` tool is answered here too (§6).
// plans-cards.ts says what each card asks and what an answer means; plans-review.ts is the reviewer's side.
import type { On } from 'claude-code';
import * as v from '../vendor/valibot.mjs';
import type { PlanAct } from '../core/api.js';
import { sha256 } from '../core/hash.js';
import { latestVersion } from '../core/plans.js';
import type { Result } from '../core/result.js';
import { err, ok } from '../core/result.js';
import { secretIn } from '../core/secrets.js';
import { blobFile } from '../home.js';
import { answer, request } from './bridge.js';
import type { Card } from './plans-cards.js';
import type { Revision } from './plans-cards.js';
import { DONT, SEND, approval, choice, freeName, reviewers, reviewersCard, sendCard } from './plans-cards.js';
import { staleNote } from './plans-notes.js';
import { planSession, registerReview } from './plans-review.js';
import type { InRoom } from './session.js';
import { session } from './session.js';
import { toolName } from './tools.js';

const Approved = v.looseObject({ plan: v.pipe(v.string(), v.minLength(1)), filePath: v.optional(v.string()), isAgent: v.optional(v.boolean()) });
const Save = v.looseObject({ op: v.literal('edit') });
const name = v.pipe(v.string(), v.minLength(1));
const version = v.pipe(v.number(), v.integer(), v.minValue(1));
const PlanInput = v.variant('op', [
  v.object({ op: v.literal('edit'), name, base: v.pipe(v.number(), v.integer(), v.minValue(0)), text: v.pipe(v.string(), v.minLength(1)) }),
  v.object({ op: v.literal('ask'), name, version, people: v.array(v.string()) }),
  v.object({ op: v.literal('send'), name, to: v.optional(v.string()), note: v.optional(v.string()) }),
]);

/** What Claude's `plan` tool asks the daemon for. */
export type ToolPlan = { readonly op: 'plan'; readonly code: string; readonly from: string } & Extract<PlanAct, { act: 'edit' | 'ask' | 'send' }>;

/** The daemon call a `plan` tool call asks for, or why nothing was done. A send gains the branch and files in the hook. */
export function planCall(input: unknown, room: InRoom): Result<ToolPlan> {
  const i = v.safeParse(PlanInput, input);
  if (!i.success) return err('Nothing was done: plan takes op edit {name, base, text}, ask {name, version, people} or send {name, to?, note?}.');
  const writer = { op: 'plan', code: room.code, from: room.name } as const;
  const o = i.output;
  switch (o.op) {
    case 'edit': {
      const rule = secretIn(o.text);
      if (rule) return err(`Plan ${o.name} was not stored: its text looks like it holds a secret (${rule}). Store it without the secret.`);
      return ok({ ...writer, act: 'edit', name: o.name, base: o.base, text: o.text });
    }
    case 'ask': return ok({ ...writer, act: 'ask', name: o.name, version: o.version, people: o.people, by: 'claude' });
    case 'send': return ok({ ...writer, act: 'send', name: o.name, ...(o.to !== undefined && { to: o.to }), ...(o.note?.trim() && { note: o.note }), by: 'claude' });
  }
}

export function registerPlans(on: On): void {
  registerReview(on);
  on('tool.call', { tool: 'ExitPlanMode' }, async ($, e, next) => {
    const r = await next(e);
    const room = session.room;
    const s = session.state;
    const got = v.safeParse(Approved, r.result);
    if (!room || !s || !planSession.interactive || e.agentId !== undefined || r.result === undefined || r.isError || !got.success || got.output.isAgent) return r;
    const text = got.output.plan;
    const file = got.output.filePath ?? '';
    const plan = async (act: PlanAct) => {
      const q = request({ op: 'plan', code: room.code, from: room.name, ...act }, room.home);
      const a = await $.http.fetch(q.url, q).then(x => answer('plan', x), (x: unknown) => err(String(x).slice(0, 200)));
      const why = !a.ok ? a.error : 'refused' in a.value ? a.value.refused : '';
      if (why) $.ui.log(`sub-human couldn't share your plan with ${room.code}: ${why}`);
      return a.ok && 'seq' in a.value ? ok(a.value.latest?.version ?? 0) : err(why);
    };
    const ask = (c: Card) => $.ui.ask(c.question, { options: c.options, header: 'Plan', ...(c.multiSelect && { multiSelect: true }) }).catch(() => null);
    const told = (line: string) => ({ ...r, context: [...(r.context ?? []), `sub-human: ${line}`] });
    // a next version of a room plan, asked of the same people again; `drawn` when no card asked for it
    const revise = async (rev: Revision, drawn: boolean) => {
      const at = await plan({ act: 'edit', name: rev.name, base: rev.base, text });
      if (!at.ok) return r;
      planSession.stored.set(rev.name, file);
      const asked = rev.people.length ? (await plan({ act: 'ask', name: rev.name, version: at.value, people: rev.people, by: 'person' })).ok : false;
      const again = asked ? `; asked ${rev.people.join(', ')} again` : '';
      if (drawn) {
        $.ui.log(`sub-human: shared as ${rev.name} v${at.value}${again}`);
        session.drawn++; // within the lines a prompt's turn may draw (R41)
      }
      return told(`this approved plan is room plan ${rev.name} v${at.value} in ${room.code}${asked ? `; asked ${rev.people.join(', ')} to agree again` : ''}.`);
    };
    const a = approval(s, room.name, room.code, text, file, planSession.stored);
    if (a.kind === 'revision') return revise(a.revision, true);
    const c = choice(await ask(a.card), a, s, room.name, room.code);
    if (c.kind === 'keep') {
      if (c.line) $.ui.log(c.line);
      return r;
    }
    if (c.kind === 'revise' && a.revision) return revise(a.revision, false);
    if (c.kind === 'send') {
      const picked = await ask(sendCard(a.name, c.to));
      if (picked === null || picked === DONT) return r;
      const { name: as, base } = freeName(s, a.name, room.name, 'personal');
      const latest = latestVersion(s, as);
      const at = latest?.hash === await sha256(text) ? ok(latest.version) : await plan({ act: 'edit', name: as, base, text, scope: 'personal' });
      if (!at.ok) return r;
      const branch = (await $.vcs.detect({ path: room.root }).catch(() => null))?.branch;
      const note = picked === SEND ? '' : picked.trim();
      const sent = await plan({
        act: 'send', name: as, version: at.value, files: session.mine?.files ?? [], by: 'person',
        ...(c.to !== undefined && { to: c.to }), ...(note && { note }), ...(branch && { branch }),
      });
      return sent.ok ? told(`your person sent this plan to ${c.to ?? 'the room'} in ${room.code} as ${as} v${at.value}.`) : r;
    }
    const { name: as, base } = freeName(s, a.name, room.name, 'group');
    const at = await plan({ act: 'edit', name: as, base, text, scope: 'group' });
    if (!at.ok) return r;
    planSession.stored.set(as, file);
    const card = reviewersCard(s, room.name, as, at.value);
    const people = card ? reviewers(await ask(card), s, room.name) : [];
    const asked = people.length ? (await plan({ act: 'ask', name: as, version: at.value, people, by: 'person' })).ok : false;
    return told(`this approved plan is room plan ${as} v${at.value} in ${room.code}${asked ? `; asked ${people.join(', ')} to agree. Their answers reach you as room updates` : ''}.`);
  });

  on('tool.run', { tool: toolName('plan') }, async ($, e) => {
    // a save that didn't happen is an answer, never a red error (R19); other refusals deny, as share's do
    const refuse = (text: string) => (v.is(Save, e) ? { result: text } : { deny: text });
    const room = session.room;
    if (!room) return refuse('This session is in no room; nothing was done. Your person can join one with /sub-human.');
    const c = planCall(e, room);
    if (!c.ok) return refuse(c.error);
    const branch = c.value.act === 'send' ? (await $.vcs.detect({ path: room.root }).catch(() => null))?.branch : null;
    const req = c.value.act === 'send' ? { ...c.value, files: session.mine?.files ?? [], ...(branch && { branch }) } : c.value;
    const q = request(req, room.home);
    const a = await $.http.fetch(q.url, q).then(x => answer('plan', x), (x: unknown) => err(String(x).slice(0, 200)));
    if (!a.ok) return refuse(`Nothing was done in ${room.code}: ${a.error}`);
    if ('refused' in a.value) { // a stale edit, answered with the current text so the Claude can merge (R17)
      const at = a.value.latest;
      const text = at && await $.fs.read(blobFile(room.dir, at.hash)).catch(() => null);
      return { result: text ? staleNote(a.value.refused, room.code, req.name, at.version, text) : a.value.refused };
    }
    const n = a.value.latest?.version ?? 0;
    switch (req.act) {
      case 'edit':
        if (!planSession.stored.has(req.name)) planSession.stored.set(req.name, '');
        return { result: `Stored plan ${req.name} v${n} in ${room.code}.` };
      case 'ask': return { result: `Asked ${req.people.join(', ')} to agree on ${req.name} v${req.version}; each answers in their own session.` };
      case 'send': return { result: `Sent plan ${req.name} v${n} to ${req.to ?? 'the room'}.` };
    }
  });
}
