// lib/consent/review.ts: the consent hook's reducer, as tables. Every review phase × every event, then every note
// stage × every event that moves a note, then the facts each branch reads. Pure: no room, no files, no clock.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as review from '../lib/consent/review.ts';
import { hash12 } from '../lib/text.ts';
import type { Event, State, Step } from '../lib/consent/review.ts';
import type { Confirm, NoteStage, Review } from '../lib/types-app.ts';

const TEXT = '# Ship v3 Monday\n\n1. tag\n';
const H = hash12(Buffer.from(TEXT, 'utf8'));
const OTHER = 'bbbbbbbbbbbb';
const ctx = { name: 'bob', now: 5000 };
const target = { hash: H, from: 'alice', title: 'Ship v3 Monday' };
const plan = { file: '/plans/x.md', text: 'old plan' };
const pending = [{ hash: H, from: 'alice', viewable: true }];

const REVIEWS: Record<string, Review | null> = {
  none: null,
  entering: { phase: 'entering', mode: 'default', at: 1, hash: H, from: 'alice' },
  shown: { phase: 'shown', mode: 'default', at: 1, hash: H, from: 'alice', file: '/plans/x.md', backup: 'old plan', restored: false, tool_use_id: 'tu1' },
  exiting: { phase: 'exiting', mode: 'default', at: 1, hash: H, from: 'alice', file: '/plans/x.md', backup: 'old plan', restored: false, tool_use_id: 'tu1' },
  unread: { phase: 'exiting', mode: 'default', at: 1, hash: H, from: 'alice', file: '/plans/x.md', backup: 'old plan', restored: false, tool_use_id: 'tu1', unread: true, said: 'x' },
  restore: { phase: 'restore', mode: 'default', at: 1, hash: H, from: 'alice', file: '/plans/x.md', backup: 'old plan', restored: true },
};

/** Each event with the facts of an ordinary run: in plan mode where the event happens there, the person's Yes. */
const EVENTS: { [K in Event['type']]: Extract<Event, { type: K }> } = {
  enter: { type: 'enter', mode: 'default', reviewable: true, pending, said: null, named: null, replaced: null, kept: null, propose: false, plan },
  entered: { type: 'entered', plan },
  exit: { type: 'exit', toolUseId: 'tu2', answer: { note: null }, target, shown: { hash: H, from: 'alice' }, text: TEXT, plan, callPlan: `proposal ${H}`, ownPlan: undefined },
  permission: { type: 'permission' },
  exited: { type: 'exited', toolUseId: 'tu1', mode: 'default', answer: null, target, response: { plan: TEXT, edited: false, isAgent: false, filePath: undefined },
    callPlan: undefined, pending: [], callNames: [], reviewable: true, proposed: false },
  stop: { type: 'stop', mode: 'plan', active: false, answer: { note: null }, target, live: true },
  roomTool: { type: 'roomTool', mode: 'plan', answer: { note: null }, target },
  prompt: { type: 'prompt', mode: 'plan', answer: { note: null }, target, live: true },
  ask: { type: 'ask', admit: null, handoff: false, noteNamed: false, live: true, hit: pending, reviewable: true },
  answered: { type: 'answered', note: { kind: 'absent' }, target, afk: false, asked: true, answers: [{ hash: H, answer: { kind: 'answer', label: 'Agree' }, live: true }] },
  planFailed: { type: 'planFailed', early: false },
};

/** What a step did, compactly: the review's phase after it (none: cleared), the say's kind, the effects in order. */
const shape = (s: Step) => [s.state.review ? s.state.review.phase : 'none', s.say ? s.say.to : null, s.effects.map(e => e.do).join(',')];

