/**
 * plugin/sub-human/lib/remote/admission.ts: the host person's consent to a machine that typed an invite line and its
 * PIN. The line and the PIN proved only that the joiner holds both (lib/remote/invites.ts); nothing gets in until a
 * person on the host answers "Let in" on the card their own Claude Code shows (hooks/handlers/consent.ts, like the
 * handoff card: only the answer on the card as the hooks built it counts, never the model's), or runs `sub-human admit
 * REF` in a shell (headless hosts), or types `/sub-human admit REF`. Then the joiner's link redeems its invite (check,
 * below, from lib/remote/invites.ts redeemInvite): on the machine its key proved, and over the web with the Noise key
 * its PIN's connection proved. Nothing is written outside the room's own store (no authorized_keys line). The room's
 * tail on the host wakes the seat's Claude to open the card once (lib/tail.ts); a request nobody answers lapses after
 * ADMIT_TTL_MS.
 *
 * The records (kept in the host document remote/invites, under invites.admissionSlot(secret)):
 *   check(record, {machine, linkId?, peerKey?, now}) -> {err, next?}   may it redeem: once let in, on its machine (the
 *       id its machine key proves), on its link (a login session's --link), with its key (a web one), before
 *       admitted_until (OFFLINE ADMIT_WAITING before the person answered; AUTH ADMIT_REFUSED / ADMIT_LAPSED /
 *       ADMIT_REVOKED / ADMIT_LATE / INVITE_USED / INVITE_OTHER_MACHINE / INVITE_OTHER_LINK / KEY_MISMATCH after)
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
 *   describe(req) -> "carol (check 3f9c-2a71) on carols-mbp"   the check of the machine whose key the PIN came with
 *                                              (invite-secret.ts joinCheck): the joiner's screen shows the same
 *   question(req, code) -> string             the card's question (it names the ref)
 *   taken(code, req) -> alt | null            the name the request asks for sits in the room from another machine (its
 *                                              key never moves there: the seat would be refused, "pinned to another
 *                                              key"): the free name to let it in as instead (NAME2, NAME3, …), else null
 *   card(req, code) -> AskUserQuestion input  LET_IN / REFUSE; for a taken name "Let in as ALT" / REFUSE
 *   letIn(code, ref, {by?, sign?, as?, now?}) -> {id, text}   the person's yes: the record let in (signed with their
 *                                              seat key when sign is given), a room line; a taken name is let in as its
 *                                              alt (as: the card's), which the joiner's hello then learns (lib/remote/server.ts)
 *   refuse(code, ref, {by?, now?}) -> {text}  the person's no: burnt, a room line
 *   markTold(code, {ref, name})               the tail woke name's Claude for it
 *   lapse(code, {now?}) -> [request]          requests past their time, burnt now (the tail tells the host)
 *   LET_IN, REFUSE
 */

import { INVITES_KEY } from './invites.ts';
import { RoomError } from '../room/validate.ts';
import { HANDOFF_INVITE_MS } from '../config.ts';
import { createRequire } from 'node:module';
import type { AdmissionRecord, AuthStore, InviteRecord, Invites } from './types-core.ts';
import type { RoomStore } from '../room/types.ts';
import type { Card } from '../types-app.ts';
import type { RoomCode, SeatName } from '../brand.ts';
import type * as RoomMod from '../room.ts';
import type * as InviteSecretMod from './invite-secret.ts';
import type * as IdentityMod from '../identity.ts';
import type * as HomeMod from '../home.ts';
import type * as TextMod from '../text.ts';

const require: <M>(id: string) => M = createRequire(import.meta.url);

/** A record with where it is: its kv key (slot) and ref. */
type Slotted<T> = T & { slot: string; ref: string };
/** A join request waiting for the host person (admissions): the admission record, with its slot and ref. */
type AdmissionRequest = Slotted<AdmissionRecord>;
const iso = (now: number): string => new Date(now).toISOString();
const REF_RE = /^[0-9a-f]{12}$/;
const WAITING = 'waiting for the host to let this machine in';

