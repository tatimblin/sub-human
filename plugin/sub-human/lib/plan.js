'use strict';
/**
 * plugin/sub-human/lib/plan.js: plan-file frontmatter, canonical plan storage, review stubs.
 * CommonJS, zero dependencies, Node 24.
 *
 * Frontmatter is accepted only as the very first bytes of the file, exactly:
 *   ---\nsub-human: {JSON object}\n---\n
 * The JSON line keeps parsing dependency-free.
 *
 *   parseFrontmatter(text) -> {room, approval, approvers, review}|null
 *       null when absent, not leading, not a JSON object, or a field has the wrong type
 *       (room: room code, approval: string, approvers: names[], review: 12-hex hash; each optional).
 *   body(text) -> string                 the text after the frontmatter (all of it when there is none)
 *   PLAN_NOTICE                          the fixed line every room plan's body must start with (the approval
 *                                        dialog says "ready to execute"; this line tells members what approving means)
 *   hasNotice(text) -> bool              the first non-blank body line is exactly PLAN_NOTICE (trailing spaces ok)
 *   isStub(text) -> bool                 frontmatter with `review` and essentially no body (<= 200 chars)
 *   hash12(bytes) -> string              first 12 hex of sha256 (same as room.hash12)
 *   storeCanonical(code, bytes) -> hash  writes <roomDir>/plans/<hash>.md (atomic, idempotent)
 *   canonical(code, hash) -> Buffer|null the stored bytes
 *   stubFor(code, hash) -> string        the review stub a member's Claude writes to its plan file
 *   editSummary(a, b) -> string          a line diff ("- old" / "+ new"), at most 2,000 chars
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const identity = require('./identity.js');

const FM_RE = /^---\nsub-human: ([^\n]*)\n---(?:\n|$)/;
const HASH_RE = /^[0-9a-f]{12}$/;
const STUB_BODY_MAX = 200;
const EDIT_SUMMARY_MAX = 2000;

const PLAN_NOTICE = '> **Room plan — approving this is your sign-off for the room. Your Claude will not run it. Choose "2. Yes, manually approve edits".**';

const hash12 = data => crypto.createHash('sha256').update(data).digest('hex').slice(0, 12);

function parseFrontmatter(text) {
  const s = Buffer.isBuffer(text) ? text.toString('utf8') : text;
  if (typeof s !== 'string') return null;
  const m = s.match(FM_RE);
  if (!m) return null;
  let o;
  try { o = JSON.parse(m[1]); } catch { return null; }
  if (!o || typeof o !== 'object' || Array.isArray(o)) return null;
  const { room, approval, approvers, review } = o;
  if (room !== undefined && (typeof room !== 'string' || !identity.CODE_RE.test(room))) return null;
  if (approval !== undefined && typeof approval !== 'string') return null;
  if (approvers !== undefined && (!Array.isArray(approvers) || !approvers.every(a => typeof a === 'string' && identity.NAME_RE.test(a)))) return null;
  if (review !== undefined && (typeof review !== 'string' || !HASH_RE.test(review))) return null;
  return { room, approval, approvers, review };
}

function body(text) {
  const s = Buffer.isBuffer(text) ? text.toString('utf8') : String(text);
  const m = s.match(FM_RE);
  return m ? s.slice(m[0].length) : s;
}

function hasNotice(text) {
  const first = body(text).split('\n').find(l => l.trim() !== '');
  return first != null && first.replace(/\s+$/, '') === PLAN_NOTICE;
}

function isStub(text) {
  const fm = parseFrontmatter(text);
  return !!(fm && fm.review) && body(text).trim().length <= STUB_BODY_MAX;
}

const plansDir = code => path.join(identity.roomDir(code), 'plans');

function storeCanonical(code, bytes) {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(String(bytes), 'utf8');
  const hash = hash12(buf);
  const file = path.join(plansDir(code), `${hash}.md`);
  if (!fs.existsSync(file)) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, buf);
    fs.renameSync(tmp, file);
  }
  return hash;
}

function canonical(code, hash) {
  if (typeof hash !== 'string' || !HASH_RE.test(hash)) return null;
  try { return fs.readFileSync(path.join(plansDir(code), `${hash}.md`)); } catch { return null; }
}

function stubFor(code, hash) {
  return `---\nsub-human: ${JSON.stringify({ room: code, review: hash })}\n---\n` +
    `Review of room plan ${hash}. The plugin replaces this file with the room's plan when you exit plan mode.\n`;
}

/** Line diff: common prefix/suffix trimmed, LCS on the middle when small, else all-removed/all-added. */
function editSummary(a, b) {
  const A = String(Buffer.isBuffer(a) ? a.toString('utf8') : a ?? '').split('\n');
  const B = String(Buffer.isBuffer(b) ? b.toString('utf8') : b ?? '').split('\n');
  let p = 0;
  while (p < A.length && p < B.length && A[p] === B[p]) p++;
  let sa = A.length, sb = B.length;
  while (sa > p && sb > p && A[sa - 1] === B[sb - 1]) { sa--; sb--; }
  const x = A.slice(p, sa), y = B.slice(p, sb);
  const out = [];
  if (x.length * y.length <= 250_000) {
    const L = Array.from({ length: x.length + 1 }, () => new Uint32Array(y.length + 1));
    for (let i = x.length - 1; i >= 0; i--) {
      for (let j = y.length - 1; j >= 0; j--) L[i][j] = x[i] === y[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
    }
    let i = 0, j = 0;
    while (i < x.length || j < y.length) {
      if (i < x.length && j < y.length && x[i] === y[j]) { i++; j++; }
      else if (j < y.length && (i === x.length || L[i][j + 1] >= L[i + 1][j])) out.push(`+ ${y[j++]}`);
      else out.push(`- ${x[i++]}`);
    }
  } else {
    for (const l of x) out.push(`- ${l}`);
    for (const l of y) out.push(`+ ${l}`);
  }
  if (!out.length) return '(no changes)';
  let s = `@@ line ${p + 1}\n` + out.join('\n');
  if (s.length > EDIT_SUMMARY_MAX) s = s.slice(0, EDIT_SUMMARY_MAX - 1) + '…';
  return s;
}

module.exports = { PLAN_NOTICE, parseFrontmatter, body, hasNotice, isStub, hash12, storeCanonical, canonical, stubFor, editSummary, FM_RE };
