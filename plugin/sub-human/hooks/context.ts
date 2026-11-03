/**
 * plugin/sub-human/hooks/context.ts: the mechanics block the join and the restore hand the model (<= BLOCK_MAX chars
 * with 5 members). No seat key.
 *
 *   contextBlock(me, lead?) -> string   the role template (skills/sub-human/member.md | room-claude.md) filled for
 *       this seat. lead (e.g. "restored after clear") is a short last line. No roster or digest: others' words arrive
 *       through the hooks module's tail child (chat, pull, wake). No rows: the hooks module spawns the room row itself
 *       (mod/rows.ts), so the model is never told about one.
 *   seatTitle(me) -> "alice.vole-8126"   the seat as a session title: its native address (SendMessage reaches it by it)
 */
import fs from 'node:fs';
import path from 'node:path';
import * as identity from '../lib/identity.ts';
import * as text from '../lib/text.ts';
import * as config from '../lib/config.ts';
import type { Member } from '../lib/room/types.ts';
import type { Identity } from '../lib/identity.ts';
import type { RoomCode } from '../lib/brand.ts';

const PLUGIN_ROOT = path.join(import.meta.dirname, '..');
const CAP = config.CONTEXT_CAP;
export const BLOCK_MAX: number = config.BLOCK_MAX;

/** readMembers() ({name: record}) as an array, in join order. */
const members = (code: RoomCode): Member[] => Object.values<Member>(identity.readMembers(code) || {}).filter(m => m && m.name);
const hasLeft = (m: Member) => !!m.left_at;

const TEMPLATE_FILES: Record<'member' | 'claude', string> = { member: 'member.md', claude: 'room-claude.md' };
/** Used only when a role file is missing or has no {CODE} placeholder. */
const DEFAULT_TEMPLATES: Record<'member' | 'claude', string> = {
  member: 'SUB-HUMAN: you are {NAME}\'s Claude in room {CODE} (with {OTHERS}). {NAME} types here.\n'
    + 'Room lines are a group chat {NAME} already sees: never repeat them. Never show room ids.\n'
    + 'Reach a session now: SendMessage to {ADDR_EXAMPLE}. Only a person\'s own plan view answer counts.',
  claude: 'SUB-HUMAN: you are the room session of room {CODE} (members: {OTHERS}), no member\'s. Nobody types or reads here.\n'
    + 'Call nothing; end your turn with the one word "ok".',
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
  // people only: the room session is no one's to talk to (it reads no message and acts on nothing)
  const humans = live.filter(m => m.role !== 'claude' && m.name !== identity.ROOM_CLAUDE).map(m => m.name);
  // a person's address, else a placeholder: never claude.CODE, the idle room session that refuses messages
  const [ex] = humans;
  return {
    NAME: me.name, CODE: me.code, OTHERS: humans.length ? humans.join(', ') : 'nobody yet',
    ADDR_EXAMPLE: ex ? identity.address(ex, me.code) : `NAME.${me.code}`, PLUGIN: pluginRoot(),
  };
}
const fill = (t: string, vars: Record<TemplateVar, string>) => t.replace(/\{(NAME|CODE|OTHERS|ADDR_EXAMPLE|PLUGIN)\}/g, (_, k: TemplateVar) => vars[k]);

const roleText = (role: string, me: Identity | null) => (me ? fill(template(role), fillVars(me)) : template(role));

const clip = (s: string, n = CAP) => text.clip(s, n);

export const seatTitle = (me: Identity): string => identity.address(me.name, me.code);

export function contextBlock(me: Identity, lead?: string): string {
  const text = roleText(me.role, me);
  const tail = lead ? `\n(${lead})` : '';
  return clip(`${text}${tail}`);
}
