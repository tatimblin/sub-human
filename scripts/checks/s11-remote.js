'use strict';
// S11: remote: carol joins from a second home (another machine, on this one) with the line alice's /sub-human invite
// showed her (alice's card lets her in); carol's @room and her signoff are signed in her home and verified on the host; her mirror holds the
// host's lines byte for byte; nothing session-local of hers reaches the host; her link daemon stops after she leaves
const fs = require('node:fs');
const path = require('node:path');
const paths = require('../lib/paths.js');
const { readJson, readText } = require('../lib/io.js');

const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

/** Files under dir (relative paths), [] when it is missing. */
function files(dir) {
  try { return fs.readdirSync(dir, { recursive: true }).map(String); } catch { return []; }
}

module.exports = {
  scene: 'S11',
  run(x, { det }) {
    const { code, log, DEMO } = x;
    process.env.SUB_HUMAN_HOME = x.home;
    const room = paths.pluginLib('room.ts');
    const trust = e => (e ? room.humanTrust(e) : null);

    const hostId = (readJson(x.stateFile('S11', 'machine-host.json'), {}) || {}).id;
    const carolId = (readJson(x.stateFile('S11', 'machine-carol.json'), {}) || {}).id;
    const j = log.find(e => e.kind === 'member_joined' && e.from === 'carol');
    det('carol joins from a second home: member_joined carol (via system) pins her key, with her home\'s machine id, not the host\'s',
      j && j.via === 'system' && typeof j.pubkey === 'string' && j.machine && j.machine === carolId && j.machine !== hostId,
      `${x.fmt(j)}; machine ${j ? j.machine : '?'} (carol's home ${carolId || 'not saved'}, host ${hostId || 'not saved'}); pubkey ${j && j.pubkey ? 'pinned' : 'missing'}`);

    const shown = (x.cap('S11', 'alice') || '').includes(`invite to room ${code}`);
    det('alice\'s /sub-human invite shows her the invite in her pane', shown, shown ? `"invite to room ${code}" in ${x.capName('S11', 'alice')}` : `not in ${x.capName('S11', 'alice')}`);
    const LINE = /\/sub-human join \S+ [a-z]+-\d{4} \d{4}\b/;
    const quoted = ['alice', 'carol'].flatMap(s => x.inSpan(x.entries(s), x.span('S11'))).filter(e => e.type === 'assistant' && LINE.test(x.textOf(e.message && e.message.content)));
    det('no Claude sees it: no assistant text in S11 quotes the line with its PIN', quoted.length === 0, quoted.length ? `${quoted.length} assistant message(s) quote one` : 'none');

    const warned = /sub-human: (?:opened room|joined |in room )[^\n]*/.exec(x.cap('S11', 'carol') || '');
    det('carol\'s join prints no line (a join that works shows no warning-styled systemMessage)', !warned, warned ? `"${warned[0]}" in ${x.capName('S11', 'carol')}` : `none in ${x.capName('S11', 'carol')}`);

    const say = log.find(e => e.kind === 'say' && e.from === 'carol' && e.via === 'human' && e.text === DEMO.carol11);
    det('carol\'s @room is her exact words (via=human), signed in her home and verified on the host', say && trust(say) === 'verified',
      say ? `#${say.id} byte-exact; sig ${trust(say)}` : `carol's say: ${x.fmt(log.find(e => e.kind === 'say' && e.from === 'carol'))}`);
    const pane = (x.cap('S11', 'alice', 2) || '').includes(`carol: ${DEMO.carol11}`);
    det('alice\'s pane shows carol\'s words as a chat line', pane, pane ? x.capName('S11', 'alice', 2) : `not in ${x.capName('S11', 'alice', 2)}`);

    const prop = log.filter(e => e.kind === 'proposal' && e.from === 'alice' && Array.isArray(e.approvers) && e.approvers.join() === 'carol').at(-1);
    const so = prop && log.find(e => e.kind === 'signoff' && e.from === 'carol' && e.proposal_hash === prop.hash);
    const dec = prop && log.find(e => e.kind === 'decision' && e.proposal_hash === prop.hash);
    det('carol agrees in her plan view: a signoff (via=human) verified on the host, and the host decides "agreed: carol"',
      so && so.via === 'human' && trust(so) === 'verified' && dec && dec.via === 'system' && /^agreed: carol\b/.test(dec.text),
      `proposal ${x.fmt(prop)}; signoff ${x.fmt(so)} (sig ${trust(so)}); decision ${x.fmt(dec)}`);

    const mirror = readText(x.stateFile('S11', 'mirror-log.jsonl'));
    const hostLog = readText(path.join(x.roomDir, 'log.jsonl')) || '';
    const ids = (mirror || '').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l).id; } catch { return null; } });
    const prefix = !!mirror && hostLog.startsWith(mirror);
    det('carol\'s mirror is the host\'s log byte for byte, through the decision (her copy at the end of the scene)',
      prefix && !!dec && ids.includes(dec.id),
      mirror ? `${ids.length} lines, ${prefix ? 'a byte prefix of' : 'NOT a prefix of'} the host's ${hostLog.split('\n').filter(Boolean).length}; decision ${dec ? `#${dec.id} ${ids.includes(dec.id) ? 'in it' : 'missing'}` : 'none'}` : 'state/S11/mirror-log.jsonl not saved');
    const chain = x.chainOk();
    det('The host\'s chain holds (so does the mirror, a prefix of it)', chain.ok, chain.evidence);

    const lf = readJson(x.stateFile('S11', 'link-file.json'), null);
    det('carol\'s link file is private (0600) and holds a token, no longer the invite',
      lf && lf.mode === '600' && lf.token === true && lf.invite === false && lf.transport && lf.transport.kind === 'pipe',
      lf ? JSON.stringify(lf) : 'state/S11/link-file.json not saved');

    const leaked = files(x.roomDir).filter(f => /carol/.test(f) && !/^presence[/\\]carol\.json$/.test(f));
    const local = files(path.join(x.home2, 'rooms', code)).filter(f => /carol\.cursor$/.test(f));
    det('Nothing session-local of carol\'s on the host (rows, cursors, review state stay in her home)', leaked.length === 0 && local.length > 0,
      `host: ${leaked.length ? leaked.join(', ') : 'none'}; her home: ${local.join(', ') || 'no cursors'}`);

    const left = log.find(e => e.kind === 'member_left' && e.from === 'carol');
    const ls = readJson(path.join(x.home2, 'rooms', code, 'link.json'), null);
    det('carol leaves: the host logs it, and her link daemon stops on its own',
      left && ls && ls.state === 'stopped' && !alive(ls.pid),
      `${x.fmt(left)}; link ${ls ? `${ls.state}${ls.reason ? ` (${ls.reason})` : ''}, pid ${ls.pid} ${alive(ls.pid) ? 'still running' : 'gone'}` : 'no link.json in her home'}`);
  },
};