// ---------- the records (in the host document remote/invites, beside the invites: lib/remote/invites.ts) ----------
/** An admission record's redemption (lib/remote/invites.ts redeemInvite): {err, next?} (err null: it may redeem). */
function check(inv: AdmissionRecord, { machine, linkId, peerKey = null, now }: { machine: string; linkId?: string | undefined; peerKey?: string | null; now: number }): { next?: AdmissionRecord; err: RoomError | null } {
  const no = (msg: string, reason: ConstructorParameters<typeof RoomError>[2]) => new RoomError('AUTH', msg, reason);
  if (inv.used_at) return { err: no('this machine\'s join was used already; ask the host for a new invite', 'INVITE_USED') };
  if (inv.admit === 'refused') return { err: no('the host refused to let this machine in', 'ADMIT_REFUSED') };
  if (inv.burnt_at) {
    return { err: inv.admit === 'lapsed' ? no('the host did not let this machine in in time; ask them for a new invite', 'ADMIT_LAPSED')
      : no('the host revoked this join; ask them for a new invite', 'ADMIT_REVOKED') };
  }
  if (inv.machine !== machine) return { err: no('this join is for another machine', 'INVITE_OTHER_MACHINE') };
  if (linkId !== undefined && inv.link !== linkId) return { err: no('this join is for another connection', 'INVITE_OTHER_LINK') };
  // a web joiner's PIN came over a connection that proved its link's Noise key: only that key redeems it
  if (inv.kind === 'ws' && inv.key && inv.key !== peerKey) return { err: no('this join was let in for another key (its link file\'s); type the invite line again on the machine that typed it', 'KEY_MISMATCH') };
  if (inv.admit !== 'let-in') {
    if (now > Date.parse(inv.expires_at)) return { err: no('the host did not let this machine in in time; ask them for a new invite', 'ADMIT_LAPSED') }; // lapseAdmissions burns it, with a line
    return { err: new RoomError('OFFLINE', `${WAITING}; the link keeps trying`, 'ADMIT_WAITING') };
  }
  if (now > Date.parse(inv.admitted_until ?? '')) return { err: no('this machine was let in, but did not connect in time; ask the host for a new invite', 'ADMIT_LATE'), next: { ...inv, burnt_at: iso(now) } }; // admitted_until: set with 'let-in' (decide)
  return { err: null };
}

/** The admission records of this room still waiting for the host person (all: every one), oldest first. */
function admissions(store: AuthStore, { now = Date.now(), all = false }: { now?: number; all?: boolean } = {}): AdmissionRequest[] {
  return Object.entries(store.kv.get<Invites>(INVITES_KEY, null) ?? {})
    .filter((e): e is [string, AdmissionRecord] => { const i = e[1]; return !!(i && i.admission && (all || (i.admit === 'asked' && !i.burnt_at && now <= Date.parse(i.expires_at)))); })
    .map(([k, i]) => ({ ...i, slot: k, ref: k.slice(0, 12) }))
    .sort((a, b) => a.created_at.localeCompare(b.created_at));
}

/**
 * The host person's answer to an admission: 'let-in' (the joiner may redeem it for HANDOFF_INVITE_MS) or 'refused'
 * (burnt). AUTH when it is not waiting any more (answered, lapsed, revoked).
 */
