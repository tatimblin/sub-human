// A verb's Ctx for a test: the daemon, the rooms and the session pointers from fake-daemon.ts, and git answering from
// a table instead of running.
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readConfig } from '../../config.js';
import type { Env } from '../../config.js';
import { fsSessions } from '../../commands/context.js';
import type { Ctx } from '../../commands/types.js';
import type { FakeHome } from './fake-daemon.js';

export interface TestCtxOptions {
  readonly session?: string;
  readonly cwd?: string;
  /** Each program's answer by its words, `git config --get user.name`; a missing one fails, as a missing program does. */
  readonly run?: Readonly<Record<string, string>>;
  readonly env?: Env;
  readonly now?: () => number;
  readonly nodeVersion?: string;
}

/** A fresh temp home (removed by the test helpers' root at exit). */
export function tempHome(): string {
  return fs.mkdtempSync(path.join(process.env.SUB_HUMAN_HOME ?? os.tmpdir(), 'home-'));
}

export const GIT_ALICE: Readonly<Record<string, string>> = {
  'git config --get user.name': 'Alice Liddell',
  'git rev-parse --show-toplevel': '/work/api',
  'git branch --show-current': 'main',
};

/** A session's Ctx in the fake's home. */
export function testCtx(fake: FakeHome, o: TestCtxOptions = {}): Ctx {
  const run = o.run ?? GIT_ALICE;
  const dir = fake.dir;
  return {
    config: readConfig({ SUB_HUMAN_HOME: dir, ...o.env }, dir),
    session: o.session ?? 'session-1',
    cwd: o.cwd ?? '/work/api',
    now: o.now ?? (() => 5_000),
    uuid: randomUUID,
    daemon: fake.daemon,
    rooms: fake.rooms,
    sessions: fsSessions(dir),
    run: (program, args) => Promise.resolve(run[[program, ...args].join(' ')] ?? null),
    readFile: rel => Promise.resolve(fs.readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8')),
    nodeVersion: o.nodeVersion ?? '24.11.1',
  };
}
