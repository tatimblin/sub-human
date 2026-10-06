#!/usr/bin/env node
'use strict';
// Join / leave notices for the human, with no model turn (lib/notices.js).
//   SessionStart (every source): create this session's notice file <home>/notices/<session_id>.json and return
//     it as `watchPaths`, so Claude Code's file watcher runs the FileChanged hook below when it changes.
//   FileChanged: the room monitor (bin/sub-human tail) wrote a join or a settled leave there. Return the
//     notices this member has not seen as `systemMessage`: Claude Code shows a FileChanged systemMessage as a
//     footer notification and never sends it to the model. Record them as shown (at-room.js shows the rest on
//     the next prompt).
//   SessionEnd: remove the file (a /clear starts a new one under the new session id).
const path = require('node:path');
const { run, out, whoami } = require('./common.js');
const notices = require(path.join(__dirname, '..', 'lib', 'notices.js'));

run(input => {
  const ev = input.hook_event_name;
  if (ev === 'SessionStart') {
    const f = notices.ensure(input.session_id);
    if (f) out({ hookSpecificOutput: { hookEventName: 'SessionStart', watchPaths: [f] } });
    return;
  }
  if (ev === 'SessionEnd') return notices.remove(input.session_id);
  if (ev !== 'FileChanged' || input.event === 'unlink') return;
  const f = String(input.file_path || '');
  if (path.basename(path.dirname(f)) !== 'notices' || !/\.json$/.test(f)) return; // /tmp vs /private/tmp: match by name
  const me = whoami(input);
  if (!me || me.role === 'orch') return;
  const seen = notices.shown(me.code, me.name);
  const items = notices.read(f).items.filter(x => x && x.code === me.code && x.name === me.name && !seen.has(x.id));
  if (!items.length) return;
  notices.markShown(me.code, me.name, items.map(x => x.id), 'notification');
  out({ systemMessage: items.map(x => x.text).join('\n') });
}, () => { /* a notice is never worth an error line */ });
