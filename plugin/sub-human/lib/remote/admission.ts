/**
 * plugin/sub-human/lib/remote/admission.ts: the host person's consent to a machine that typed an invite's PIN. The PIN
 * proved only that the joiner knows it (lib/remote/enroll.ts); nothing gets in until a person on the host answers "Let
 * in" on the card their own Claude Code shows (hooks/handlers/consent.ts, like the handoff card: only the answer on the card as
 * the hooks built it counts, never the model's), or runs `sub-human admit REF` in a shell (headless hosts), or types
 * `/sub-human admit REF`. Then, over ssh, the joiner's link key gets the forced-command line for its one link
 * (lib/remote/shim.ts authorizedLine), and the joiner's link redeems its admission secret (check, below, from
 * lib/remote/invites.ts redeemInvite). The room's tail on the host wakes the seat's Claude to open the card once
 * (lib/tail.ts); a request nobody answers lapses after ADMIT_TTL_MS.
 *
 * The records (kept in the host document remote/invites, keyed by the admission secret's sha256, like an invite):
 *   check(record, {machine, linkId?, now}) -> {err, next?}   may it redeem: once let in, on its machine, before
 *       admitted_until (OFFLINE ADMIT_WAITING before the person answered; AUTH ADMIT_REFUSED / ADMIT_LAPSED /
 *       ADMIT_REVOKED / ADMIT_LATE / INVITE_USED after)
 *   admissions(store, {now?, all?}) -> [{slot, ref, ...record}]   the requests waiting (all: every one), oldest first
 *   decide(store, ref, {decision: 'let-in' | 'refused', by?, sig?, now?}) -> record   the person's answer
 *   lapseAdmissions(store, {now?}) -> [record]   burn the requests nobody answered in ADMIT_TTL_MS
 *   WAITING   the words of a request not answered yet
 *
 *   pending(code, {now?}) -> [request]        the requests waiting (admissions): {ref, name, label, machine, key,
 *                                              kind, by, link, expires_at, told?}
 *   find(code, ref) -> request | null         any request of the room with that ref (answered or not)
 *   targets(code, req) -> [name]              whose card asks: req.by when that seat is in the room on this machine,
 *                                              else every person seated here
 *   describe(req) -> "carol (SHA256:…) on carols-mbp"   for ssh the link key's fingerprint, else "request 3f9c2a"
 *   question(req, code) -> string             the card's question (it names the ref)
 *   card(req, code) -> AskUserQuestion input  LET_IN / REFUSE
 *   letIn(code, ref, {by?, sign?, now?}) -> {id, text}   the person's yes: the record let in (signed with their seat key
 *                                              when sign is given), over ssh the key line written to the door's
 *                                              authorized_keys file, a room line
 *   refuse(code, ref, {by?, now?}) -> {text}  the person's no: burnt, a room line
 *   markTold(code, ref, name)                 the tail woke name's Claude for it
 *   lapse(code, {now?}) -> [request]          requests past their time, burnt now (the tail tells the host)
 *   LET_IN, REFUSE
 */

import path from 'node:path';
import { INVITES_KEY } from './invites.ts';
import { RoomError } from '../room/validate.ts';
import { HANDOFF_INVITE_MS } from '../config.ts';
import { createRequire } from 'node:module';
import type { AdmissionRecord, AuthStore, CodedError, InviteRecord, Invites } from './types-core.ts';
import type { RoomStore } from '../room/types.ts';
import type { Card } from '../types-app.ts';

const require = createRequire(import.meta.url);

/** A record with where it is: its kv key (slot) and ref. */
type Slotted<T> = T & { slot: string; ref: string };
/** A join request waiting for the host person (admissions): the admission record, with its slot and ref. */
type AdmissionRequest = Slotted<AdmissionRecord>;
const iso = (now: number): string => new Date(now).toISOString();
const REF_RE = /^[0-9a-f]{12}$/;
const WAITING = 'waiting for the host to let this machine in';

