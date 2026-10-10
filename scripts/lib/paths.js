'use strict';
/**
 * paths: the one place the scripts reach into the plugin for its paths (read-only imports).
 *
 *   home()            the sub-human home: plugin lib/identity.ts home() ($SUB_HUMAN_HOME or ~/.sub-human)
 *   demoHome()        the demo's home when $SUB_HUMAN_HOME is unset: /tmp/sh-demo/home (scripts/demo.sh)
 *   taskListId(code)  "sh-CODE", tasksDir(code): the room Claude's native task list (plugin lib/room-claude.ts)
 *   projectsDir()     the projects/ folder of $CLAUDE_CONFIG_DIR or ~/.claude
 *   seatProjectDir(seat)  a demo seat's transcript folder (seats work in /tmp/sh-demo/SEAT = /private/tmp/…)
 *   pluginLib(name)   require plugin/sub-human/lib/<name> (e.g. 'room.ts' for validateChain)
 *   pluginTest(name)  require plugin/sub-human/test/<name> (scripts tests only: 'support/two-homes.js' for S11)
 *
 * If the plugin moves one of these, fix it here.
 */
const os = require('node:os');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..', '..');
const PLUGIN = path.join(REPO, 'plugin', 'sub-human');
const pluginLib = name => require(path.join(PLUGIN, 'lib', name));
const pluginTest = name => require(path.join(PLUGIN, 'test', name));

const DEMO_BASE = '/tmp/sh-demo';
// required on first use, so a script that needs only one lib (probe-cc: cc.ts) loads only that one
const home = () => pluginLib('identity.ts').home();
const demoHome = () => process.env.SUB_HUMAN_HOME || path.join(DEMO_BASE, 'home');
const claudeDir = () => process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const projectsDir = () => path.join(claudeDir(), 'projects');
const seatProjectDir = seat => path.join(projectsDir(), `-private-tmp-sh-demo-${seat}`);

module.exports = {
  REPO, PLUGIN, pluginLib, pluginTest,
  home, demoHome, projectsDir, seatProjectDir,
  taskListId: code => pluginLib('room-claude.ts').taskListId(code), tasksDir: code => pluginLib('room-claude.ts').tasksDir(code),
};
