/**
 * plugin/sub-human/lib/remote/link-connect.ts: how this machine reaches a room hosted elsewhere, from its link file
 * (lib/room/links.ts): the transport an invite's locator names, the hello with the link's credential, and what a
 * refused dial means. The link daemon (lib/remote/link.ts) dials with connectLink; the join flows (lib/remote/joining.ts,
 * lib/commands/*) and the handoff make locators and transports with the rest.
 *
 *   connectLink(code) -> Promise<Client>   hello over the link file's transport (lib/remote/client.ts): with the token,
 *       or the invite once (with its PIN for an sh2 one), or {login: true} for a login link. An invite line's SECRET
 *       (protocol 3, lib/remote/invite-secret.ts) goes only to the host its tag names: over the web the listener's key
 *       is fetched (transports/ws.ts fetchKey), checked against the tag and pinned before the Noise handshake; over
 *       ssh and a pipe the host proves its machine key over a nonce first (client.ts checkHost). Either way a host that
 *       does not hold the named key gets nothing: AUTH HOST_KEY_MISMATCH. Then the hello carries the SECRET, the PIN
 *       when the person typed it, and as {name: join_as, label}; what the host answers is kept in the link file:
 *       PIN_NEEDED / PIN_WRONG / PIN_THROTTLED -> pin_wanted (the PIN dropped, the line kept: the join asks again),
 *       ADMIT_WAITING -> awaiting {ref, check} (the PIN dropped: it held), a token -> the invite dropped. A web link's
 *       own Noise key (linkKey) rides on every connection (XK) once its file names it. A token the hello gave replaces
 *       the invite and its PIN in the link file, so a redial never sends the PIN again; an invite the host refused
 *       (AUTH) is scrubbed with its PIN (refused: {at, reason}). caps {ping: true}. The hello carries this home's
 *       machine key's proof (lib/remote/machine-key.ts): the host records the machine id the key gives and the reply
 *       says it; it is kept (home.ts setMachineIn) and every later hello reports it (home.ts machineIn)
 *   keyRefused(linkFile, transport, err) -> Promise<err'>   a dial of an ssh link with its own key (one an admit let in
 *       before protocol 3) and a token that ssh refused (classify: denied, publickey: the host revoked the key, `/sub-human
 *       kick`) is AUTH KEY_REVOKED, so the daemon stops; anything else is err
 *   loginRefused(linkFile, transport, err, code) -> Promise<err'>   a login link's ssh gave up for a reason only the
 *       person can fix (lib/remote/transports/ssh.ts loginProblem): AUTH with that reason, so the daemon stops and the
 *       join says what to run, instead of redialing a door that stays shut; anything else is err
 *   linkKey(code, {fresh?}) -> {priv, pub}   the link's own Noise key (X25519, <home>/links/<code>/client-x25519.json,
 *       0600), made once; fresh: a new one (a new invite's link)
 *   joinerLabel() -> string           this machine's short host name, as the host's card shows it (not trusted)
 *   pipeLocator(home?) -> 'pipe:<home>'   an invite's locator for a room hosted under that home on this machine (the
 *       demo's S11 and the tests: not a kind people use)
 *   sshLocator(dest, {via}?) -> 'ssh:user@host[:port][?via=JUMP]' | null   null: not a plain user@host[:port]
 *   transportOf(locator) -> Spec | null   the link file's transport for an invite's locator: the transport registry's
 *       parse (lib/remote/transports/index.ts)
 *   sshCommand(spec, code, opts?) -> [cmd, ...args]   the ssh command line (lib/remote/transports/ssh.ts command)
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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
const noiseMod = (): typeof import('./noise.ts') => require('./noise.ts');
const secretMod = (): typeof import('./invite-secret.ts') => require('./invite-secret.ts');
const wsMod = (): typeof import('./transports/ws.ts') => require('./transports/ws.ts');
const machineKeyMod = (): typeof import('./machine-key.ts') => require('./machine-key.ts');

const pipeLocator = (h: string = homeMod.home()): string => `pipe:${h}`;
const sshLocator = (dest: string, opts?: { via?: string }): string | null => ssh().locator(dest, opts);
const transportOf = (locator: string): ReturnType<typeof import('./transports/index.ts')['parse']> => transports().parse(locator);
const sshCommand = (t: SshSpec, code: string, opts?: string[]): string[] => ssh().command(t, code, opts);

/** A link the host refused before it held a token: drop the invite, its PIN and the pending rebind; say why. */
function scrubRefused(code: string, reason: unknown, why: Reason | null | undefined): void {
  try {
    const cur: Link | null = linksMod.get(code);
    if (!cur || cur.token) return;
    const { invite, pin, rebind, pin_wanted, awaiting, ...rest } = cur;
    linksMod.set(code, { ...rest, refused: { at: new Date().toISOString(), reason: String(reason).slice(0, 300), ...(why ? { why } : {}) } });
  } catch { /* the stop reason still says it */ }
}

