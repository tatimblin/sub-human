/**
 * plugin/sub-human/lib/remote/link-connect.ts: how this machine reaches a room hosted elsewhere, from its link file
 * (lib/room/links.ts): the transport an invite's locator names, the hello with the link's credential, and what a
 * refused dial means. The link daemon (lib/remote/link.ts) dials with connectLink; the join flows (lib/remote/joining.ts,
 * lib/commands/*) and the handoff make locators and transports with the rest.
 *
 *   connectLink(code) -> Promise<Client>   hello over the link file's transport (lib/remote/client.ts): with the token,
 *       or the invite once (with its PIN for an sh2 one), or {login: true} for a login link; a short code's
 *       enrollment runs first when the link file holds one (lib/remote/enroll.ts enrollLink). A token the hello gave
 *       replaces the invite and its PIN in the link file, so a redial never sends the PIN again; an invite the host
 *       refused (AUTH) is scrubbed with its PIN (refused: {at, reason}). caps {ping: true}
 *   keyRefused(linkFile, transport, err) -> Promise<err'>   a dial of an ssh link with its own key and a token that ssh
 *       refused (classify: denied, publickey: the host revoked the key, `/sub-human kick`) is AUTH KEY_REVOKED, so the
 *       daemon stops; before the token (the host has not let it in yet) it stays OFFLINE; anything else is err
 *   loginRefused(linkFile, transport, err, code) -> Promise<err'>   a login link's ssh gave up for a reason only the
 *       person can fix (lib/remote/transports/ssh.ts loginProblem): AUTH with that reason, so the daemon stops and the
 *       join says what to run, instead of redialing a door that stays shut; anything else is err
 *   pipeLocator(home?) -> 'pipe:<home>'   an invite's locator for a room hosted under that home on this machine (the
 *       demo's S11 and the tests: not a kind people use)
 *   sshLocator(dest, {via}?) -> 'ssh:user@host[:port][?via=JUMP]' | null   null: not a plain user@host[:port]
 *   transportOf(locator) -> Spec | null   the link file's transport for an invite's locator: the transport registry's
 *       parse (lib/remote/transports/index.ts)
 *   sshCommand(spec, code, opts?) -> [cmd, ...args]   the ssh command line (lib/remote/transports/ssh.ts command)
 */

import * as linksMod from '../room/links.ts';
import * as homeMod from '../home.ts';
import * as storeMod from '../room/store.ts';
import * as config from '../config.ts';
import { RoomError } from '../room/validate.ts';
import { isReason } from '../reasons.ts';
import type { Reason } from '../reasons.ts';
import { createRequire } from 'node:module';
import type { Client } from './client.ts';
import type { CodedError } from './types-core.ts';
import type { SshSpec } from './types-rest.ts';
import type { Link } from '../room/types.ts';

const require = createRequire(import.meta.url);

/** A transport as connectLink opens it (lib/remote/transports/*): ssh's keeps its stderr. */
type TransportLike = { stderr?(): string } | null | undefined;

const transports = (): typeof import('./transports/index.ts') => require('./transports/index.ts');
const ssh = (): typeof import('./transports/ssh.ts') => require('./transports/ssh.ts');
const clientMod = (): typeof import('./client.ts') => require('./client.ts');
const enrollMod = (): typeof import('./enroll.ts') => require('./enroll.ts');

const pipeLocator = (h: string = homeMod.home()): string => `pipe:${h}`;
const sshLocator = (dest: string, opts?: { via?: string }): string | null => ssh().locator(dest, opts);
const transportOf = (locator: string): ReturnType<typeof import('./transports/index.ts')['parse']> => transports().parse(locator);
const sshCommand = (t: SshSpec, code: string, opts?: string[]): string[] => ssh().command(t, code, opts);

/** A link the host refused before it held a token: drop the invite, its PIN and the pending rebind; say why. */
function scrubRefused(code: string, reason: unknown, why: Reason | null | undefined): void {
  try {
    const cur: Link | null = linksMod.get(code);
    if (!cur || cur.token) return;
    const { invite, pin, rebind, enroll, awaiting, ...rest } = cur;
    linksMod.set(code, { ...rest, refused: { at: new Date().toISOString(), reason: String(reason).slice(0, 300), ...(why ? { why } : {}) } });
  } catch { /* the stop reason still says it */ }
}