// ---------- the records (in the host document remote/invites, beside the invites: lib/remote/invites.ts) ----------
/** An admission record's redemption (lib/remote/invites.ts redeemInvite): {err, next?} (err null: it may redeem). */
function check(inv: AdmissionRecord, { machine, linkId, now }: { machine: string; linkId?: string; now: number }): { next?: AdmissionRecord; err: CodedError | null } {
  const no = (msg: string, reason: ConstructorParameters<typeof RoomError>[2]) => new RoomError('AUTH', msg, reason);
  if (inv.used_at) return { err: no('this machine\'s join was used already; ask the host for a new invite', 'INVITE_USED') };
  if (inv.admit === 'refused') return { err: no('the host refused to let this machine in', 'ADMIT_REFUSED') };
  if (inv.burnt_at) {
    return { err: inv.admit === 'lapsed' ? no('the host did not let this machine in in time; ask them for a new invite', 'ADMIT_LAPSED')
      : no('the host revoked this join; ask them for a new invite', 'ADMIT_REVOKED') };
  }
  if (inv.machine !== machine) return { err: no('this join is for another machine', 'INVITE_OTHER_MACHINE') };
  if (linkId !== undefined && inv.link !== linkId) return { err: no('this join is for another connection', 'INVITE_OTHER_LINK') };
  if (inv.admit !== 'let-in') {
    if (now > Date.parse(inv.expires_at)) return { err: no('the host did not let this machine in in time; ask them for a new invite', 'ADMIT_LAPSED') }; // lapseAdmissions burns it, with a line
    return { err: new RoomError('OFFLINE', `${WAITING}; the link keeps trying`, 'ADMIT_WAITING') };
  }
  if (now > Date.parse(inv.admitted_until!)) return { err: no('this machine was let in, but did not connect in time; ask the host for a new invite', 'ADMIT_LATE'), next: { ...inv, burnt_at: iso(now) } }; // admitted_until: set with 'let-in' (decide)
  return { err: null };
}

/** The admission records of this room still waiting for the host person (all: every one), oldest first. */
function admissions(store: AuthStore, { now = Date.now(), all = false }: { now?: number; all?: boolean } = {}): AdmissionRequest[] {
  return Object.entries((store.kv.get(INVITES_KEY, null) || {}) as Invites)
    .filter((e): e is [string, AdmissionRecord] => { const i = e[1]; return !!(i && i.admission && (all || (i.admit === 'asked' && !i.burnt_at && now <= Date.parse(i.expires_at)))); })
    .map(([k, i]) => ({ ...i, slot: k, ref: k.slice(0, 12) }))
    .sort((a, b) => a.created_at.localeCompare(b.created_at));
}

/**
 * The host person's answer to an admission: 'let-in' (the joiner may redeem it for HANDOFF_INVITE_MS) or 'refused'
 * (burnt). AUTH when it is not waiting any more (answered, lapsed, revoked).
 */
