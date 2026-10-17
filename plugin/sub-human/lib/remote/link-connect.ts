/**
 * plugin/sub-human/lib/remote/link-connect.ts: how this machine reaches a room hosted elsewhere, from its link file
 * (lib/room/links.ts): the transport an invite's locator names, the hello with the link's credential, and what a
 * refused dial means. The link daemon (lib/remote/link.ts) dials with connectLink; the join flows (lib/remote/joining.ts,
 * lib/commands/*) make locators and transports with the rest.
 *
 * connectLink: an invite line's SECRET (invite-secret.ts) goes only to the host its tag names: over the web the
 * listener's key is fetched (transports/ws.ts fetchKey), checked against the tag and pinned before the Noise
 * handshake; over ssh and a pipe the host proves its machine key over a nonce first (client.ts checkHost). A host that
 * does not hold the named key gets nothing: AUTH HOST_KEY_MISMATCH. The host's answers are kept in the link file:
 * PIN_NEEDED / PIN_WRONG / PIN_THROTTLED -> pin_wanted (the PIN dropped, the line kept: the join asks again),
 * ADMIT_WAITING -> awaiting {ref, check} (the PIN held). A token replaces the invite and its PIN, so a redial never
 * sends the PIN again; an invite the host refused (AUTH) is scrubbed with its PIN, so the link file keeps no secret in
 * clear. The machine id the host derives from this home's machine key is kept (home.ts setMachineIn).
 *
 * loginRefused: a login link's ssh gave up for a reason only the person can fix (ssh.ts loginProblem) becomes AUTH, so
 * the daemon stops and the join says what to run instead of redialing a door that stays shut. joinerLabel is what the
 * joiner says it is called, never trusted.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as linksMod from '../room/links.ts';
import * as homeMod from '../home.ts';
import * as config from '../config.ts';
import { envStr } from '../env.ts';
import { RoomError } from '../room/validate.ts';
import { isReason, reasonOf } from '../reasons.ts';
import { errCode, msgOf } from '../errors.ts';
import type { Reason } from '../reasons.ts';
import type { Client } from './client.ts';
import type { Link } from '../room/types.ts';
import type { RoomCode } from '../brand.ts';
import type * as TransportsMod from './transports/index.ts';
import type * as SshMod from './transports/ssh.ts';
import type * as ClientMod from './client.ts';
import type * as NoiseMod from './noise.ts';
import type * as InviteSecretMod from './invite-secret.ts';
import type * as WsMod from './transports/ws.ts';
import type * as MachineKeyMod from './machine-key.ts';
import type * as TypesRestMod from './types-rest.ts';
import { lazy } from '../io.ts';


/** A transport as connectLink opens it (lib/remote/transports/*): ssh's keeps its stderr. */
type TransportLike = { stderr?(): string } | null | undefined;

// each transport and the client only for the link that uses them (start cost: the hooks load this file)
const transports = lazy<typeof TransportsMod>(import.meta.url, './transports/index.ts');
const ssh = lazy<typeof SshMod>(import.meta.url, './transports/ssh.ts');
const clientMod = lazy<typeof ClientMod>(import.meta.url, './client.ts');
const noiseMod = lazy<typeof NoiseMod>(import.meta.url, './noise.ts');
const secretMod = lazy<typeof InviteSecretMod>(import.meta.url, './invite-secret.ts');
const wsMod = lazy<typeof WsMod>(import.meta.url, './transports/ws.ts');
const machineKeyMod = lazy<typeof MachineKeyMod>(import.meta.url, './machine-key.ts');

const pipeLocator = (h: string = homeMod.home()): string => `pipe:${h}`;
const sshLocator = (dest: string, opts?: { via?: string }): string | null => ssh().locator(dest, opts);
const transportOf = (locator: string): ReturnType<typeof TransportsMod['parse']> => transports().parse(locator);

/** A link the host refused before it held a token: drop the invite, its PIN and the pending rebind; say why. */
function scrubRefused(code: RoomCode, reason: unknown, why: Reason | null | undefined): void {
  try {
    const cur: Link | null = linksMod.get(code);
    if (!cur || cur.token) return;
    const { invite, pin, rebind, pin_wanted, awaiting, ...rest } = cur;
    linksMod.set(code, { ...rest, refused: { at: new Date().toISOString(), reason: String(reason).slice(0, 300), ...(why ? { why } : {}) } });
  } catch { /* the stop reason still says it */ }
}

