/**
 * plugin/sub-human/lib/room/options.ts: a hosted room's options, the host document `options` (host-only, never streamed).
 * Only the host person sets them, in their own shell (`sub-human options CODE NAME on|off`, lib/cli/main.ts; the Bash
 * guard refuses it to a model). Every option is off by default.
 *
 *   login-same-person   a seat that joins over the host account's own ssh login (`/sub-human join USER@HOST ROOM`) is
 *                       the host person's own: its account is the host's (lib/remote/server.ts join), so consent counts
 *                       it as one person with the host's seats (lib/proposal.ts sameOf). Off: each such seat is its own
 *                       person, as an invite's is (on a shared login, everyone who has it would answer as the owner)
 *
 *   get(store) -> {login-same-person?: true}
 *   set(store, name, on) -> options   RoomError INVALID for another name, HOST_ONLY on a mirror
 *   loginSamePerson(store) -> bool
 *   NAMES   the option names
 */
import { RoomError } from './validate.ts';
import type { RoomStore } from './types.ts';

type Store = Pick<RoomStore, 'kv' | 'isHost' | 'code'>;
const KEY = 'options';
const NAMES = ['login-same-person'] as const;
type Name = typeof NAMES[number];
type Options = Partial<Record<Name, true>>;

const get = (store: Pick<RoomStore, 'kv'>): Options => { try { return store.kv.get(KEY, null) || {}; } catch { return {}; } };

function set(store: Store, name: string, on: boolean): Options {
  if (!store.isHost) throw new RoomError('HOST_ONLY', `room ${store.code} is hosted on another machine; its host sets its options`);
  if (!(NAMES as readonly string[]).includes(name)) throw new RoomError('INVALID', `no option "${name}" (${NAMES.join(', ')})`);
  const next = { ...get(store) };
  if (on) next[name as Name] = true; else delete next[name as Name];
  store.kv.set(KEY, next);
  return next;
}

const loginSamePerson = (store: Pick<RoomStore, 'kv'>): boolean => get(store)['login-same-person'] === true;

export { get, set, loginSamePerson, NAMES };