// review phase × event -> [phase after, say, effects]
const TABLE: Record<string, Record<Event['type'], [string, string | null, string]>> = {
  none: {
    enter: ['entering', 'allow', 'save,writePlan'], entered: ['none', null, ''], exit: ['none', null, ''], permission: ['none', null, ''],
    exited: ['none', 'context', ''], stop: ['none', null, ''], roomTool: ['none', null, ''], prompt: ['none', null, ''],
    ask: ['none', 'deny', 'pick'], answered: ['none', 'context', 'answer'], planFailed: ['none', null, ''],
  },
  entering: {
    enter: ['entering', 'allow', 'save,writePlan'], entered: ['entering', 'context', 'save,writePlan'], exit: ['shown', 'ask', 'save,writePlan'],
    permission: ['entering', null, ''], exited: ['none', 'context', ''], stop: ['entering', 'context', ''], roomTool: ['entering', null, ''],
    prompt: ['exiting', 'context', ''], ask: ['entering', 'deny', 'pick'], answered: ['entering', 'context', 'answer'], planFailed: ['exiting', null, ''],
  },
  shown: {
    enter: ['entering', 'allow', 'restorePlan,save,writePlan'], entered: ['shown', null, ''], exit: ['exiting', null, ''], permission: ['shown', null, ''],
    exited: ['none', 'context', 'answer,restorePlan'], stop: ['exiting', 'context', ''], roomTool: ['exiting', 'deny', ''], prompt: ['exiting', 'context', ''],
    ask: ['shown', 'deny', 'pick'], answered: ['shown', 'context', 'answer'], planFailed: ['exiting', null, 'restorePlan'],
  },
  exiting: {
    enter: ['entering', 'allow', 'restorePlan,save,writePlan'], entered: ['exiting', null, ''], exit: ['exiting', null, ''], permission: ['exiting', 'permit', 'restorePlan'],
    exited: ['none', 'context', 'restorePlan'], stop: ['exiting', 'context', ''], roomTool: ['exiting', 'deny', ''], prompt: ['exiting', 'context', ''],
    ask: ['exiting', 'deny', 'pick'], answered: ['exiting', 'context', 'answer'], planFailed: ['exiting', null, 'restorePlan'],
  },
  unread: {
    enter: ['entering', 'allow', 'restorePlan,save,writePlan'], entered: ['exiting', null, ''], exit: ['exiting', null, ''], permission: ['exiting', 'permit', 'restorePlan'],
    exited: ['none', 'context', 'answer,restorePlan'], stop: ['exiting', 'context', ''], roomTool: ['exiting', 'deny', ''], prompt: ['exiting', 'context', ''],
    ask: ['exiting', 'deny', 'pick'], answered: ['exiting', 'context', 'answer'], planFailed: ['exiting', null, 'restorePlan'],
  },
  restore: {
    enter: ['restore', 'allow', ''], entered: ['restore', 'context', ''], exit: ['exiting', null, ''], permission: ['restore', null, ''],
    exited: ['restore', null, ''], stop: ['restore', 'context', ''], roomTool: ['restore', null, ''], prompt: ['none', null, ''],
    ask: ['restore', 'deny', 'pick'], answered: ['restore', 'context', 'answer'], planFailed: ['exiting', null, ''],
  },
};

test('review: every phase × every event, in one table', () => {
  const types = Object.keys(EVENTS) as Event['type'][];
  for (const [phase, row] of Object.entries(TABLE)) {
    assert.deepEqual(Object.keys(row).sort(), [...types].sort(), `${phase}: a row for every event`);
    for (const t of types) {
      const st: State = { review: REVIEWS[phase], note: null };
      assert.deepEqual(shape(review.reduce(st, EVENTS[t], ctx)), row[t], `${phase} × ${t}`);
    }
  }
  assert.deepEqual(Object.keys(TABLE).sort(), Object.keys(REVIEWS).sort());
});

test('review: the reducer is pure: it never changes the state it was given', () => {
  for (const r of Object.values(REVIEWS)) for (const ev of Object.values(EVENTS)) {
    const st: State = { review: r && structuredClone(r), note: note('asked') };
    const before = JSON.stringify(st);
    review.reduce(st, ev, ctx);
    assert.equal(JSON.stringify(st), before, `${r && r.phase} × ${ev.type}`);
  }
});

