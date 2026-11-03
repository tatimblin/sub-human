/**
 * plugin/sub-human/lib/commands/answer.ts: the verbs' answers (types.ts Answer) and the words they share.
 *
 *   say(text, debug?) / refused(text, debug?) / secret(text, {refused, debug}?) -> Answer; failure(e, msg): a host
 *                               step's throw (a lock: "Room busy. Try again.", the path for the debug log)
 *   HELP_HINT, USAGE            the pointer to /sub-human help, and the bare command's usage
 *   hostOnly(cur, what) -> Identity | string   the seat, when a host-only verb can run in this session; else why
 *                               not (no seat, or the room is hosted elsewhere)
 */
import * as identity from '../identity.ts';
import { errCode } from '../errors.ts';
import type { Answer, Pinned } from './types.ts';
import type { Identity } from '../identity.ts';

export const say = (text: string, debug?: string): Answer => ({ kind: 'say', text, ...(debug ? { debug } : {}) });
export const refused = (text: string, debug?: string): Answer => ({ kind: 'refused', text, ...(debug ? { debug } : {}) });
export const secret = (text: string, { refused: r = false, pinned, debug }: { refused?: boolean; pinned?: Pinned; debug?: string | undefined } = {}): Answer => ({ kind: 'secret', text, refused: r, ...(pinned ? { pinned } : {}), ...(debug ? { debug } : {}) });

/** A host step that threw, as a refusal: a lock that did not hold (lib/lock.ts "could not acquire PATH") is one plain
 * line, its path the debug log's; anything else its message. */
export const failure = (e: unknown, msg: string): Answer => (/^could not acquire /.test(msg) || errCode(e) === 'LOCK'
  ? refused('Room busy. Try again.', msg) : refused(msg));

export const HELP_HINT = 'All commands: /sub-human help';
export const USAGE: string = `usage: /sub-human [NAME] joins or opens a room. ${HELP_HINT}`;

export const hostOnly = (cur: Identity | null, what: string): Identity | string => (!cur ? `join a room first (/sub-human); then /sub-human ${what}.`
  : !identity.isHost(cur.code) ? `room ${cur.code} is hosted on another machine; only its host can do that.` : cur);
