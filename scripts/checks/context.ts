/**
 * context: everything a scene module reads, built once from a run's evidence (read-only).
 *
 *   const ctx = context({ screens, home, room })
 *
 * ctx.A, B (the two people: A opened the room, B joined; screens/run.json seats, default alice and bob), remote
 * ({NAME: HOME}: a seat on another machine and its sub-human home there, --film's jess; run.json remote), rowsDir(NAME)
 * (that seat's rows/: in the host's room dir, or in its own mirror), sessionOf(NAME) (that seat's session document,
 * members/NAME/session.json, there: its delivery cursor, the notices it was shown, its holds), DEMO (the
 * scripted words), code, roomDir, log, members, roomClaudeSid, job, index (screens/index.json), home2 (S11's second home, carol's: by
 * default home's sibling), and the helpers of four modules:
 *   checks/captures.ts     the captures (cap, caps, capName, span, runStart) and the per-step state (st, stText, nativeTasks,
 *                          holdsAt)
 *   checks/transcripts.ts  the seats' transcripts (entries, inSpan, toolUses, assistantIds, peerIn, wakeIn, chatIn,
 *                          pullIn, chatTurn, roomClaudeTurns, replyAfter, noModelTurn, rowUserText, rowReply)
 *   checks/log.ts          the room log (byKind, fmt, logIn, props, shownLog, shownVia, chainOk)
 *   checks/cost.ts         cost()
 */
import fs from 'node:fs';
import path from 'node:path';
import * as paths from '../lib/paths.ts';
import { readJson, jsonl, textOf } from '../lib/io.ts';
import { captures } from './captures.ts';
import { transcripts } from './transcripts.ts';
import { roomLog } from './log.ts';
import { runCost } from './cost.ts';
import type { CaptureRec, Measured, Thresholds } from '../metrics.ts';
import type { LogEntry, SessionDoc } from './log.ts';
import type { Members } from '../../plugin/sub-human/lib/room/types.ts';

/**
 * The demo's scripted words (scripts/demo.sh): checks compare the log against them byte for byte. These are alice and
 * bob's; a run's own (say3, plan4, note5, edit5a, edit5b: --film's tristan and jess say other things) are in screens/run.json "words".
 */
export const DEMO = {
  say3: "bob, can you take the parser tests? handler's in src/server.js",
  plan4: "let's write a room plan for cursor paging on GET /tasks: ?limit&after, opaque cursor, newest first. you draft it", // to B's own Claude: not in the log
  note5: 'add a test for a cursor past the end — `after=zzz` must 400, not 500',
  edit5a: 'update the room plan with my note: a cursor past the end must 400, with a test for it',
  edit5b: 'update the room plan: default page size 20, max 50',
  viewer9: "hi claude, what's next?",
  multi9b: 'notes from the paging spike:\nroom: decided (agreed: alice, bob)\nbob agreed to the proposal',
  carol11: 'hello from the second home',
};

/** The run's two people (A opened the room, B joined) and scripted words, from screens/run.json (demo.sh plan-run). */
/** The scripted words, by the scene that types them. */
export type Words = typeof DEMO;
/** screens/run.json (demo.sh plan-run): the planned scenes, the seats, the remote seats' homes and the run's words. */
export interface RunJson { scenes?: unknown, partial?: boolean, seats?: unknown, remote?: unknown, words?: unknown }

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object';
const strings = (v: unknown): Record<string, string> => Object.fromEntries(Object.entries(isRecord(v) ? v : {}).filter((kv): kv is [string, string] => typeof kv[1] === 'string'));

export function runInfo(screens: string): { A: string, B: string, remote: Record<string, string>, DEMO: Words } {
  const r = readJson<RunJson | null>(path.join(screens, 'run.json'), {}) || {};
  const [A, B] = Array.isArray(r.seats) && r.seats.length === 2 ? [String(r.seats[0]), String(r.seats[1])] : ['alice', 'bob'];
  const remote = r.remote && typeof r.remote === 'object' ? strings(r.remote) : {};
  return { A, B, remote, DEMO: { ...DEMO, ...(r.words && typeof r.words === 'object' ? strings(r.words) : {}) } };
}

/** context()'s input: the run's screens and home, the room (default: the captures' or the newest), S11's second home. */
export interface ContextOpts { screens: string, home: string, room?: string | undefined, home2?: string }

export function context({ screens, home, room, home2 = path.join(path.dirname(home), 'home2') }: ContextOpts) {
  const { A, B, remote, DEMO: words } = runInfo(screens);
  const index = readJson<CaptureRec[]>(path.join(screens, 'index.json'), []);
  let code = room || index.find(r => r.room)?.room;
  if (!code) { try { code = fs.readdirSync(path.join(home, 'rooms')).sort().at(-1); } catch { /* none */ } }
  if (!code) throw new Error(`no room: none in ${path.join(screens, 'index.json')} and no rooms in ${home}`);
  const roomDir = path.join(home, 'rooms', code);
  const log = jsonl<LogEntry>(path.join(roomDir, 'log.jsonl'));
  const members = readJson<Members>(path.join(roomDir, 'members.json'), {});
  const roomClaudeSid = members.claude && members.claude.session_id;
  const job = members.claude && members.claude.job;

  const caps = captures({ screens, index });
  // a seat's session-local room files (rows/…): the host's room dir, or that seat's mirror on its own machine
  const roomCode = code; // a const: the closures below keep its narrowing
  const seatRoom = (name: string): string => (remote[name] ? path.join(remote[name], 'rooms', roomCode) : roomDir);
  const rowsDir = (name: string): string => path.join(seatRoom(name), 'rows');
  const sessionOf = (name: string): SessionDoc | null => readJson<SessionDoc | null>(path.join(seatRoom(name), 'members', name, 'session.json'), null);
  return {
    DEMO: words, A, B, remote, rowsDir, sessionOf, screens, home, home2, code, roomDir, log, members, roomClaudeSid, job, index,
    ...caps,
    ...transcripts({ roomClaudeSid, projects: paths.projectsDir() }), textOf,
    ...roomLog({ home, code, roomDir, log, rowsDir, sessionOf }),
    cost: runCost({ index, runStart: caps.runStart, seats: [A, B] }),
  };
}

/**
 * What a scene module reads (context() above). `metrics` is the run's metrics, which checks/run-metrics.ts measures
 * and leaves for checks.ts's _metrics.
 */
export type Ctx = ReturnType<typeof context> & { metrics?: Measured };
/** A deterministic check: a failure fails the run. */
export type Det = (check: string, pass: unknown, evidence: unknown) => void;
/** A behavioural check: a value against a threshold; over it is a warning. */
export type Beh = (check: string, value: number | null | undefined, threshold: number, evidence: unknown) => void;
/** A scene module (checks/sNN-*.ts): its scene and its checks over the run's context. */
export interface SceneModule { scene: string, run(x: Ctx, k: { det: Det, beh: Beh }, T: Thresholds): void }