// ---------- the note ----------
const note = (stage: NoteStage | null, extra: Partial<Confirm> = {}): Confirm => ({ hash: H, note: 'open rate limiting', from: 'alice', title: 'Ship v3 Monday', at: 1, ...(stage ? { stage } : {}), ...extra });
const ASK_NOTE: Event = { type: 'ask', admit: null, handoff: false, noteNamed: true, live: true, hit: [], reviewable: true };
const STOP: Event = { type: 'stop', mode: 'default', active: false, live: true };
const PROMPT: Event = { type: 'prompt', mode: 'default', live: true };
const card = (a: Extract<Event, { type: 'answered' }>['note']): Event => ({ type: 'answered', note: a, target, afk: false, asked: false, answers: [] });

/** The note's stage after a step (none: dropped), the say's kind and effects. */
const noteShape = (s: Step) => [s.state.note ? review.stageOf(s.state.note) : 'none', s.say ? s.say.to : null, s.effects.map(e => e.do).join(',')];

// note stage × event (no review open) -> [stage after, say, effects]
const NOTES: Record<NoteStage, Record<string, [string, string | null, string]>> = {
  waiting: { stop: ['nudged', 'context', ''], prompt: ['waiting', null, ''], ask: ['asked', 'ask', ''], none: ['told', 'context', ''], other: ['told', 'context', ''], discard: ['none', 'context', ''], send: ['waiting', 'context', 'answer'] },
  nudged: { stop: ['nudged', null, ''], prompt: ['told', 'context', ''], ask: ['asked', 'ask', ''], none: ['told', 'context', ''], other: ['told', 'context', ''], discard: ['none', 'context', ''], send: ['nudged', 'context', 'answer'] },
  asked: { stop: ['asked', null, ''], prompt: ['reoffered', 'context', ''], ask: ['asked', 'ask', ''], none: ['told', 'context', ''], other: ['told', 'context', ''], discard: ['none', 'context', ''], send: ['asked', 'context', 'answer'] },
  reoffered: { stop: ['told', 'context', ''], prompt: ['reoffered', null, ''], ask: ['told', 'ask', ''], none: ['told', 'context', ''], other: ['told', 'context', ''], discard: ['none', 'context', ''], send: ['reoffered', 'context', 'answer'] },
  told: { stop: ['told', null, ''], prompt: ['told', null, ''], ask: ['told', 'ask', ''], none: ['told', 'context', ''], other: ['told', 'context', ''], discard: ['none', 'context', ''], send: ['told', 'context', 'answer'] },
};
const NOTE_EVENTS: Record<string, Event> = {
  stop: STOP, prompt: PROMPT, ask: ASK_NOTE,
  none: card({ kind: 'none' }), other: card({ kind: 'other', label: 'later' }),
  discard: card({ kind: 'answer', label: 'Discard' }), send: card({ kind: 'answer', label: 'Send' }),
};

test('note: every stage × every event that moves it, in one table; Send leaves it to the answer effect (clearNote)', () => {
  for (const [stage, row] of Object.entries(NOTES) as [NoteStage, (typeof NOTES)[NoteStage]][]) {
    assert.deepEqual(Object.keys(row).sort(), Object.keys(NOTE_EVENTS).sort(), stage);
    for (const [k, ev] of Object.entries(NOTE_EVENTS)) {
      assert.deepEqual(noteShape(review.reduce({ review: null, note: note(stage) }, ev, ctx)), row[k], `${stage} × ${k}`);
    }
  }
  const send = review.reduce({ review: null, note: note('asked') }, NOTE_EVENTS.send, ctx);
  assert.deepEqual(send.effects, [{ do: 'answer', hash: H, choice: 'Object', notes: 'open rate limiting', clearNote: true }]);
});

