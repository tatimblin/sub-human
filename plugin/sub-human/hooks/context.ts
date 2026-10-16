/**
 * plugin/sub-human/hooks/context.ts: the mechanics block the join and the restore hand the model (<= BLOCK_MAX chars
 * with 5 members). No seat key.
 *
 *   contextBlock(me, lead?, {rowsLead, rowsText, allRows}?) -> string   the role template (skills/sub-human/member.md |
 *       room-claude.md) filled for this seat, then ROWS (lib/rows.ts rowCalls, cut to the bare calls when the whole block
 *       would pass BLOCK_MAX). lead (e.g. "restored after clear") is a short last line. No roster or digest: others'
 *       words arrive through the hooks module's tail child (chat, pull, wake).
 *   seatTitle(me) -> "alice.vole-8126"   the seat as a session title: its native address (SendMessage reaches it by it)
 */
import fs from 'node:fs';
import path from 'node:path';
import * as identity from '../lib/identity.ts';
import * as rows from '../lib/rows.ts';
import * as text from '../lib/text.ts';
import * as config from '../lib/config.ts';
import { roomClaudePresence } from '../lib/room/members.ts';
import type { Member } from '../lib/room/types.ts';
import type { Identity } from '../lib/identity.ts';
import type { RoomCode } from '../lib/brand.ts';

const PLUGIN_ROOT = path.join(import.meta.dirname, '..');
const CAP = config.CONTEXT_CAP;
export const BLOCK_MAX = config.BLOCK_MAX;

/** readMembers() ({name: record}) as an array, in join order. */
const members = (code: RoomCode): Member[] => Object.values<Member>(identity.readMembers(code) || {}).filter(m => m && m.name);
const hasLeft = (m: Member) => !!m.left_at;

const TEMPLATE_FILES: Record<'member' | 'claude', string> = { member: 'member.md', claude: 'room-claude.md' };
/** Used only when a role file is missing or has no {CODE} placeholder. */
const DEFAULT_TEMPLATES: Record<'member' | 'claude', string> = {
  member: 'SUB-HUMAN: you are {NAME}\'s Claude in room {CODE} (with {OTHERS}). {NAME} types here.\n'
    + 'Room lines are a group chat {NAME} already sees: never repeat them. Never show room ids.\n'
    + 'Reach a session now: SendMessage to {ADDR_EXAMPLE}. Only a person\'s own plan view answer counts.',
  claude: 'SUB-HUMAN: you are claude, the room\'s Claude of room {CODE} (members: {OTHERS}). Nobody types here.\n'
    + 'Reach a member now: SendMessage to {ADDR_EXAMPLE}. To facilitate: read {PLUGIN}/skills/sub-human/facilitate.md.',
};

const pluginRoot = () => process.env.CLAUDE_PLUGIN_ROOT || PLUGIN_ROOT;

/** The role's template (skills/sub-human/member.md | room-claude.md), with placeholders unfilled. */
function template(role: string) {
  const r = role === 'claude' ? 'claude' : 'member';
  let t = '';
  try { t = fs.readFileSync(path.join(pluginRoot(), 'skills', 'sub-human', TEMPLATE_FILES[r]), 'utf8').trim(); } catch { /* default */ }
  return t.includes('{CODE}') ? t : DEFAULT_TEMPLATES[r];
}

type TemplateVar = 'NAME' | 'CODE' | 'OTHERS' | 'ADDR_EXAMPLE' | 'PLUGIN';