function decide(store: AuthStore, ref: string, { decision, by = null, sig = null, as, now = Date.now() }: {
  decision: 'let-in' | 'refused'; by?: string | null; sig?: unknown; as?: string; now?: number;
}): AdmissionRequest {
  if (!store.isHost) throw new RoomError('HOST_ONLY', 'only the host of a room lets machines in');
  const got: { out: AdmissionRequest | null } = { out: null }; // set in the update
  store.kv.update(INVITES_KEY, (cur: Invites | null) => {
    const hit = Object.entries(cur ?? {}).filter((e): e is [string, AdmissionRecord] => REF_RE.test(String(ref)) && e[0].startsWith(ref) && !!e[1].admission);
    const [only] = hit;
    if (hit.length !== 1 || !only) throw new RoomError('AUTH', `room ${store.code} has no join request ${ref} (/sub-human admit lists them)`);
    const [slot, inv] = only;
    if (inv.admit !== 'asked' || inv.burnt_at) throw new RoomError('AUTH', `that join request was ${inv.admit === 'let-in' ? 'let in already' : inv.admit === 'refused' ? 'refused already' : 'withdrawn (revoked or lapsed)'}`);
    if (now > Date.parse(inv.expires_at)) throw new RoomError('AUTH', 'that join request lapsed; send them a new invite (/sub-human invite)', 'ADMIT_LAPSED');
    const at = iso(now);
    const next: AdmissionRecord = decision === 'let-in'
      ? { ...inv, ...(as ? { name: as, asked_as: inv.name } : {}), admit: 'let-in', admitted_at: at, admitted_by: by, ...(sig ? { admit_sig: sig } : {}), admitted_until: iso(now + HANDOFF_INVITE_MS) }
      : { ...inv, admit: 'refused', refused_at: at, refused_by: by, burnt_at: at };
    got.out = { ...next, slot, ref: slot.slice(0, 12) };
    return { ...cur, [slot]: next };
  });
  if (!got.out) throw new Error('the invites update did not run'); // it ran (or threw)
  return got.out;
}