test('note: one whose proposal is no longer the seat\'s is dropped wherever it is met; Send on a stale one too', () => {
  assert.equal(review.reduce({ review: null, note: note('waiting') }, { ...STOP, live: false }, ctx).state.note, null);
  assert.equal(review.reduce({ review: null, note: note('reoffered') }, { ...STOP, live: false }, ctx).state.note, null);
  assert.equal(review.reduce({ review: null, note: note('asked') }, { ...PROMPT, live: false }, ctx).state.note, null);
  const ask = review.reduce({ review: null, note: note('waiting') }, { ...ASK_NOTE, live: false }, ctx);
  assert.deepEqual([ask.state.note, ask.say], [null, null]);
  const stale = review.reduce({ review: null, note: note('asked') }, { ...NOTE_EVENTS.send, target: null } as Event, ctx);
  assert.deepEqual([stale.state.note, stale.effects], [null, []]);
  // a Stop that continues a turn already (stop_hook_active) says nothing and moves nothing
  assert.deepEqual(noteShape(review.reduce({ review: null, note: note('waiting') }, { ...STOP, active: true }, ctx)), ['waiting', null, '']);
});

test('note: a note an earlier sub-human wrote (flags) reads as its stage; a step writes the stage, not the flags', () => {
  const flags: [Partial<Confirm>, NoteStage][] = [
    [{}, 'waiting'], [{ nudged: 2 }, 'nudged'], [{ asked: 2 }, 'asked'], [{ asked: 2, again: 3, reoffered: 3 }, 'reoffered'],
    [{ asked: 4, again: 3, reoffered: 3 }, 'told'], [{ asked: 2, again: 3 }, 'told'], [{ reoffered: 3, renudged: 4 }, 'told'], [{ nudged: 2, again: 3 }, 'told'],
  ];
  for (const [f, stage] of flags) assert.equal(review.stageOf(note(null, f)), stage, JSON.stringify(f));
  const next = review.reduce({ review: null, note: note(null, { asked: 2 }) }, PROMPT, ctx).state.note!;
  assert.equal(next.stage, 'reoffered');
  assert.deepEqual(['asked', 'nudged', 'again', 'reoffered', 'renudged'].filter(k => k in next), []);
});

test('openOf: a review on record, or a note consent must still offer (anything but told)', () => {
  assert.equal(review.openOf({ review: null, note: null }), false);
  assert.equal(review.openOf({ review: REVIEWS.restore, note: null }), true);
  for (const s of ['waiting', 'nudged', 'asked', 'reoffered'] as NoteStage[]) assert.equal(review.openOf({ review: null, note: note(s) }), true, s);
  assert.equal(review.openOf({ review: null, note: note('told') }), false);
});

// ---------- the facts each branch reads ----------
test('answerNeeded: which events read the dialog\'s answer, and which wait for it', () => {
  const at = (r: Review | null, type: Event['type'], toolUseId: string | null = 'tu2', mode = 'plan') => review.answerNeeded(r, { type, toolUseId, mode });
  assert.equal(at(null, 'exit'), null);
  assert.equal(at(REVIEWS.entering, 'stop'), null, 'no dialog yet');
  assert.equal(at(REVIEWS.shown, 'exit'), 'wait', 'the closing call: the line may not be written yet');
  assert.equal(at(REVIEWS.shown, 'exit', 'tu1'), null, 'the same call again');
  assert.equal(at(REVIEWS.unread, 'exited'), 'wait');
  assert.equal(at(REVIEWS.unread, 'exited', 'tu1'), null, "the dialog's own Post: a Yes");
  assert.equal(at(REVIEWS.shown, 'exited'), null, 'a Yes reads the response, not the transcript');
  assert.equal(at(REVIEWS.shown, 'stop'), 'now');
  assert.equal(at(REVIEWS.shown, 'stop', null, 'default'), null);
  assert.equal(at(REVIEWS.shown, 'roomTool'), 'now');
  assert.equal(at(REVIEWS.unread, 'prompt', null, 'default'), 'now', 'left plan mode another way: the note is read now');
  assert.equal(at({ ...REVIEWS.shown!, resolved: true }, 'stop'), null, 'resolved once');
});

