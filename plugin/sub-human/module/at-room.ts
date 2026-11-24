// at-room: `@room TEXT` typed at my prompt posts my exact words to the room as mine, with no model turn (R8). It is the
// only way a person's line reaches the room, so the only way one wakes a colleague's Claude (R10): `@room bob, …`
// names bob. The prompt never reaches my Claude; one line says where it went. The daemon takes a person's post only
// from a session of theirs here (core/api.ts refusedAppend), and the secret filter applies as to every post.
import type { On } from 'claude-code';
import type { AppendDraft, RoomState } from '../core/entries.js';
import { LIMITS } from '../core/entries.js';
import type { Result } from '../core/result.js';
import { err, ok } from '../core/result.js';
import { secretIn } from '../core/secrets.js';
import { answer, request } from './bridge.js';
import type { InRoom } from './session.js';
import { session } from './session.js';

export const AT_ROOM: RegExp = /^@room\s/;
type Post = Extract<AppendDraft, { kind: 'post' }>;

/** The post an `@room` prompt is, or why there is none. A member's name leading the words is `to`. */
export function roomLine(text: string, room: InRoom, state: RoomState | null, id: string): Result<Post> {
  const words = text.replace(AT_ROOM, '').trim();
  if (!words) return err('nothing was sent: type your words after @room.');
  if (words.length > LIMITS.text) return err(`nothing was sent: it is over ${LIMITS.text} characters.`);
  const rule = secretIn(words);
  if (rule) return err(`nothing was sent: it looks like it holds a secret (${rule}). Type it without the secret.`);
  const first = /^@?([\w.-]+?)[,:]?(?:\s|$)/.exec(words)?.[1]?.toLowerCase();
  const to = state?.members.find(m => !m.kicked && m.name !== room.name && m.name.toLowerCase() === first)?.name;
  return ok({ kind: 'post', id, from: room.name, by: 'person', text: words, ...(to !== undefined && { to }) });
}

export function registerAtRoom(on: On): void {
  on('prompt.submit', { origin: { kind: 'composer' } }, async ($, e, next) => {
    if (e.command || !AT_ROOM.test(e.text)) return next(e);
    const room = session.room;
    if (!room) return { drop: "sub-human: you're in no room, so nothing was sent. /sub-human joins one." };
    const line = roomLine(e.text, room, session.state, crypto.randomUUID());
    if (!line.ok) return { drop: `sub-human: ${line.error}` };
    const q = request({ op: 'append', code: room.code, draft: line.value }, room.home);
    const r = await $.http.fetch(q.url, q).then(x => answer('append', x), (x: unknown) => err(String(x).slice(0, 200)));
    const to = line.value.to;
    return { drop: r.ok ? `sub-human: sent to ${room.code}${to ? `, to ${to}` : ''}.` : `sub-human didn't send that to ${room.code}: ${r.error}` };
  });
}
