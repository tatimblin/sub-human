/**
 * paths: the one place the scripts reach into the plugin for its paths (read-only imports).
 *
 *   home()            the sub-human home: plugin lib/identity.ts home() ($SUB_HUMAN_HOME or ~/.sub-human)
 *   demoHome()        the demo's home when $SUB_HUMAN_HOME is unset: /tmp/sh-demo/home (scripts/demo.sh)
 *   taskListId(code)  "sh-CODE", tasksDir(code): the room Claude's native task list (plugin lib/room-claude.ts)
 *   projectsDir()     the projects/ folder of $CLAUDE_CONFIG_DIR or ~/.claude
 *   seatProjectDir(seat)  a demo seat's transcript folder (seats work in /tmp/sh-demo/SEAT = /private/tmp/…)
 *   pluginLib(name)   plugin/sub-human/lib/<name>, loaded on first use and typed (e.g. 'room.ts' for validateChain)
 *   pluginTest(name)  plugin/sub-human/test/<name> (scripts tests only: 'support/two-homes.ts' for S11)
 *   pluginFile(rel)   another plugin module, by its path in the plugin (arch-doc: 'mod/register.ts' HOOKS)
 *   roomCode(v), seatName(v)   v as a RoomCode or SeatName (plugin lib/brand.ts), through the plugin's own
 *                     constructor; throws when it is none
 *
 * The plugin modules load lazily, so a script that needs only one lib (probe-cc: cc/contract.ts) loads only that one;
 * PluginLibs, PluginTests and PluginFiles name each one a script loads, with its type: a name missing there does not compile.
 * If the plugin moves one of these, fix it here.
 */
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import type { RoomCode, SeatName } from '../../plugin/sub-human/lib/brand.ts';
import type * as ContractMod from '../../plugin/sub-human/lib/cc/contract.ts';
import type * as IdentityMod from '../../plugin/sub-human/lib/identity.ts';
import type * as ProposalMod from '../../plugin/sub-human/lib/proposal.ts';
import type * as LinkSocketMod from '../../plugin/sub-human/lib/remote/link-socket.ts';
import type * as ListenerMod from '../../plugin/sub-human/lib/remote/listener.ts';
import type * as NoiseMod from '../../plugin/sub-human/lib/remote/noise.ts';
import type * as TailscaleMod from '../../plugin/sub-human/lib/remote/tailscale.ts';
import type * as WsMod from '../../plugin/sub-human/lib/remote/transports/ws.ts';
import type * as RemoteWsMod from '../../plugin/sub-human/lib/remote/ws.ts';
import type * as RoomClaudeMod from '../../plugin/sub-human/lib/room-claude.ts';
import type * as RoomMod from '../../plugin/sub-human/lib/room.ts';
import type * as EnvelopeMod from '../../plugin/sub-human/lib/room/envelope.ts';
import type * as StoreMod from '../../plugin/sub-human/lib/room/store.ts';
import type * as TextMod from '../../plugin/sub-human/lib/text.ts';
import type * as BrandsMod from '../../plugin/sub-human/test/support/brands.ts';
import type * as TwoHomesMod from '../../plugin/sub-human/test/support/two-homes.ts';
import type * as HoldMod from '../../plugin/sub-human/mcp/hold.ts';
import type * as TaskMod from '../../plugin/sub-human/mcp/task.ts';
import type * as RegisterMod from '../../plugin/sub-human/mod/register.ts';

const require: <M>(id: string) => M = createRequire(import.meta.url);

export const REPO = path.resolve(import.meta.dirname, '..', '..');
export const PLUGIN = path.join(REPO, 'plugin', 'sub-human');

/** The plugin libs the scripts load (plugin/sub-human/lib/<key>). */
export interface PluginLibs {
  'cc/contract.ts': typeof ContractMod;
  'identity.ts': typeof IdentityMod;
  'proposal.ts': typeof ProposalMod;
  'remote/link-socket.ts': typeof LinkSocketMod;
  'remote/listener.ts': typeof ListenerMod;
  'remote/noise.ts': typeof NoiseMod;
  'remote/tailscale.ts': typeof TailscaleMod;
  'remote/transports/ws.ts': typeof WsMod;
  'remote/ws.ts': typeof RemoteWsMod;
  'room-claude.ts': typeof RoomClaudeMod;
  'room.ts': typeof RoomMod;
  'room/envelope.ts': typeof EnvelopeMod;
  'room/store.ts': typeof StoreMod;
  'text.ts': typeof TextMod;
}
/** The plugin test support the scripts tests load (plugin/sub-human/test/<key>). */
export interface PluginTests {
  'support/brands.ts': typeof BrandsMod;
  'support/two-homes.ts': typeof TwoHomesMod;
}

/** Other plugin modules the scripts load (plugin/sub-human/<key>). */
export interface PluginFiles {
  'mcp/hold.ts': typeof HoldMod;
  'mcp/task.ts': typeof TaskMod;
  'mod/register.ts': typeof RegisterMod;
}

export const pluginLib = <K extends keyof PluginLibs>(name: K): PluginLibs[K] => require(path.join(PLUGIN, 'lib', name));
export const pluginTest = <K extends keyof PluginTests>(name: K): PluginTests[K] => require(path.join(PLUGIN, 'test', name));
export const pluginFile = <K extends keyof PluginFiles>(rel: K): PluginFiles[K] => require(path.join(PLUGIN, rel));

const DEMO_BASE = '/tmp/sh-demo';
export const home = (): string => pluginLib('identity.ts').home();
export const demoHome = (): string => process.env.SUB_HUMAN_HOME || path.join(DEMO_BASE, 'home');
const claudeDir = (): string => process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
export const projectsDir = (): string => path.join(claudeDir(), 'projects');
export const seatProjectDir = (seat: string): string => path.join(projectsDir(), `-private-tmp-sh-demo-${seat}`);
export function roomCode(v: unknown): RoomCode {
  const c = pluginLib('text.ts').roomCode(v);
  if (!c) throw new Error(`not a room code: ${JSON.stringify(v)}`);
  return c;
}
export function seatName(v: unknown): SeatName {
  const n = pluginLib('text.ts').seatName(v);
  if (!n) throw new Error(`not a seat name: ${JSON.stringify(v)}`);
  return n;
}
export const taskListId = (code: string): string => pluginLib('room-claude.ts').taskListId(roomCode(code));
export const tasksDir = (code: string): string => pluginLib('room-claude.ts').tasksDir(roomCode(code));