test('enter: the person\'s pick, else the earlier pick, else the newest; never the model\'s', () => {
  const two = [{ hash: OTHER, from: 'alice', viewable: true }, ...pending];
  const enter = (e: Partial<Extract<Event, { type: 'enter' }>>) => review.reduce({ review: null, note: null }, { ...EVENTS.enter, pending: two, ...e } as Event, ctx);
  assert.equal(enter({}).state.review!.hash, H, 'nothing named: the newest');
  assert.deepEqual(enter({}).effects.map(e => e.do), ['save', 'writePlan'], 'no prompt of the person\'s: no pick written');
  const said = { text: `open ${OTHER.slice(0, 6)}`, at: 10 };
  const named = enter({ said, named: OTHER });
  assert.equal(named.state.review!.hash, OTHER);
  assert.deepEqual(named.effects[0], { do: 'pick', hash: OTHER });
  assert.deepEqual(enter({ said: { text: 'hi', at: 10 } }).effects[0], { do: 'pick', hash: null }, 'words that name none: the pick is cleared');
  assert.equal(enter({ said, named: H, kept: { hash: OTHER, at: 20 } }).state.review!.hash, OTHER, 'a pick made after the prompt stands');
  assert.equal(enter({ said, named: H, kept: { hash: OTHER, at: 5 } }).state.review!.hash, H, 'the prompt is newer than the pick');
  assert.equal(enter({ kept: { hash: 'cccccccccccc', at: 20 } }).state.review!.hash, H, 'a pick no longer pending: the newest');
  const replaced = enter({ said, named: H, replaced: { old: OTHER, hash: H } });
  assert.deepEqual(replaced.say, { to: 'allow', text: `sub-human: proposal ${OTHER} was replaced by ${H}; opening ${H} for bob` });
  // the person asked to propose something: no review, unless their words name a pending hash
  const propose = enter({ said: { text: 'propose to alice: ship v4', at: 10 }, propose: true });
  assert.deepEqual([propose.state.review, propose.say && propose.say.to], [null, 'context']);
  assert.equal(enter({ said: { text: `propose to alice: ${H.slice(0, 6)} again`, at: 10 }, propose: true, named: H }).state.review!.phase, 'entering');
  // a review of the proposal the note waits on supersedes the note; another proposal's note stays
  assert.equal(review.reduce({ review: null, note: note('waiting') }, EVENTS.enter, ctx).state.note, null);
  assert.ok(review.reduce({ review: null, note: note('waiting', { hash: OTHER }) }, EVENTS.enter, ctx).state.note);
  // not reviewable (plan mode already, bypass, clear-context) or nothing viewable: Claude Code's own plan mode
  assert.deepEqual(shape(enter({ reviewable: false })), ['none', null, '']);
  assert.deepEqual(shape(enter({ pending: [] })), ['none', null, '']);
});

test('enter / entered: the plan file is backed up (saved) before the proposal is written, and only once', () => {
  const s = review.reduce({ review: null, note: null }, EVENTS.enter, ctx);
  assert.deepEqual(s.effects[0], { do: 'save', review: { ...s.state.review, file: plan.file, backup: plan.text, restored: false } });
  assert.deepEqual(s.effects[1], { do: 'writePlan', file: plan.file, hash: H, early: true });
  assert.deepEqual(review.reduce(s.state, EVENTS.entered, ctx).effects, [], 'written at Pre already');
  const none = review.reduce({ review: null, note: null }, { ...EVENTS.enter, plan: { file: null, text: null } } as Event, ctx);
  assert.deepEqual(none.effects, [], 'no path known yet: Post(EnterPlanMode) or Pre(ExitPlanMode) does it');
  // a review left behind on the same file: its backup goes back first, and is the new review's backup too
  const left: Review = { ...REVIEWS.shown!, backup: 'the person\'s plan' };
  const again = review.reduce({ review: left, note: null }, { ...EVENTS.enter, plan: { file: plan.file, text: TEXT } }, ctx);
  assert.deepEqual(again.effects.slice(0, 2), [{ do: 'restorePlan', file: plan.file, backup: 'the person\'s plan' }, { do: 'save', review: again.state.review }]);
  assert.equal(again.state.review!.backup, 'the person\'s plan');
  const failed = review.reduce(s.state, { type: 'planFailed', early: true }, ctx);
  assert.deepEqual([failed.state.review!.phase, 'file' in failed.state.review!], ['entering', false], 'a failed early write is forgotten');
});