async function connectLink(code: string): Promise<Client> {
  let l: Link | null = linksMod.get(code);
  if (!l) throw new RoomError('AUTH', `this machine has no link to room ${code} any more`, 'TOKEN_UNKNOWN');
  if (!l.token && typeof l.invite !== 'string' && l.enroll) { // a short code: the PAKE first (lib/remote/enroll.ts)
    await enrollMod().enrollLink(code);
    l = linksMod.get(code) as Link; // enrollLink keeps the link file (it threw otherwise)
  }
  const login = !!l.transport && 'login' in l.transport && l.transport.login === true; // a link over the person's own ssh login: no invite
  if (!l.token && typeof l.invite !== 'string' && !login) {
    const was = l.refused && isReason(l.refused.why) ? l.refused.why : 'INVITE_USED';
    throw new RoomError('AUTH', `the host refused this link's invite${l.refused && l.refused.reason ? ` (${l.refused.reason})` : ''}; ask the host for a new one`, was);
  }
  const kind = l.transport && l.transport.kind;
  if (!transports().get(kind)) throw new RoomError('PROTOCOL', `unknown transport "${kind}" (${transports().kinds().join(', ')})`);
  const cred = l.token ? { token: l.token } : login ? { login: true } : { invite: l.invite, ...(typeof l.pin === 'string' ? { pin: l.pin } : {}) };
  const epoch = storeMod.open(code).hostState().epoch;
  const opts = { machine: homeMod.machineId(), helloMs: config.LINK_HELLO_MS, caps: { ping: true }, epoch, ...cred };
  const t = transports().open(l.transport, { code });
  let c: Client;
  try { c = await clientMod().connect(t, opts); } catch (err) {
    const e = err as CodedError;
    // the host refused the invite (a wrong PIN, burnt, used, expired): it and its PIN are spent here too, so the link
    // file keeps no secret in clear (a new join writes a fresh one)
    if (!l.token && !login && e && e.code === 'AUTH') scrubRefused(code, e.message, e.reason);
    throw login ? await loginRefused(l, t, e, code) : await keyRefused(l, t, e);
  }
  if (!l.token) {
    const { invite, pin, awaiting, ...rest } = l; // an sh2 invite's PIN is spent with it
    linksMod.set(code, { ...rest, token: c.token!, ...(rest.moved ? { moved: { ...rest.moved, reached_at: new Date().toISOString() } } : {}) }); // c.token: hello gives one for an invite or a login
  }
  return c;
}

/** ssh's last words come just after its exit: its stderr once they are in, or null for a transport without one. */
async function stderrOf(t: TransportLike | Promise<TransportLike>): Promise<string | null> {
  const tr = await Promise.resolve(t).catch(() => null);
  if (!tr || typeof tr.stderr !== 'function') return null;
  await new Promise(r => setTimeout(r, 100));
  return tr.stderr();
}

async function keyRefused(l: Link, t: TransportLike | Promise<TransportLike>, e: CodedError | null | undefined): Promise<CodedError | null | undefined> {
  if (!e || e.code !== 'OFFLINE' || !l.token || !l.transport || l.transport.kind !== 'ssh' || !l.transport.key) return e;
  const err = await stderrOf(t);
  const p = err === null ? null : ssh().classify(err);
  return p && p.kind === 'denied' && p.publickey
    ? new RoomError('AUTH', 'the host no longer accepts this link\'s ssh key (it was revoked); ask the host for a new invite', 'KEY_REVOKED')
    : e;
}

async function loginRefused(l: Link, t: TransportLike | Promise<TransportLike>, e: CodedError | null | undefined, code: string): Promise<CodedError | null | undefined> {
  if (!e || e.code !== 'OFFLINE' || l.transport.kind !== 'ssh') return e; // a login link is ssh
  const err = await stderrOf(t);
  const why = err === null ? null : ssh().loginProblem(err, l.transport, code);
  return why ? new RoomError('AUTH', why.message, why.reason) : e;
}

export { connectLink, keyRefused, loginRefused, pipeLocator, sshLocator, transportOf, sshCommand };
