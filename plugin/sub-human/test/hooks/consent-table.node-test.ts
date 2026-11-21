// One log, every consent view: lib/room/consent.ts fold feeds stateLine, deliver(), the rows, proposal.matrix /
// pendingFor and the consent gate (hooks/consent.ts Pre(AskUserQuestion)); they must give the same answers.
import test from 'node:test';
import assert from 'node:assert/strict';
import { World, decision, room } from './helpers.ts';
import type { Identity } from '../../lib/identity.ts';
import * as proposal from '../../lib/proposal.ts';
import { propose } from '../support/plan.ts';
import * as rows from '../../lib/rows.ts';
import { sn } from '../support/brands.ts';
import { must } from '../support/must.ts';

/** A seat as proposal, deliver and rows read it. */
type Me = Pick<Identity, 'code' | 'name' | 'role'>;


test('consent table: proposal, re-proposal, revise, signoffs, objection after signoff, decision: all views agree', () => {
  const w = new World({ claude: 'sleep', alice: 'act', bob: 'sleep', carol: 'sleep', dave: 'sleep' });
  const me = (name: string): Me => ({ code: w.code, name: sn(name), role: name === 'claude' ? 'claude' : 'member' });
  const human = (from: string, kind: string, hash: string) => w.append({ kind, proposal_hash: hash }, { via: 'human', from });
  const create = (who: string, text: string, approvers: string[]) => w.lib(() => propose(me(who), { text, approvers }));

  const H1 = create('alice', '# Cursor paging\n\n1. after= cursor\n', ['bob', 'carol']).hash;  // #1
  human('bob', 'signoff', H1);                                                               // #2
  human('carol', 'signoff', H1);                                                             // #3
  const again = create('alice', '# Cursor paging\n\n1. after= cursor\n', ['bob', 'carol', 'dave']); // #4 the latest proposal wins: dave added
  assert.equal(again.again, false);
  human('carol', 'objection', H1);                                                           // #5 voids carol's signoff
  const H2 = create('alice', '# Cursor paging v2\n\n1. clamp at 100\n', ['bob', 'carol']).hash; // #6 the revision
  human('bob', 'signoff', H2);                                                               // #7
  const H3 = create('bob', '# Rename fetchUser\n', ['alice']).hash;                          // #8
  assert.ok(w.lib(() => proposal.answer(me('alice'), { hash: H3 }, { choice: 'Agree' })).entry); // #9
  assert.ok(w.lib(() => proposal.decide(w.code, H3)), 'alice completed H3');                 // #10 the decision
  assert.equal(w.lib(() => proposal.decide(w.code, H3)), null, 'decided once');

  // The one expected answer. needed = pending for that person; decided = closed (agreed).
  const want: Record<string, Record<string, string>> = {
    [H1]: { bob: 'agreed', carol: 'objected', dave: 'needed' },
    [H2]: { bob: 'agreed', carol: 'needed' },
    [H3]: { alice: 'decided' },
  };
  const ANSWER: Record<string, string> = { agreed: 'agreed', objected: 'objected', needed: 'answer needed' };
  // each request is named by its plan version ("plan p2 v1": lib/proposal.ts title)
  const titles: Record<string, string> = Object.fromEntries([H1, H2, H3].map(h => [h, w.lib(() => proposal.title(w.code, h))]));
  assert.match(must(titles[H2]), /^plan p\d+ v1$/);
  const people = ['alice', 'bob', 'carol', 'dave'];
  const hashes = [H1, H2, H3];
  const needed = (name: string) => hashes.filter(h => want[h] && want[h][name] === 'needed');

  const entries = w.entries();
  const f = w.lib(() => room.fold(entries));
  assert.deepEqual([...f.proposals.keys()], [H1, H2, H3], 'order of the latest entry');
  assert.equal(w.lib(() => room.fold(entries)), f, 'memoized: the same entries, the same fold');

  for (const name of people) {
    // proposal.pendingFor
    assert.deepEqual(w.lib(() => proposal.pendingFor(me(name), entries)).map(p => p.hash), needed(name), `pendingFor ${name}`);
    // the gate: a card call naming the hash is carded only when it is pending for me
    for (const h of hashes) {
      const r = w.hook('consent', { hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion', tool_input: { questions: [{ question: `proposal ${h}` }] } }, { as: name });
      assert.equal(decision(r) === 'ask', needed(name).includes(h), `gate ${name} ${h.slice(0, 6)}`);
    }
    // deliver: a proposal wakes me exactly while it awaits my answer
    for (const h of hashes) {
      const e = must(entries.filter(x => x.kind === 'proposal' && x.hash === h).at(-1));
      assert.equal(w.lib(() => room.deliver(me(name), e, { entries })) === 'wake', needed(name).includes(h), `deliver ${name} ${h.slice(0, 6)}`);
    }
    // stateLine: the open proposals (H1, H2) and my part in each
    const line = w.lib(() => room.open(w.code).stateLine(me(name), entries));
    for (const h of [H1, H2]) {
      const seg = line.replace(/^room now: /, '').split(/ · (?=plan |proposal |away:|\+)/).find(s => s.includes(` ${h.slice(0, 6)} `));
      assert.ok(seg, `${line} has ${h.slice(0, 6)}`);
      const you = (/ · you: (agreed|objected|answer needed|not answered)/.exec(seg) || [])[1] || null;
      const exp = ANSWER[want[h]?.[name] ?? ''] || null;
      assert.equal(you, exp, `stateLine ${name} ${h.slice(0, 6)}: ${seg}`);
    }
    // the room row: "your answer needed" names the newest pending proposal by its title
    const roomRow = w.lib(() => rows.rowText(w.code, { viewer: name, entries, taskSummary: '' }));
    const need = needed(name);
    if (need.length) assert.ok(roomRow.startsWith(`⚠ your answer needed ${titles[must(need.at(-1))]}`), `${name}: ${roomRow}`);
    else assert.doesNotMatch(roomRow, /answer needed/, `${name}: ${roomRow}`);
  }

  // proposal.matrix, from one table
  for (const h of [H1, H2, H3]) {
    const p = must(f.proposals.get(h));
    const m = w.lib(() => proposal.matrix(p, entries));
    const wh = must(want[h]);
    const by = (s: string) => p.approvers.filter(n => wh[n] === s || (s === 'agreed' && wh[n] === 'decided'));
    assert.deepEqual(m.agreed, by('agreed'), `matrix agreed ${h.slice(0, 6)}`);
    assert.deepEqual(m.objected, by('objected'), `matrix objected ${h.slice(0, 6)}`);
    assert.deepEqual(m.missing, by('needed'), `matrix missing ${h.slice(0, 6)}`);
    assert.equal(must(f.status(h)).state, h === H3 ? 'agreed' : 'open');
  }
});