/** Mark lapsed (burn) every admission past its time that nobody answered; the records that lapsed now. */
function lapseAdmissions(store: AuthStore, { now = Date.now() }: { now?: number } = {}): AdmissionRequest[] {
  let lapsed: AdmissionRequest[] = [];
  const due = (i: InviteRecord | null | undefined) => !!i && !!i.admission && i.admit === 'asked' && !i.burnt_at && now > Date.parse(i.expires_at);
  if (!Object.values(store.kv.get<Invites>(INVITES_KEY, null) ?? {}).some(due)) return lapsed; // a read, no lock, on every tail tick
  store.kv.update(INVITES_KEY, (cur: Invites | null) => {
    lapsed = [];
    const next: Invites = { ...cur };
    for (const [k, i] of Object.entries(cur ?? {})) {
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

const roomLib = (): typeof RoomMod => require('../room.ts');
const secretLib = (): typeof InviteSecretMod => require('./invite-secret.ts');
const hostStore = (code: RoomCode): RoomStore => roomLib().hostStore(code, { what: 'only its host can let people in' });

const pending = (code: RoomCode, { now = Date.now() }: { now?: number } = {}): AdmissionRequest[] => admissions(hostStore(code), { now });
const find = (code: RoomCode, ref: string): AdmissionRequest | null => admissions(hostStore(code), { all: true }).find(r => r.ref === ref || (ref && ref.length >= 6 && r.ref.startsWith(ref))) ?? null;

function targets(code: RoomCode, req: AdmissionRequest): SeatName[] {
  const identity: typeof IdentityMod = require('../identity.ts');
  const { isMine }: typeof HomeMod = require('../home.ts');
  const here = Object.values(identity.readMembers(code) || {})
    .filter(m => !!m && !!m.name && !m.left_at && m.role !== 'claude' && (!m.machine || isMine(m.machine))).map(m => m.name);
  const by = here.find(n => n === req.by);
  return by ? [by] : here;
}

/** What the card and the joiner's screen both show, to compare: the check of the machine (and web key) that proved
 *  itself with the PIN (lib/remote/invite-secret.ts joinCheck), never something the line alone gives. */
const fp = (req: AdmissionRequest): string => secretLib().joinCheck(req.machine, req.key);
const describe = (req: AdmissionRequest): string => `${req.name} (${fp(req)}) on ${req.label || 'another machine'}`;
const question = (req: AdmissionRequest, code: RoomCode): string => `Let ${describe(req)} join room ${code}? (admit ${req.ref})`;

function taken(code: RoomCode, req: AdmissionRequest): string | null {
  let ms: Record<string, { name?: string; role?: string; machine?: string | null } | undefined>;
  try { ms = require<typeof IdentityMod>('../identity.ts').readMembers(code) || {}; } catch { return null; }
  const m = ms[req.name];
  if (!m || m.role === 'claude' || !m.machine || m.machine === req.machine) return null;
  const { NAME_RE }: typeof TextMod = require('../text.ts');
  for (let i = 2; i < 100; i++) {
    const alt = `${req.name.slice(0, 30)}${i}`;
    if (NAME_RE.test(alt) && !ms[alt]) return alt;
  }
  return null;
}

function card(req: AdmissionRequest, code: RoomCode): Card {
  const alt = taken(code, req);
  if (alt) {
    return {
      questions: [{
        question: question(req, code),
        header: 'Join',
        multiSelect: false,
        options: [
          { label: `Let in as ${alt}`, description: `${req.name} already sits in room ${code} from another machine, and a seat's key never moves to a new one: this machine (${fp(req)} on their screen) joins as ${alt} only. Undo any time: /sub-human kick ${alt}.` },
          { label: REFUSE, description: 'Nothing gets in; their join stops. The invite is used up either way.' },
        ],
      }],
    };
  }
  return {
    questions: [{
      question: question(req, code),
      header: 'Join',
      multiSelect: false,
      options: [
        { label: LET_IN, description: `${req.name} typed your invite line and its PIN on another machine (the name is what they say; ${fp(req)} is what their screen shows). Let in: that machine joins room ${code} as ${req.name} only. Undo any time: /sub-human kick ${req.name}.` },
        { label: REFUSE, description: 'Nothing gets in; their join stops. The invite is used up either way.' },
      ],
    }],
  };
}


function letIn(code: RoomCode, ref: string, { by = null, sign = null, as, now = Date.now() }: {
  by?: string | null; sign?: Signer | null; as?: string; now?: number;
} = {}): { id: string; text: string } {
  const store = hostStore(code);
  const req = find(code, ref);
  if (!req) throw new RoomError('INVALID', `room ${code} has no join request ${ref} (/sub-human admit lists them)`);
  // a name that sits here from another machine is let in as the free one the card offered (never as the taken one)
  const alt = taken(code, req);
  if (as !== undefined && as !== alt) throw new RoomError('INVALID', `${req.name} can be let in as ${alt || req.name} only now; ask again (/sub-human admit ${req.ref})`);
  const sig = sign ? sign({ kind: 'admit', ref: req.ref, link: req.link, key: req.key || null, machine: req.machine }) : null;
  const rec = decide(store, req.ref, { decision: 'let-in', by, sig, now, ...(alt ? { as: alt } : {}) });
  roomLib().roomLine(store, `${by || 'the host'} let ${describe(rec)} in; undo with: /sub-human kick ${rec.name}`);
  return { id: rec.link, text: `let in: ${describe(rec)} joins room ${code} within seconds, as ${rec.name} only. Undo: /sub-human kick ${rec.name}` };
}

function refuse(code: RoomCode, ref: string, { by = null, now = Date.now() }: { by?: string | null; now?: number } = {}): { text: string } {
  const store = hostStore(code);
  const req = find(code, ref);
  if (!req) throw new RoomError('INVALID', `room ${code} has no join request ${ref} (/sub-human admit lists them)`);
  const rec = decide(store, req.ref, { decision: 'refused', by, now });
  roomLib().roomLine(store, `${by || 'the host'} refused ${describe(rec)}: nothing got in`);
  return { text: `refused: ${describe(rec)} does not get into room ${code}; their join stops` };
}

function markTold(code: RoomCode, { ref, name }: { ref: string; name: SeatName }): void {
  try {
    hostStore(code).kv.update(INVITES_KEY, (cur: Invites | null) => {
      const docs = cur ?? {};
      const [k, rec] = Object.entries(docs).find(([x, d]) => x.startsWith(ref) && d.admission) ?? [];
      if (!k || !rec || !rec.admission || (rec.told ?? []).includes(name)) return undefined;
      return { ...cur, [k]: { ...rec, told: [...(rec.told ?? []), name] } };
    });
  } catch { /* told again */ }
}

const lapse = (code: RoomCode, { now = Date.now() }: { now?: number } = {}): AdmissionRequest[] => lapseAdmissions(hostStore(code), { now });

export {
  check, admissions, decide, lapseAdmissions, WAITING, pending, find, targets, describe, question, taken, card, letIn, refuse, markTold, lapse, LET_IN, REFUSE,
};
export type { Signer, Slotted, AdmissionRequest };
