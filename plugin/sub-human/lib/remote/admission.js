'use strict';
/**
 * plugin/sub-human/lib/remote/admission.js: the host person's consent to a machine that typed a short code. The code
 * proved only that the joiner knows it (lib/remote/enroll.js); nothing gets in until a person on the host answers "Let
 * in" on the card their own Claude Code shows (hooks/consent.js, like the handoff card: only the answer on the card as
 * the hooks built it counts, never the model's), or runs `sub-human admit REF` in a shell (headless hosts), or types
 * `/sub-human admit REF`. Then, over ssh, the joiner's link key gets the forced-command line for its one link, exactly
 * as `admit` wrote it for a pasted request (lib/remote/shim.js authorizedLine), and the joiner's link redeems its
 * admission secret (lib/remote/auth.js admissionCheck). The room's tail on the host wakes the seat's Claude to open the
 * card once (lib/tail.js); a request nobody answers lapses after ADMIT_TTL_MS.
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

const path = require('node:path');
const auth = require('./auth.js');
const { RoomError } = require('../room/validate.js');

const LET_IN = 'Let in';
const REFUSE = 'Refuse';

function hostStore(code) {
  const s = require('../room.js').open(code).store;
  if (!s.isHost) throw new RoomError('HOST_ONLY', `room ${code} is hosted on another machine; its host lets machines in`);
  return s;
}

const pending = (code, { now = Date.now() } = {}) => auth.admissions(hostStore(code), { now });
const find = (code, ref) => auth.admissions(hostStore(code), { all: true }).find(r => r.ref === ref || (ref && ref.length >= 6 && r.ref.startsWith(ref))) || null;

function targets(code, req) {
  const identity = require('../identity.js');
  const { machineId } = require('../home.js');
  const here = Object.values(identity.readMembers(code) || {})
    .filter(m => m && m.name && !m.left_at && m.role !== 'claude' && (!m.machine || m.machine === machineId())).map(m => m.name);
  return req.by && here.includes(req.by) ? [req.by] : here;
}

const fp = req => (req.key ? require('./sshkeys.js').fingerprint(req.key) : `request ${req.ref.slice(0, 6)}`);
const describe = req => `${req.name} (${fp(req)}) on ${req.label || 'another machine'}`;
const question = (req, code) => `Let ${describe(req)} join room ${code}? (admit ${req.ref})`;

function card(req, code) {
  return {
    questions: [{
      question: question(req, code),
      header: 'Join',
      multiSelect: false,
      options: [
        { label: LET_IN, description: `${req.name} typed your code from another machine (names are what they say; ${fp(req)} is what their screen shows). Let in: that machine joins room ${code} as one link and posts only as the seats it brings. Undo any time: /sub-human revoke ${req.name}.` },
        { label: REFUSE, description: 'Nothing gets in; their join stops. Your code is used up either way.' },
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
  if (!req) throw new RoomError('INVALID', `no join request of room ${code} has the ref ${ref}`);
  const sig = sign ? sign({ kind: 'admit', ref: req.ref, link: req.link, key: req.key || null, machine: req.machine }) : null;
  let file = null;
  if (req.kind === 'ssh' && req.admit === 'asked') {
    // the key line first, then the record: a failed write leaves the request waiting, not let in without a key
    const sshkeys = require('./sshkeys.js');
    const { shim, h } = require('./hosting.js').shimReady();
    const key = sshkeys.openssh(req.key);
    file = path.resolve(req.door_file || sshkeys.authorizedKeysFile());
    sshkeys.appendAuthorized(file, shim.authorizedLine(code, req.link, key, h), key);
  }
  let rec;
  try { rec = auth.decideAdmission(store, req.ref, { decision: 'let-in', by, sig, now }); } catch (e) {
    if (file && req.admit === 'asked') require('./sshkeys.js').removeAuthorized(file, code, req.link);
    throw e;
  }
  roomLine(store, `${by || 'the host'} let ${describe(rec)} in (link ${rec.link}); revoke it with: sub-human revoke ${rec.link}`);
  return { id: rec.link, text: `let in: ${describe(rec)} may join room ${code} as link ${rec.link}${file ? ` (its key reaches only this room's server: a forced command in ${file})` : ''}. Their link connects within seconds. Undo: /sub-human revoke ${rec.name}` };
}

function refuse(code, ref, { by = null, now = Date.now() } = {}) {
  const store = hostStore(code);
  const req = find(code, ref);
  if (!req) throw new RoomError('INVALID', `no join request of room ${code} has the ref ${ref}`);
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

module.exports = { pending, find, targets, describe, question, card, letIn, refuse, markTold, lapse, LET_IN, REFUSE };