/** What an invite line's host answered, kept in the link file (see the header); false: not one of those answers. */
function keepAnswer(code: string, e: CodedError, word: { secret: Buffer }, sentPin: boolean, ownKey: string | null = null): boolean {
  const cur: Link | null = linksMod.get(code);
  if (!cur || cur.token) return false;
  const { pin, pin_wanted, ...rest } = cur;
  const at = new Date().toISOString();
  if (e.code === 'AUTH' && (e.reason === 'PIN_NEEDED' || e.reason === 'PIN_WRONG' || e.reason === 'PIN_THROTTLED')) {
    const left = /\(([0-9]+) (?:PIN )?tr(?:y|ies) left\)/.exec(String(e.message)); // the host's wording, any version
    linksMod.set(code, { ...rest, pin_wanted: { at, ...(left ? { left: Number(left[1]) } : {}), ...(e.reason !== 'PIN_NEEDED' ? { why: e.reason, message: String(e.message).slice(0, 300) } : {}) } });
    return true;
  }
  if (e.code === 'OFFLINE' && e.reason === 'ADMIT_WAITING') {
    if (sentPin || !cur.awaiting) {
      const ref = secretMod().admissionRef(word.secret);
      // the check the host's card shows: this machine's proven id and, over the web, this link's own key
      const check = secretMod().joinCheck(machineKeyMod().idOf(machineKeyMod().publicKey()), ownKey);
      linksMod.set(code, { ...rest, awaiting: cur.awaiting || { at, ref, check, expires_at: new Date(Date.now() + config.ADMIT_TTL_MS).toISOString() } });
    }
    return true;
  }
  return false;
}

const keyFile = (code: string): string => path.join(linksMod.dirOf(code), 'client-x25519.json');
/** The link's own Noise key (made once; fresh: a new one, for a new invite's link). */
function linkKey(code: string, { fresh = false }: { fresh?: boolean } = {}): import('./noise.ts').KeyPair {
  if (fresh) fs.rmSync(keyFile(code), { force: true });
  fs.mkdirSync(linksMod.dirOf(code), { recursive: true, mode: 0o700 });
  return noiseMod().loadOrCreateStatic(keyFile(code));
}

/**
 * This machine's short name, for the host's card ("carol on carols-mbp"): what the joiner says, never trusted.
 * SUB_HUMAN_MACHINE_LABEL names it instead of the host name (a machine whose host name says nothing, a demo).
 */
function joinerLabel(env: NodeJS.ProcessEnv = process.env): string {
  const n = String(env.SUB_HUMAN_MACHINE_LABEL || os.hostname() || '').split('.')[0].replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 64);
  return /^[A-Za-z0-9._-]{1,64}$/.test(n) ? n : 'a-machine';
}

const isWeb = (t: Link['transport']): t is import('./types-rest.ts').WsSpec => t.kind === 'ws' || t.kind === 'wss';
const mismatch = (what: string): RoomError => new RoomError('AUTH', `${what} is not the one the invite line names: someone may be in between, or the line is for another host. Nothing secret was sent; check the line with the host before you try again`, 'HOST_KEY_MISMATCH');

async function connectLink(code: string): Promise<Client> {
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
    : typeof l.invite === 'string' ? { invite: l.invite, ...(typeof l.pin === 'string' ? { pin: l.pin } : {}) }
    : { login: true };
  const epoch = storeMod.open(code).hostState().epoch;
  // machine: this machine's id in the room (the host's, once it said one); machineKey: the proof the host derives it from
  // an invite line's hello proves the machine key over the host's challenge (a proof good in that session only)
  const signMachine = word ? (challenge: string) => machineKeyMod().proofFor(code, challenge) : undefined;
  const opts = { machine: homeMod.machineIn(code), machineKey: machineKeyMod().proof(code), helloMs: config.LINK_HELLO_MS, caps: { ping: true }, epoch, ...(checkHost ? { checkHost } : {}), ...(signMachine ? { signMachine } : {}), ...cred };
  const own = isWeb(l.transport) && l.transport.clientKey ? linkKey(code) : undefined; // XK: this link's own key
  const t = transports().open(l.transport, { code, ...(own ? { clientKey: own } : {}) });
  let c: Client;
  try { c = await clientMod().connect(t, opts); } catch (err) {
    const e = err as CodedError;
    // an invite line's PIN steps: kept in the link file (the join asks for the PIN again, or waits for the card)
    if (word && e && keepAnswer(code, e, word, sentPin, own ? own.pub.toString('base64url') : null)) throw e;
    // the host refused the invite (a wrong PIN, burnt, used, expired): it and its PIN are spent here too, so the link
    // file keeps no secret in clear (a new join writes a fresh one)
    if (!l.token && typeof l.invite === 'string' && e && e.code === 'AUTH') scrubRefused(code, e.message, e.reason);
    throw login ? await loginRefused(l, t, e, code) : await keyRefused(l, t, e);
  }
  if (c.machine && c.machine !== homeMod.machineIn(code)) homeMod.setMachineIn(code, c.machine);
  if (!l.token) {
    const cur = linksMod.get(code) || l;
    const { invite, pin, awaiting, pin_wanted, ...rest } = cur; // the invite and its PIN are spent with it
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

export { connectLink, keyRefused, loginRefused, linkKey, joinerLabel, pipeLocator, sshLocator, transportOf, sshCommand };