function decide(store: AuthStore, ref: string, { decision, by = null, sig = null, now = Date.now() }: {
  decision: 'let-in' | 'refused'; by?: string | null; sig?: unknown; now?: number;
}): AdmissionRequest {
  if (!store.isHost) throw new RoomError('HOST_ONLY', 'only the host of a room lets machines in');
  let out = null as AdmissionRequest | null; // (as: set in the update)
  store.kv.update(INVITES_KEY, (cur: Invites | null) => {
    const hit = Object.keys(cur || {}).filter(k => REF_RE.test(String(ref)) && k.startsWith(ref) && cur![k].admission); // cur: k is a key of it
    if (hit.length !== 1) throw new RoomError('AUTH', `room ${store.code} has no join request ${ref} (/sub-human admit lists them)`);
    const inv = cur![hit[0]] as AdmissionRecord; // hit: keys of admission records
    if (inv.admit !== 'asked' || inv.burnt_at) throw new RoomError('AUTH', `that join request was ${inv.admit === 'let-in' ? 'let in already' : inv.admit === 'refused' ? 'refused already' : 'withdrawn (revoked or lapsed)'}`);
    if (now > Date.parse(inv.expires_at)) throw new RoomError('AUTH', 'that join request lapsed; send them a new invite (/sub-human invite)', 'ADMIT_LAPSED');
    const at = iso(now);
    const next: AdmissionRecord = decision === 'let-in'
      ? { ...inv, admit: 'let-in', admitted_at: at, admitted_by: by, ...(sig ? { admit_sig: sig } : {}), admitted_until: iso(now + HANDOFF_INVITE_MS) }
      : { ...inv, admit: 'refused', refused_at: at, refused_by: by, burnt_at: at };
    out = { ...next, slot: hit[0], ref: hit[0].slice(0, 12) };
    return { ...cur, [hit[0]]: next };
  });
  return out!; // the update ran (or threw)
}

/** Mark lapsed (burn) every admission past its time that nobody answered; the records that lapsed now. */
function lapseAdmissions(store: AuthStore, { now = Date.now() }: { now?: number } = {}): AdmissionRequest[] {
  let lapsed: AdmissionRequest[] = [];
  const due = (i: InviteRecord | null | undefined) => !!i && !!i.admission && i.admit === 'asked' && !i.burnt_at && now > Date.parse(i.expires_at);
  if (!Object.values((store.kv.get(INVITES_KEY, null) || {}) as Invites).some(due)) return lapsed; // a read, no lock, on every tail tick
  store.kv.update(INVITES_KEY, (cur: Invites | null) => {
    lapsed = [];
    const next: Invites = { ...cur };
    for (const [k, i] of Object.entries(cur || {})) {
      if (i && i.admission && due(i)) {
        const rec: AdmissionRecord = { ...i, admit: 'lapsed', burnt_at: iso(now) };
        next[k] = rec;
        lapsed.push({ ...rec, slot: k, ref: k.slice(0, 12) });
      }
    }
    return lapsed.length ? next : undefined;
  });
  return lapsed;
}

/** Signs the record the person let in with their seat key. */
type Signer = (rec: { kind: 'admit'; ref: string; link: string; key: string | null; machine: string }) => unknown;

const LET_IN = 'Let in';
const REFUSE = 'Refuse';

const roomLib = (): typeof import('../room.ts') => require('../room.ts');
const hostStore = (code: string): RoomStore => roomLib().hostStore(code, { what: 'only its host can let people in' });

const pending = (code: string, { now = Date.now() }: { now?: number } = {}): AdmissionRequest[] => admissions(hostStore(code), { now });
const find = (code: string, ref: string): AdmissionRequest | null => admissions(hostStore(code), { all: true }).find(r => r.ref === ref || (ref && ref.length >= 6 && r.ref.startsWith(ref))) || null;

function targets(code: string, req: AdmissionRequest): string[] {
  const identity: typeof import('../identity.ts') = require('../identity.ts');
  const { isMine }: typeof import('../home.ts') = require('../home.ts');
  const here = Object.values(identity.readMembers(code) || {})
    .filter(m => !!m && !!m.name && !m.left_at && m.role !== 'claude' && (!m.machine || isMine(m.machine))).map(m => m.name);
  return req.by && here.includes(req.by) ? [req.by] : here;
}

const sshkeysMod = (): typeof import('./sshkeys.ts') => require('./sshkeys.ts');
const fp = (req: AdmissionRequest): string => (req.key ? sshkeysMod().fingerprint(req.key) : `request ${req.ref.slice(0, 6)}`);
const describe = (req: AdmissionRequest): string => `${req.name} (${fp(req)}) on ${req.label || 'another machine'}`;
const question = (req: AdmissionRequest, code: string): string => `Let ${describe(req)} join room ${code}? (admit ${req.ref})`;