test('exit: the hook\'s proposal is the dialog whatever the call carries; a plan of the model\'s own is never shown', () => {
  const from = (e: Partial<Extract<Event, { type: 'exit' }>>, r = REVIEWS.entering) => review.reduce({ review: r, note: null }, { ...EVENTS.exit, ...e } as Event, ctx);
  const ok = from({});
  assert.deepEqual(ok.say, { to: 'ask', text: review.SAY.dialog('bob', H, 'alice', 'default'), show: { plan: H } });
  assert.equal(ok.state.review!.foreign, undefined);
  assert.equal(ok.state.review!.backup, 'old plan');
  assert.equal(from({ ownPlan: '# My refactor\n' }).state.review!.foreign, true, 'the model\'s own input');
  assert.equal(from({ callPlan: '# My refactor\n' }).state.review!.foreign, true, 'the plan file holds the model\'s plan');
  assert.equal(from({ callPlan: 'old plan' }).state.review!.foreign, undefined, 'what the file held before: the person\'s');
  assert.equal(from({ callPlan: TEXT, ownPlan: `the room proposal ${H.slice(0, 8)}.` }).state.review!.foreign, undefined, 'the proposal, and a stub');
  // nothing to show, or no plan file: the review closes (the card instead)
  const gone = from({ shown: null });
  assert.deepEqual([gone.state.review!.phase, gone.state.review!.said], ['exiting', review.SAY.nothingToShow(H)]);
  assert.deepEqual([from({ plan: { file: null, text: null } }).state.review!.card], [H]);
  // showEarly wrote another file: it goes back first; the backup of the file shown is the one kept at Pre
  const early: Review = { ...REVIEWS.entering!, file: '/plans/old.md', backup: 'person', restored: false };
  assert.deepEqual(from({}, early).effects.map(e => e.do), ['restorePlan', 'save', 'writePlan']);
  assert.equal(from({}, { ...early, file: plan.file }).state.review!.backup, 'person');
  // the same call again (a re-run of Pre): the same dialog
  assert.deepEqual(shape(review.reduce({ review: REVIEWS.shown, note: null }, { ...EVENTS.exit, toolUseId: 'tu1' }, ctx)), ['shown', 'ask', '']);
});

test('the dialog closed: a note opens the note (nothing recorded), Esc nothing, an answer not on disk yet is unread', () => {
  const close = (answer: { note: string | null } | null, t: typeof target | null = target) => review.reduce({ review: REVIEWS.shown, note: null }, { ...EVENTS.stop, answer, target: t }, ctx);
  const noted = close({ note: 'clamp at 100' });
  assert.deepEqual(noted.state.note, { hash: H, note: 'clamp at 100', from: 'alice', title: 'Ship v3 Monday', at: 5000, stage: 'waiting' });
  assert.equal(noted.state.review!.said, review.SAY.noted('bob', H));
  assert.deepEqual(noted.effects, [], 'nothing recorded');
  assert.equal(close({ note: '  ' }).state.review!.said, review.SAY.closed('bob', H));
  assert.equal(close({ note: 'x' }, null).state.review!.said, review.SAY.stale(H), 'no longer this seat\'s to answer');
  const unread = close(null);
  assert.deepEqual([unread.state.review!.unread, unread.state.review!.resolved], [true, undefined]);
  // the closing Post reads it last: none at all is no answer
  const post = review.reduce({ review: unread.state.review, note: null }, { ...EVENTS.exited, toolUseId: 'tu9', answer: null }, ctx);
  assert.match(review.textOf((post.say as { parts: review.Part[] }).parts, () => '', false), new RegExp(`^bob closed the review of proposal ${H} without answering`));
});

