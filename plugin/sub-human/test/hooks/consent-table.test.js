'use strict';
// One log, every consent view: lib/consent.js fold feeds stateLine, lane(), the rows, proposal.matrix /
// pendingFor and the consent gate (hooks/consent.js Pre(AskUserQuestion)); they must give the same answers.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { World, PLUGIN, decision, room } = require('./helpers.js');

const proposal = require(path.join(PLUGIN, 'lib', 'proposal.js'));
const rows = require(path.join(PLUGIN, 'lib', 'rows.js'));
const consent = require(path.join(PLUGIN, 'lib', 'consent.js'));

test('consent table: proposal, re-proposal, revise, signoffs, objection after signoff, retract, decision: all views agree', () => {
  const w = new World({ orch: 'sleep', alice: 'act', bob: 'sleep', carol: 'sleep', dave: 'sleep' });
  const me = name => ({ code: w.code, name, role: name === 'orch' ? 'orch' : 'member' });
  const human = (from, kind, hash) => w.append({ kind, proposal_hash: hash }, { via: 'human', from });
  const retract = id => w.append({ kind: 'retract', text: 'forged', refs: [id] }, { via: 'system', from: 'room', system: true });
  const create = (who, text, approvers) => w.lib(() => proposal.create(me(who), { text, approvers }));

  const H1 = create('alice', '# Cursor paging\n\n1. after= cursor\n', ['bob', 'carol']).hash;  // #1
  human('bob', 'signoff', H1);                                                               // #2
  human('carol', 'signoff', H1);                                                             // #3
  const again = create('alice', '# Cursor paging\n\n1. after= cursor\n', ['bob', 'carol', 'dave']); // #4 the latest proposal wins: dave added
  assert.equal(again.again, false);
  human('carol', 'objection', H1);                                                           // #5 voids carol's signoff
  const H2 = create('alice', '# Cursor paging v2\n\n1. clamp at 100\n', ['bob', 'carol']).hash; // #6 the revision
  human('bob', 'signoff', H2);                                                               // #7
  retract(human('carol', 'signoff', H2).id);                                                 // #8, #9 a forged answer, retracted
  const H3 = create('bob', '# Rename fetchUser\n', ['alice']).hash;                          // #10
  const rec = w.lib(() => proposal.record(me('alice'), { hash: H3 }, { choice: 'Agree' }));  // #11 + the decision #12
  assert.ok(rec.decision, 'alice completed H3');
  const H4 = create('alice', '# Scrapped idea\n', ['bob']);                                  // #13
  retract(H4.entry.id);                                                                      // #14 the whole proposal retracted

  // The one expected answer. needed = pending for that person; decided = closed (agreed).
  const want = {
    [H1]: { bob: 'agreed', carol: 'objected', dave: 'needed' },
    [H2]: { bob: 'agreed', carol: 'needed' },
    [H3]: { alice: 'decided' },
  };
  const titles = { [H1]: 'Cursor paging', [H2]: 'Cursor paging v2', [H3]: 'Rename fetchUser' };
  const people = ['alice', 'bob', 'carol', 'dave'];
  const hashes = [H1, H2, H3, H4.hash];
  const needed = name => hashes.filter(h => want[h] && want[h][name] === 'needed');

  const entries = w.entries();
  const f = consent.fold(entries);
  assert.deepEqual([...f.proposals.keys()], [H1, H2, H3], 'H4 retracted; order of the latest entry');
  assert.equal(consent.fold(entries), f, 'memoized per array');

  for (const name of people) {
    // proposal.pendingFor
    assert.deepEqual(w.lib(() => proposal.pendingFor(me(name), entries)).map(p => p.hash), needed(name), `pendingFor ${name}`);
    // the gate: a card call naming the hash is carded only when it is pending for me
    for (const h of hashes) {
      const r = w.hook('consent', { hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion', tool_input: { questions: [{ question: `proposal ${h}` }] } }, { as: name });
      assert.equal(decision(r) === 'ask', needed(name).includes(h), `gate ${name} ${h.slice(0, 6)}`);
    }
    // lane: a proposal pushes to me exactly while it awaits my answer
    for (const h of hashes) {
      const e = entries.filter(x => x.kind === 'proposal' && x.hash === h).at(-1);
      assert.equal(room.lane(me(name), e, entries) === 'push', needed(name).includes(h), `lane ${name} ${h.slice(0, 6)}`);
    }
    // stateLine: the open proposals (H1, H2) and my part in each
    const line = w.lib(() => room.stateLine(me(name), entries));
    for (const h of [H1, H2]) {
      const seg = line.replace(/^room now: /, '').split(/ · (?=proposal |away:|\+)/).find(s => s.startsWith(`proposal ${h.slice(0, 6)}`));
      assert.ok(seg, `${line} has ${h.slice(0, 6)}`);
      const you = (/ · you: (agreed|objected|answer needed|not answered)/.exec(seg) || [])[1] || null;
      const exp = { agreed: 'agreed', objected: 'objected', needed: 'answer needed' }[(want[h] || {})[name]] || null;
      assert.equal(you, exp, `stateLine ${name} ${h.slice(0, 6)}: ${seg}`);
    }
    assert.doesNotMatch(line, new RegExp(H4.hash.slice(0, 6)), 'a retracted proposal is not shown');
    // the room row: "your answer needed" names the newest pending proposal by its title
    const roomRow = w.lib(() => rows.rowText(w.code, w.code, name, { entries, taskSummary: '' }));
    const need = needed(name);
    if (need.length) assert.ok(roomRow.startsWith(`⚠ your answer needed ${titles[need.at(-1)]}`), `${name}: ${roomRow}`);
    else assert.doesNotMatch(roomRow, /answer needed/, `${name}: ${roomRow}`);
  }

  // proposal.matrix and the participant rows (each person's newest proposal), from one table
  const latest = { alice: H3, bob: H2, carol: H2, dave: H1 };
  const ROW = { agreed: '✓ agreed', objected: '✖ objected', needed: '⚠ reviewing', decided: '✔ decided' };
  for (const h of [H1, H2, H3]) {
    const p = f.proposals.get(h);
    const m = w.lib(() => proposal.matrix(p, entries));
    const by = s => p.approvers.filter(n => want[h][n] === s || (s === 'agreed' && want[h][n] === 'decided'));
    assert.deepEqual(m.agreed, by('agreed'), `matrix agreed ${h.slice(0, 6)}`);
    assert.deepEqual(m.objected, by('objected'), `matrix objected ${h.slice(0, 6)}`);
    assert.deepEqual(m.missing, by('needed'), `matrix missing ${h.slice(0, 6)}`);
    assert.equal(f.status(h).state, h === H3 ? 'agreed' : 'open');
  }
  for (const name of people) {
    const h = latest[name];
    const t = w.lib(() => rows.rowText(w.code, name, 'orch', { entries, tasks: [] }));
    const s = want[h][name];
    assert.ok(t.startsWith(ROW[s]), `row ${name}: ${t}`);
    if (s !== 'objected') assert.ok(t.includes(titles[h]), `row ${name} names the proposal by its title: ${t}`);
    assert.doesNotMatch(t, /[0-9a-f]{6}/, `no bare hash in ${t}`);
  }
});
