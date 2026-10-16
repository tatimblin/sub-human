/**
 * plugin/sub-human/lib/commands/index.ts: every /sub-human command, as a table {verb: (args, ctx) => Answer}
 * (types.ts). hooks/handlers/join.ts parses the hook's stdin, calls run() and renders the answer; the model never
 * chooses an identity, and nothing here writes output.
 *
 * One hidden rule, decided from the prompt alone before any parsing (mod/core/command.ts mayHoldSecret; hide()): a
 * `join`, `invite` or `admit` prompt, or one with a word of digits, may carry a PIN, so every say and refusal it gets
 * is a secret (the typed prompt is kept out of the conversation as well), whatever is wrong with it. A seat taken by a
 * prompt with a word of digits is not handed to the model in that step either: a bare /sub-human brings the room to
 * their Claude.
 * Then: OPEN verbs (help, doctor) run without the hooks module; every other needs this session's lease
 * (identity.modLeaseOk: the module's guard, prompt gate and delivery run), else noModule() says why. Any first word
 * not in TABLE is a NAME or a ROOM (join.ts named). A room Claude's seat takes no other command than its binding.
 */
import * as identity from '../identity.ts';
import * as contract from '../cc/contract.ts';
import * as bg from '../cc/bg.ts';
import * as ccEnv from '../cc/env.ts';
import { mayHoldSecret, hasPinWord } from '../../mod/core/command.ts';
import { refused, secret } from './answer.ts';
import { help } from './help.ts';
import { doctor } from './doctor.ts';
import { invite } from './invite.ts';
import { admit } from './admit.ts';
import { kick } from './kick.ts';
import { leave } from './leave.ts';
import { handoff } from './handoff.ts';
import { bare, bindRoomClaude, join, named } from './join.ts';
import type { Answer, VerbCtx, OpenVerb, Verb } from './types.ts';
import type { Identity } from '../identity.ts';

export const TABLE: Readonly<Record<string, Verb>> = Object.freeze({ '': bare, join, invite, admit, kick, leave, handoff });
export const OPEN: Readonly<Record<string, OpenVerb>> = Object.freeze({ help, doctor });

/** What run() knows of the session: VerbCtx without the seat, which it resolves (seat()) only once the lease checked. */
export type Session = Omit<VerbCtx, 'pid' | 'cur'> & { pid: number | null; seat(): Identity | null };

/** Why this session has no hooks module, in words the person can act on: an old Claude Code, its modules switched
 * off, else the doctor. */
export function noModule(pid: number | null): string {
  const cc = { ...contract, ...bg, ...ccEnv };
  let v: string | null = null;
  try { v = cc.runningVersion(pid); } catch { /* unknown */ }
  if (v && (cc.compareVersions(v, cc.MIN_VERSION) ?? 0) < 0) return `sub-human needs Claude Code ${cc.MIN_VERSION} or newer, and this is ${v}. Update it (claude update), restart claude, then type /sub-human again.`;
  let sw: boolean | undefined;
  try { sw = cc.modulesSwitch(); } catch { /* unknown */ }
  if (sw === false) return 'Claude Code has plugin hooks modules switched off for now, and sub-human needs them. Restart claude with network access, then type /sub-human again; /sub-human doctor says more.';
  return 'sub-human\'s hooks module isn\'t running in this session (safe mode, --bare, a managed policy or an untrusted folder turns it off). Run /sub-human doctor.';
}

function route(args: string[], s: Session): Answer {
  const [verb = '', ...rest] = args;
  const open = OPEN[verb];
  if (open) return open(rest, s); // read only: these work without the module, and a refusal below points to them
  if (!identity.modLeaseOk(s.sid, s.pid)) return refused(noModule(s.pid || identity.claudePid()));
  if (!s.pid) return refused('could not tell which Claude Code session this is. Run /sub-human doctor.');
  const ctx: VerbCtx = { ...s, pid: s.pid, cur: s.seat() };
  if (s.roomClaudeAgent) return bindRoomClaude(args, ctx);
  if (ctx.cur && ctx.cur.role === 'claude') return refused(`this session is the room's Claude of room ${ctx.cur.code}; join from another session.`);
  const v = Object.hasOwn(TABLE, verb) ? TABLE[verb] : null;
  return v ? v(rest, ctx) : named(args, ctx);
}

export const run = (args: string[], s: Session): Answer => hide(args, route(args, s));

/** The hidden rule (see the header), applied to what a verb answered for args. */
export function hide(args: string[], a: Answer): Answer {
  // decided from the prompt alone: a prompt that could carry a PIN is answered hidden, whatever went wrong with it
  const hidden = mayHoldSecret(args.join(' '));
  if (a.kind === 'joined') {
    if (!hasPinWord(args.join(' '))) return a;
    return secret(`${a.say} · type /sub-human to bring the room to your Claude`);
  }
  if (!hidden || a.kind === 'secret') return a;
  return secret(a.text, { refused: a.kind === 'refused' });
}