/** What an invite line's host answered, kept in the link file (see the header); false: not one of those answers. */
function keepAnswer(code: RoomCode, e: unknown, word: { secret: Buffer }, sentPin: boolean, ownKey: string | null = null): boolean {
  const cur: Link | null = linksMod.get(code);
  if (!cur || cur.token) return false;
  const { pin, pin_wanted, ...rest } = cur;
  const at = new Date().toISOString();
  const why = reasonOf(e);
  if (errCode(e) === 'AUTH' && (why === 'PIN_NEEDED' || why === 'PIN_WRONG' || why === 'PIN_THROTTLED')) {
    const left = /\(([0-9]+) (?:PIN )?tr(?:y|ies) left\)/.exec(msgOf(e)); // the host's wording, any version
    linksMod.set(code, { ...rest, pin_wanted: { at, ...(left ? { left: Number(left[1]) } : {}), ...(why !== 'PIN_NEEDED' ? { why, message: msgOf(e).slice(0, 300) } : {}) } });
    return true;
  }
  if (errCode(e) === 'OFFLINE' && why === 'ADMIT_WAITING') {
    if (sentPin || !cur.awaiting) {
      const ref = secretMod().admissionRef(word.secret);
      // the check the host's card shows: this machine's proven id and, over the web, this link's own key
      const check = secretMod().joinCheck(machineKeyMod().idOf(machineKeyMod().publicKey()), ownKey);
      linksMod.set(code, { ...rest, awaiting: cur.awaiting ?? { at, ref, check, expires_at: new Date(Date.now() + config.ADMIT_TTL_MS).toISOString() } });
    }
    return true;
  }
  return false;
}

const keyFile = (code: RoomCode): string => path.join(linksMod.dirOf(code), 'client-x25519.json');
/** The link's own Noise key (made once; fresh: a new one, for a new invite's link). */
function linkKey(code: RoomCode, { fresh = false }: { fresh?: boolean } = {}): NoiseMod.KeyPair {
  if (fresh) fs.rmSync(keyFile(code), { force: true });
  fs.mkdirSync(linksMod.dirOf(code), { recursive: true, mode: 0o700 });
  return noiseMod().loadOrCreateStatic(keyFile(code));
}

/**
 * This machine's short name, for the host's card ("carol on carols-mbp"): what the joiner says, never trusted.
 * SUB_HUMAN_MACHINE_LABEL names it instead of the host name (a machine whose host name says nothing, a demo).
 */
function joinerLabel(env: NodeJS.ProcessEnv = process.env): string {
  const [first = ''] = String(envStr('SUB_HUMAN_MACHINE_LABEL', env) || os.hostname() || '').split('.'); // split gives at least one part
  const n = first.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 64);
  return /^[A-Za-z0-9._-]{1,64}$/.test(n) ? n : 'a-machine';
}

const isWeb = (t: Link['transport']): t is TypesRestMod.WsSpec => t.kind === 'ws' || t.kind === 'wss';
const mismatch = (what: string): RoomError => new RoomError('AUTH', `${what} is not the one the invite line names: someone may be in between, or the line is for another host. Nothing secret was sent; check the line with the host before you try again`, 'HOST_KEY_MISMATCH');