test('exited: a Yes records Agree only for the text unedited; a changed mode is set back; a stale one records nothing', () => {
  const yes = (e: Partial<Extract<Event, { type: 'exited' }>>) => review.reduce({ review: REVIEWS.shown, note: null }, { ...EVENTS.exited, ...e } as Event, ctx);
  assert.deepEqual(yes({}).effects[0], { do: 'answer', hash: H, choice: 'Agree' });
  for (const response of [{ plan: TEXT, edited: true, isAgent: false, filePath: undefined }, { plan: TEXT + 'x', edited: false, isAgent: false, filePath: undefined }]) {
    const r = yes({ response });
    assert.deepEqual([r.effects.map(e => e.do), (r.say as { parts: unknown[] }).parts[0]], [['restorePlan'], review.SAY.edited('bob', H)]);
  }
  assert.deepEqual(yes({ target: null }).effects.map(e => e.do), ['restorePlan']);
  const mode = yes({ mode: 'acceptEdits' });
  assert.deepEqual([mode.state.review!.phase, mode.state.review!.restored], ['restore', true]);
  // then: enter allows silently; a Stop once the mode is back clears it
  assert.equal(review.reduce(mode.state, { ...EVENTS.stop, mode: 'default' }, ctx).state.review, null);
});

test('exited with no review shown: the model is told nothing was recorded; the person\'s own plan is theirs', () => {
  const post = (e: Partial<Extract<Event, { type: 'exited' }>>) => review.reduce({ review: null, note: null }, { ...EVENTS.exited, ...e } as Event, ctx);
  const theirs = [{ hash: H, from: 'alice', viewable: true }];
  const told = post({ pending: theirs });
  assert.deepEqual(told.effects, [{ do: 'pick', hash: H }]);
  assert.match((told.say as { parts: string[] }).parts[0], /Nothing recorded for [0-9a-f]{12}: no review opened, so bob did not answer \(don't say they did\)/);
  assert.match((post({ pending: [{ ...theirs[0], viewable: false }] }).say as { parts: string[] }).parts[0], /call AskUserQuestion with "proposal /, 'not viewable: the card');
  assert.deepEqual(post({ pending: theirs, response: { ...EVENTS.exited.response, isAgent: true } }).say, null, 'a subagent\'s plan');
  // bob's own pending proposal, unedited: his signoff
  assert.deepEqual(post({ pending: [{ hash: H, from: 'bob', viewable: true }] }).effects, [{ do: 'answer', hash: H, choice: 'Agree' }]);
  assert.deepEqual(post({ proposed: true }).say, null, 'already in the room');
  assert.match((post({}).say as { parts: string[] }).parts[0], /call the room propose tool with \{text: <the plan>\}/);
});

test('ask: a join request, then the handoff, then a waiting note, then the proposals the call names', () => {
  const ask = (e: Partial<Extract<Event, { type: 'ask' }>>, note: Confirm | null = null) => review.reduce({ review: null, note }, { ...EVENTS.ask, ...e } as Event, ctx);
  assert.deepEqual(ask({ admit: 'abcdefabcdef', handoff: true }).say, { to: 'ask', text: '', show: { admit: 'abcdefabcdef' } });
  assert.deepEqual(ask({ handoff: true, noteNamed: true }, note('waiting')).say, { to: 'ask', text: '', show: { handoff: true } });
  assert.deepEqual(ask({ noteNamed: true }, note('waiting')).say, { to: 'ask', text: review.SAY.noteAsk('bob', H), show: { note: true } });
  assert.deepEqual(ask({ reviewable: false }).say, { to: 'ask', text: `room proposal ${H}`, show: { card: [H] } });
  assert.deepEqual(ask({ hit: [{ ...pending[0], viewable: false }] }).say!.to, 'ask', 'too long for the plan view: the card');
  assert.deepEqual(ask({ hit: [] }).say, null, 'a question about something else');
});

test('answered: the consent card records each Agree/Object, says Not yet, and nothing at all for an AFK close', () => {
  const answered = (e: Partial<Extract<Event, { type: 'answered' }>>) => review.reduce({ review: null, note: null }, { ...EVENTS.answered, ...e } as Event, ctx);
  const four = answered({ answers: [
    { hash: H, answer: { kind: 'answer', label: 'Object', notes: 'why' }, live: true },
    { hash: 'cccccccccccc', answer: { kind: 'answer', label: 'Not yet' }, live: true },
    { hash: 'dddddddddddd', answer: { kind: 'other', label: 'maybe' }, live: true },
    { hash: OTHER, answer: { kind: 'answer', label: 'Agree' }, live: false },
  ] });
  assert.deepEqual(four.effects, [{ do: 'answer', hash: H, choice: 'Object', notes: 'why' }]);
  const text = review.textOf((four.say as { parts: review.Part[] }).parts, h => `[${h}]`, true);
  assert.equal(text, `${review.SAY.recorded} [${H}] ${review.SAY.notYet('bob', 'cccccccccccc')} ${review.SAY.noChoice('dddddddddddd')} ${review.SAY.stale(OTHER)} Return to what you were doing.`);
  assert.equal(review.textOf((four.say as { parts: review.Part[] }).parts, h => `[${h}]`, false).startsWith(`[${H}]`), true, 'Recorded only when one was');
  assert.deepEqual((answered({ afk: true }).say as { parts: string[] }).parts, [review.SAY.cardNoAnswer('bob')]);
  assert.deepEqual(answered({ answers: [], asked: false }).say, null, 'not a consent card');
});

test('words: every line the model is told is short; the mechanic per phase is one line', () => {
  const lines: string[] = [];
  const call = (v: unknown) => (typeof v === 'function' ? v('bob', H, 'default', 'default') : v);
  for (const v of Object.values(review.SAY)) lines.push(String(call(v)));
  for (const v of Object.values(review.NEXT)) lines.push(String(call(v)));
  lines.push(review.showNote('bob', H), review.showNote('bob', H, true));
  for (const l of lines) assert.ok(l.length <= 280, `${l.length}: ${l}`);
  for (const l of Object.values(review.NEXT).map(call)) assert.ok(String(l).length <= 100, String(l));
});

test('words: the note\'s and review\'s longest lines stay under 160 characters with a 7-letter name; a composed text is capped', () => {
  const n = 'tristan', h = 'abcdef012345';
  const lines = {
    noted: review.SAY.noted(n, h), nudge: review.SAY.nudge(n, h), renudge: review.SAY.renudge(n, h),
    reoffer: review.SAY.reoffer(n, h, true), reofferUnshown: review.SAY.reoffer(n, h, false),
    unshown: review.SAY.unshown(n, h, `"proposal ${h}"`),
  };
  for (const [k, s] of Object.entries(lines)) {
    assert.ok(s.length < 160, `${k} is ${s.length}: ${s}`);
    if (k !== 'unshown') assert.ok(s.includes(`call AskUserQuestion with "objection ${h}"`), `${k} still names the card's call`);
  }
  assert.match(lines.reoffer, /Esc was no answer, not a decline/, 'the Esc is said to be no answer');
  assert.match(lines.unshown, /don't say they did/, 'the model is told not to claim an answer');
  const long = review.textOf(Array.from({ length: 20 }, () => lines.noted), () => '', false);
  assert.equal(long.length, review.SAY_MAX);
  assert.ok(long.endsWith('…'));
});
