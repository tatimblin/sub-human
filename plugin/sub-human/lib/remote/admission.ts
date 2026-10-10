/**
 * plugin/sub-human/lib/remote/admission.ts: the host person's consent to a machine that typed an invite's PIN. The PIN
 * proved only that the joiner knows it (lib/remote/enroll.ts); nothing gets in until a person on the host answers "Let
 * in" on the card their own Claude Code shows (hooks/consent.ts, like the handoff card: only the answer on the card as
 * the hooks built it counts, never the model's), or runs `sub-human admit REF` in a shell (headless hosts), or types
 * `/sub-human admit REF`. Then, over ssh, the joiner's link key gets the forced-command line for its one link
 * (lib/remote/shim.ts authorizedLine), and the joiner's link redeems its
 * admission secret (lib/remote/auth.ts admissionCheck). The room's tail on the host wakes the seat's Claude to open the
 * card once (lib/tail.ts); a request nobody answers lapses after ADMIT_TTL_MS.
 *
 *   pending(code, {now?}) -> [request]        the requests waiting (auth.admissions): {ref, name, label, machine, key,
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
import * as auth from './auth.ts';
import { RoomError } from '../room/validate.ts';
import * as roomMod from '../room.ts';
import * as identityMod from '../identity.ts';
import * as homeMod from '../home.ts';
import * as sshkeysMod from './sshkeys.ts';
import * as hostingMod from './hosting.ts';

const LET_IN = 'Let in';
const REFUSE = 'Refuse';

function hostStore(code) {
  const s = roomMod.open(code).store;
  if (!s.isHost) throw new RoomError('HOST_ONLY', `room ${code} is hosted on another machine; only its host can let people in`);
  return s;
}

const pending = (code, { now = Date.now() } = {}) => auth.admissions(hostStore(code), { now });
const find = (code, ref) => auth.admissions(hostStore(code), { all: true }).find(r => r.ref === ref || (ref && ref.length >= 6 && r.ref.startsWith(ref))) || null;

function targets(code, req) {
  const identity = identityMod;
  const { machineId } = homeMod;
  const here = Object.values(identity.readMembers(code) || {})
    .filter(m => m && m.name && !m.left_at && m.role !== 'claude' && (!m.machine || m.machine === machineId())).map(m => m.name);
  return req.by && here.includes(req.by) ? [req.by] : here;
}

const fp = req => (req.key ? sshkeysMod.fingerprint(req.key) : `request ${req.ref.slice(0, 6)}`);
const describe = req => `${req.name} (${fp(req)}) on ${req.label || 'another machine'}`;
const question = (req, code) => `Let ${describe(req)} join room ${code}? (admit ${req.ref})`;

function card(req, code) {
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

function roomLine(store, text) {
  try { store.append({ kind: 'status', text }, { via: 'system', from: 'room', system: true }); } catch { /* the answer stands */ }
}

function letIn(code, ref, { by = null, sign = null, now = Date.now() } = {}) {
  const store = hostStore(code);
  const req = find(code, ref);
  if (!req) throw new RoomError('INVALID', `room ${code} has no join request ${ref} (/sub-human admit lists them)`);
  const sig = sign ? sign({ kind: 'admit', ref: req.ref, link: req.link, key: req.key || null, machine: req.machine }) : null;
  let file = null;
  if (req.kind === 'ssh' && req.admit === 'asked') {
    // the key line first, then the record: a failed write leaves the request waiting, not let in without a key
    const sshkeys = sshkeysMod;
    const { shim, h } = hostingMod.shimReady();
    const key = sshkeys.openssh(req.key);
    file = path.resolve(req.door_file || sshkeys.authorizedKeysFile());
    sshkeys.appendAuthorized(file, shim.authorizedLine(code, req.link, key, h), key);
  }
  let rec;
  try { rec = auth.decideAdmission(store, req.ref, { decision: 'let-in', by, sig, now }); } catch (e) {
    if (file && req.admit === 'asked') sshkeysMod.removeAuthorized(file, code, req.link);
    throw e;
  }
  roomLine(store, `${by || 'the host'} let ${describe(rec)} in; undo with: /sub-human kick ${rec.name}`);
  return { id: rec.link, text: `let in: ${describe(rec)} joins room ${code} within seconds${file ? ` (their key opens only this room, nothing else on this machine)` : ''}. Undo: /sub-human kick ${rec.name}` };
}

function refuse(code, ref, { by = null, now = Date.now() } = {}) {
  const store = hostStore(code);
  const req = find(code, ref);
  if (!req) throw new RoomError('INVALID', `room ${code} has no join request ${ref} (/sub-human admit lists them)`);
  const rec = auth.decideAdmission(store, req.ref, { decision: 'refused', by, now });
  roomLine(store, `${by || 'the host'} refused ${describe(rec)}: nothing got in`);
  return { text: `refused: ${describe(rec)} does not get into room ${code}; their join stops` };
}

function markTold(code, ref, name) {
  try {
    hostStore(code).kv.update(auth.INVITES_KEY, cur => {
      const k = Object.keys(cur || {}).find(x => x.startsWith(ref) && cur[x].admission);
      if (!k || (cur[k].told || []).includes(name)) return undefined;
      return { ...cur, [k]: { ...cur[k], told: [...(cur[k].told || []), name] } };
    });
  } catch { /* told again */ }
}

const lapse = (code, { now = Date.now() } = {}) => auth.lapseAdmissions(hostStore(code), { now });

export { pending, find, targets, describe, question, card, letIn, refuse, markTold, lapse, LET_IN, REFUSE };