function card(req: AdmissionRequest, code: string): Card {
  return {
    questions: [{
      question: question(req, code),
      header: 'Join',
      multiSelect: false,
      options: [
        { label: LET_IN, description: `${req.name} typed your PIN from another machine (names are what they say; ${fp(req)} is what their screen shows). Let in: that machine joins room ${code} and can post only as the people it brings. Undo any time: /sub-human kick ${req.name}.` },
        { label: REFUSE, description: 'Nothing gets in; their join stops. The invite is used up either way.' },
      ],
    }],
  };
}


function letIn(code: string, ref: string, { by = null, sign = null, now = Date.now() }: {
  by?: string | null; sign?: Signer | null; now?: number;
} = {}): { id: string; text: string } {
  const store = hostStore(code);
  const req = find(code, ref);
  if (!req) throw new RoomError('INVALID', `room ${code} has no join request ${ref} (/sub-human admit lists them)`);
  const sig = sign ? sign({ kind: 'admit', ref: req.ref, link: req.link, key: req.key || null, machine: req.machine }) : null;
  let file: string | null = null;
  if (req.kind === 'ssh' && req.admit === 'asked') {
    // the key line first, then the record: a failed write leaves the request waiting, not let in without a key
    const sshkeys = sshkeysMod();
    const { shim, h } = (require('./hosting.ts') as typeof import('./hosting.ts')).shimReady();
    const key = sshkeys.openssh(req.key!); // an ssh request carries the joiner's link key (enroll.ts joinerOf)
    file = path.resolve(req.door_file || sshkeys.authorizedKeysFile());
    sshkeys.appendAuthorized(file, shim.authorizedLine(code, req.link, key, h), key);
  }
  let rec: AdmissionRequest;
  try { rec = decide(store, req.ref, { decision: 'let-in', by, sig, now }); } catch (e) {
    if (file && req.admit === 'asked') sshkeysMod().removeAuthorized(file, code, req.link);
    throw e;
  }
  roomLib().roomLine(store, `${by || 'the host'} let ${describe(rec)} in; undo with: /sub-human kick ${rec.name}`);
  return { id: rec.link, text: `let in: ${describe(rec)} joins room ${code} within seconds${file ? ` (their key opens only this room, nothing else on this machine)` : ''}. Undo: /sub-human kick ${rec.name}` };
}

function refuse(code: string, ref: string, { by = null, now = Date.now() }: { by?: string | null; now?: number } = {}): { text: string } {
  const store = hostStore(code);
  const req = find(code, ref);
  if (!req) throw new RoomError('INVALID', `room ${code} has no join request ${ref} (/sub-human admit lists them)`);
  const rec = decide(store, req.ref, { decision: 'refused', by, now });
  roomLib().roomLine(store, `${by || 'the host'} refused ${describe(rec)}: nothing got in`);
  return { text: `refused: ${describe(rec)} does not get into room ${code}; their join stops` };
}

function markTold(code: string, ref: string, name: string): void {
  try {
    hostStore(code).kv.update(INVITES_KEY, (cur: Invites | null) => {
      const docs = cur || {};
      const k = Object.keys(docs).find(x => x.startsWith(ref) && docs[x].admission);
      const rec = k ? docs[k] : null;
      if (!k || !rec || !rec.admission || (rec.told || []).includes(name)) return undefined;
      return { ...cur, [k]: { ...rec, told: [...(rec.told || []), name] } };
    });
  } catch { /* told again */ }
}

const lapse = (code: string, { now = Date.now() }: { now?: number } = {}): AdmissionRequest[] => lapseAdmissions(hostStore(code), { now });

export {
  check, admissions, decide, lapseAdmissions, WAITING, pending, find, targets, describe, question, card, letIn, refuse, markTold, lapse, LET_IN, REFUSE,
};
export type { Signer, Slotted, AdmissionRequest };
