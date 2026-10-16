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
 *
 * The plugin modules load lazily, so a script that needs only one lib (probe-cc: cc/contract.ts) loads only that one;
 * PluginLibs, PluginTests and PluginFiles name each one a script loads, with its type: a name missing there does not compile.
 * If the plugin moves one of these, fix it here.
 */
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

export const REPO = path.resolve(import.meta.dirname, '..', '..');
export const PLUGIN = path.join(REPO, 'plugin', 'sub-human');

/** The plugin libs the scripts load (plugin/sub-human/lib/<key>). */
export interface PluginLibs {
  'cc/contract.ts': typeof import('../../plugin/sub-human/lib/cc/contract.ts');
  'identity.ts': typeof import('../../plugin/sub-human/lib/identity.ts');
  'proposal.ts': typeof import('../../plugin/sub-human/lib/proposal.ts');
  'remote/link-socket.ts': typeof import('../../plugin/sub-human/lib/remote/link-socket.ts');
  'remote/listener.ts': typeof import('../../plugin/sub-human/lib/remote/listener.ts');
  'remote/tailscale.ts': typeof import('../../plugin/sub-human/lib/remote/tailscale.ts');
  'remote/transports/ws.ts': typeof import('../../plugin/sub-human/lib/remote/transports/ws.ts');
  'remote/ws.ts': typeof import('../../plugin/sub-human/lib/remote/ws.ts');
  'room-claude.ts': typeof import('../../plugin/sub-human/lib/room-claude.ts');
  'room.ts': typeof import('../../plugin/sub-human/lib/room.ts');
  'room/envelope.ts': typeof import('../../plugin/sub-human/lib/room/envelope.ts');
  'room/store.ts': typeof import('../../plugin/sub-human/lib/room/store.ts');
}
/** The plugin test support the scripts tests load (plugin/sub-human/test/<key>). */
export interface PluginTests {
  'support/two-homes.ts': typeof import('../../plugin/sub-human/test/support/two-homes.ts');
}

/** Other plugin modules the scripts load (plugin/sub-human/<key>). */
export interface PluginFiles {
  'mcp/hold.ts': typeof import('../../plugin/sub-human/mcp/hold.ts');
  'mcp/task.ts': typeof import('../../plugin/sub-human/mcp/task.ts');
  'mod/register.ts': typeof import('../../plugin/sub-human/mod/register.ts');
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
export const taskListId = (code: string): string => pluginLib('room-claude.ts').taskListId(code);
export const tasksDir = (code: string): string => pluginLib('room-claude.ts').tasksDir(code);
