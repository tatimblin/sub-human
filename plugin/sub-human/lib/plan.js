'use strict';
/**
 * plugin/sub-human/lib/plan.js: plan-file frontmatter, canonical plan storage, summaries for the sign-off form.
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
 *   PLAN_NOTICE                          the fixed line every room plan's body must start with (tells anyone
 *                                        reading the plan that approvers sign off in the room's form)
 *   hasNotice(text) -> bool              the first non-blank body line is exactly PLAN_NOTICE (trailing spaces ok)
 *   hash12(bytes) -> string              first 12 hex of sha256 (same as room.hash12)
 *   storeCanonical(code, bytes) -> hash  writes <roomDir>/plans/<hash>.md (atomic, idempotent)
 *   canonical(code, hash) -> Buffer|null the stored bytes
 *   planPath(code, hash) -> string       <roomDir>/plans/<hash>.md
 *   summary(text, lines=3) -> string     at most `lines` short lines (frontmatter `summary`, then headings/text)
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const identity = require('./identity.js');

const FM_RE = /^---\nsub-human: ([^\n]*)\n---(?:\n|$)/;
const HASH_RE = /^[0-9a-f]{12}$/;
const SUMMARY_LINE_MAX = 160;

const PLAN_NOTICE = '> **Room plan. Each approver signs off in the form the room shows them; nobody\'s Claude runs it.**';

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

const plansDir = code => path.join(identity.roomDir(code), 'plans');

function storeCanonical(code, bytes) {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(String(bytes), 'utf8');
  const hash = hash12(buf);
  const file = planPath(code, hash);
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
  try { return fs.readFileSync(planPath(code, hash)); } catch { return null; }
}

/** <roomDir>/plans/<hash>.md (whether or not it exists). */
const planPath = (code, hash) => path.join(plansDir(code), `${hash}.md`);

/**
 * At most `lines` short lines describing the plan, for the sign-off form (Claude Code shows only the first
 * 3 lines of an elicitation message). Skips the frontmatter, PLAN_NOTICE and blank lines; a frontmatter
 * `summary` string, when present, comes first. Markdown heading/list markers are stripped, whitespace
 * collapsed, and each line clipped to SUMMARY_LINE_MAX code points.
 */
function summary(text, lines = 3) {
  const s = Buffer.isBuffer(text) ? text.toString('utf8') : String(text ?? '');
  const out = [];
  const m = s.match(FM_RE);
  if (m) { try { const o = JSON.parse(m[1]); if (o && typeof o.summary === 'string' && o.summary.trim()) out.push(o.summary); } catch { /* ignore */ } }
  for (const raw of body(s).split('\n')) {
    if (out.length >= lines) break;
    if (!raw.trim() || raw.replace(/\s+$/, '') === PLAN_NOTICE || /^\s*(---+|```.*)\s*$/.test(raw)) continue;
    const l = raw.replace(/^\s*(#{1,6}\s+|[-*+]\s+(\[[ xX]\]\s+)?|>\s*)/, '');
    if (l.trim()) out.push(l);
  }
  return out.slice(0, Math.max(0, lines)).map(l => {
    const one = l.replace(/\s+/g, ' ').trim();
    const cps = Array.from(one);
    return cps.length > SUMMARY_LINE_MAX ? cps.slice(0, SUMMARY_LINE_MAX - 1).join('') + '…' : one;
  }).join('\n');
}

module.exports = { PLAN_NOTICE, parseFrontmatter, body, hasNotice, hash12, storeCanonical, canonical, planPath, summary, FM_RE };
