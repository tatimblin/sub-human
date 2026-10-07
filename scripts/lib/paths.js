'use strict';
/**
 * paths: the one place the scripts reach into the plugin for its paths (read-only imports).
 *
 *   home()            the sub-human home: plugin lib/identity.js home() ($SUB_HUMAN_HOME or ~/.sub-human)
 *   demoHome()        the demo's home when $SUB_HUMAN_HOME is unset: /tmp/sh-demo/home (scripts/demo.sh)
 *   taskListId(code)  "sh-CODE", tasksDir(code): the orch's native task list (plugin lib/orch.js)
 *   claudeDir()       $CLAUDE_CONFIG_DIR or ~/.claude; projectsDir(): its projects/
 *   seatProjectDir(seat)  a demo seat's transcript folder (seats work in /tmp/sh-demo/SEAT = /private/tmp/…)
 *   pluginLib(name)   require plugin/sub-human/lib/<name> (e.g. 'room.js' for validateChain)
 *
 * If the plugin moves one of these, fix it here.
 */
const os = require('node:os');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..', '..');
const PLUGIN = path.join(REPO, 'plugin', 'sub-human');
const pluginLib = name => require(path.join(PLUGIN, 'lib', name));

const DEMO_BASE = '/tmp/sh-demo';
// required on first use, so a script that needs only one lib (probe-cc: cc.js) loads only that one
const home = () => pluginLib('identity.js').home();
const demoHome = () => process.env.SUB_HUMAN_HOME || path.join(DEMO_BASE, 'home');
const claudeDir = () => process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const projectsDir = () => path.join(claudeDir(), 'projects');
const seatProjectDir = seat => path.join(projectsDir(), `-private-tmp-sh-demo-${seat}`);

module.exports = {
  REPO, PLUGIN, DEMO_BASE, pluginLib,
  home, demoHome, claudeDir, projectsDir, seatProjectDir,
  taskListId: code => pluginLib('orch.js').taskListId(code), tasksDir: code => pluginLib('orch.js').tasksDir(code),
};