async function connectLink(code: RoomCode): Promise<Client> {
  let l: Link | null = linksMod.get(code);
  if (!l) throw new RoomError('AUTH', `this machine has no link to room ${code} any more`, 'TOKEN_UNKNOWN');
  const login = !!l.transport && 'login' in l.transport && l.transport.login === true; // a link over the person's own ssh login: no invite
  if (!l.token && typeof l.invite !== 'string' && !login) {
    const was = l.refused && isReason(l.refused.why) ? l.refused.why : 'INVITE_USED';
    throw new RoomError('AUTH', `the host refused this link's invite${l.refused && l.refused.reason ? ` (${l.refused.reason})` : ''}; ask the host for a new one`, was);
  }
  const kind = l.transport && l.transport.kind;
  if (!transports().get(kind)) throw new RoomError('PROTOCOL', `unknown transport "${kind}" (${transports().kinds().join(', ')})`);
  // an invite line's SECRET goes only to the host its tag names (see the header)
  const word = !l.token && typeof l.invite === 'string' ? secretMod().decode(l.invite) : null;
  if (word && isWeb(l.transport) && !l.transport.hostKey) {
    const key = await wsMod().fetchKey(l.transport);
    if (!secretMod().keyHolds(word, 'listener', key)) { const e = mismatch(`the web listener's key (${key.slice(0, 12)}…)`); scrubRefused(code, e.message, e.reason); throw e; }
    l = linksMod.set(code, { ...l, transport: { ...l.transport, hostKey: key } });
  }
  const checkHost = word && !isWeb(l.transport) ? (host: { key: string; sig: string } | null, nonce: string) => {
    if (!host) throw new RoomError('PROTOCOL', 'the host\'s sub-human proves no key (an older one): ask the host to update (/plugin update sub-human) and invite again', 'SKEW');
    const key = machineKeyMod().verifyHost(host, code, nonce);
    if (!key || !secretMod().keyHolds(word, 'machine', key)) throw mismatch('the host\'s machine key');
  } : undefined;
  const sentPin = !!word && typeof l.pin === 'string';
  // an invite before the login: an invite line over ssh rides the person's own login, and still goes through its PIN
  // and the host person's card (a login link would be the account owner's, with neither)
  const cred = l.token ? { token: l.token }
    : word ? { invite: l.invite, ...(sentPin ? { pin: l.pin } : {}), ...(l.join_as ? { as: { name: l.join_as, label: joinerLabel() } } : {}) }
    : { login: true };
  // machine: this machine's id in the room (the host's, once it said one); machineKey: the proof the host derives it from
  // an invite line's hello proves the machine key over the host's challenge (a proof good in that session only)
  const signMachine = word ? (challenge: string) => machineKeyMod().proofFor(code, challenge) : undefined;
  const opts = { machine: homeMod.machineIn(code), machineKey: machineKeyMod().proof(code), helloMs: config.LINK_HELLO_MS, caps: { ping: true }, ...(checkHost ? { checkHost } : {}), ...(signMachine ? { signMachine } : {}), ...cred };
  const own = isWeb(l.transport) && l.transport.clientKey ? linkKey(code) : undefined; // XK: this link's own key
  const t = transports().open(l.transport, { code, ...(own ? { clientKey: own } : {}) });
  let c: Client;
  try { c = await clientMod().connect(t, opts); } catch (e) {
    // an invite line's PIN steps: kept in the link file (the join asks for the PIN again, or waits for the card)
    if (word && keepAnswer(code, e, word, sentPin, own ? own.pub.toString('base64url') : null)) throw e;
    // the host refused the invite (a wrong PIN, burnt, used, expired): it and its PIN are spent here too, so the link
    // file keeps no secret in clear (a new join writes a fresh one)
    if (!l.token && typeof l.invite === 'string' && errCode(e) === 'AUTH') scrubRefused(code, msgOf(e), reasonOf(e));
    throw login ? await loginRefused(l, t, e, code) : e;
  }
  if (c.machine && c.machine !== homeMod.machineIn(code)) homeMod.setMachineIn(code, c.machine);
  if (!l.token) {
    const cur = linksMod.get(code) ?? l;
    const { invite, pin, awaiting, pin_wanted, ...rest } = cur; // the invite and its PIN are spent with it
    // the host's card may have let this machine in under another name than it asked for (its own sits there from
    // another machine): the seat takes the one the link is bound to
    const as = c.as && typeof rest.join_as === 'string' && c.as !== rest.join_as ? { join_as: c.as, join_renamed: rest.join_as } : {};
    linksMod.set(code, { ...rest, ...as, ...(c.token ? { token: c.token } : {}) }); // c.token: hello gives one for an invite or a login
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

/** What connect threw (e, anything), or AUTH with why when ssh says why a login link cannot work yet. */
async function loginRefused(l: Link, t: TransportLike | Promise<TransportLike>, e: unknown, code: RoomCode): Promise<unknown> {
  if (errCode(e) !== 'OFFLINE' || l.transport.kind !== 'ssh') return e; // a login link is ssh
  const err = await stderrOf(t);
  const why = err === null ? null : ssh().loginProblem(err, l.transport, code, { first: !l.token });
  return why ? new RoomError('AUTH', why.message, why.reason) : e;
}

export { connectLink, loginRefused, linkKey, joinerLabel, pipeLocator, sshLocator, transportOf };