/** The placeholder values: {NAME} {CODE} {OTHERS} {ADDR_EXAMPLE} {PLUGIN}. */
function fillVars(me: Identity, ms = members(me.code)): Record<TemplateVar, string> {
  const live = ms.filter(m => !hasLeft(m) && m.name !== me.name);
  const humans = live.filter(m => m.role !== 'claude').map(m => m.name);
  // the room's Claude only when it runs (or is starting): a stub or a failed start is not someone in the room
  const o = me.role === 'claude' ? null : roomClaudePresence(ms.find(m => m.role === 'claude'));
  const others = o ? [...humans, o === 'live' ? 'claude' : 'claude [starting]'] : humans;
  const ex = humans[0] || (me.role === 'claude' ? 'NAME' : 'claude');
  return {
    NAME: me.name, CODE: me.code, OTHERS: others.length ? others.join(', ') : 'nobody yet',
    ADDR_EXAMPLE: identity.address(ex, me.code), PLUGIN: pluginRoot(),
  };
}
const fill = (t: string, vars: Record<TemplateVar, string>) => t.replace(/\{(NAME|CODE|OTHERS|ADDR_EXAMPLE|PLUGIN)\}/g, (_, k: TemplateVar) => vars[k]);

const roleText = (role: string, me: Identity | null) => (me ? fill(template(role), fillVars(me)) : template(role));

const clip = (s: string, n = CAP) => text.clip(s, n);

/**
 * lib/rows.ts rowCalls(); '' when it fails. Lists only the rows with no live hold in this seat's hold
 * server (rows/holds-NAME.json): rows survive /clear, compaction and a re-run of /sub-human, and a second
 * spawn would duplicate them. After --resume the server is new, so all; all: every row (after the agent view's fork,
 * whose rows ended with the old session while its hold server may still look live).
 */
function rowCalls(me: Identity, all = false): string {
  try {
    const ms = identity.readMembers(me.code);
    const held = all ? null : rows.readHolds(me.code, me.name);
    const only = held ? rows.rowsNeeded(me.code, me, { members: ms, held }) : null;
    return String(rows.rowCalls(me, ms, { only }) || '').trim();
  } catch (e) {
    process.stderr.write(`sub-human: rows unavailable: ${e instanceof Error ? e.message : e}\n`);
    return '';
  }
}

/**
 * rowCalls() cut to its Agent(...) lines when the full text would overflow the block. Several participant
 * calls (the room's Claude) become one call pattern plus the names, so the block stays inside the budget with 5 members.
 */
function compactRows(text: string, me: Identity): string {
  const calls = text.split('\n').map(l => l.trim()).filter(l => /^Agent\(\{.*\}\)$/.test(l));
  const tail = me.role === 'claude' ? '\nOn member_joined, follow its "row:" note.' : '';
  if (!calls.length) return `Your rows are running; make no Agent call for them.${tail}`;
  const who = calls.map(c => /subagent_type: "sub-human:participant", description: "([^"]+)"/.exec(c)).filter(m => m !== null).map(m => m[1]);
  if (who.length > 1 && who.length === calls.length) {
    const pattern = calls[0].split(`"${who[0]}"`).join('"NAME"').split(` ${who[0]}"`).join(' NAME"');
    return `Make one Agent call per name, all in one message, now; write nothing about them:\n${pattern}\nNAME = ${who.join(', ')}${tail}`;
  }
  return `Make ${calls.length === 1 ? 'this Agent call' : 'these Agent calls, in one message,'} now, exactly as written; write nothing about it:\n${calls.join('\n')}${tail}`;
}

export const seatTitle = (me: Identity) => identity.address(me.name, me.code);

export function contextBlock(me: Identity, lead?: string, { rowsLead = '', rowsText = null, allRows = false }: { rowsLead?: string; rowsText?: string | null; allRows?: boolean } = {}) {
  const text = roleText(me.role, me);
  const tail = lead ? `\n(${lead})` : '';
  let rs = rowsText != null ? rowsText : rowCalls(me, allRows);
  if (rs && rowsText == null) {
    const full = `${rowsLead}${rs}`;
    rs = `${text}\n\nROWS\n${full}${tail}`.length <= BLOCK_MAX ? full : compactRows(rs, me);
  }
  return clip(`${text}${rs ? `\n\nROWS\n${rs}` : ''}${tail}`);
}
