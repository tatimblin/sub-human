'use strict';
// S4: let's plan: B @claude, the room's Claude proposes, each approver reads it in the plan view
const fs = require('node:fs');
const path = require('node:path');
const metrics = require('../metrics.js');
const { readText, esc } = require('../lib/io.js');

module.exports = {
  scene: 'S4',
  run(x, { det }) {
    const { log, roomDir, props, DEMO, A, B } = x;
    const ask = log.find(e => e.kind === 'say' && e.from === B && e.via === 'human' && e.to === 'claude' && e.text === DEMO.plan4);
    det(`${B}'s "@claude let's plan …" byte-exact, via=human, to=claude`, !!ask, ask ? `#${ask.id}` : 'not logged verbatim');
    const p1 = props[0];
    det(`The room's Claude proposes: proposal from claude naming ${A} and ${B}, plan stored by hash`, p1 && p1.from === 'claude' && [A, B].every(n => (p1.approvers || []).includes(n)) && fs.existsSync(path.join(roomDir, 'plans', `${p1.hash}.md`)),
      p1 ? `${x.fmt(p1)} approvers ${p1.approvers.join(',')}; plans/${p1.hash}.md ${fs.existsSync(path.join(roomDir, 'plans', `${p1.hash}.md`)) ? 'present' : 'missing'}` : 'no proposal');
    const ow = ask && x.entries('claude').find(e => e.timestamp > ask.at && metrics.trigger(e));
    det(`The room's Claude is woken by ${B}'s @claude line`, !!ow, ow ? `${metrics.trigger(ow)} at ${ow.timestamp.slice(11, 19)}` : 'no claude wake after it');
    // the proposal opens in the native plan dialog (scrollable, hooks/consent.ts); the card is the fallback
    let title = '';
    try { title = (fs.readFileSync(path.join(roomDir, 'plans', `${p1.hash}.md`), 'utf8').split('\n').map(l => l.replace(/^\s*(#{1,6}\s+|[-*+>]\s+)/, '').replace(/[*_`]/g, '').trim()).find(Boolean) || '').slice(0, 40); } catch { /* none */ }
    const firstPage = seat => x.caps('S4', seat).find(r => r.caption.startsWith('The room\'s Claude proposes'))?.step ?? 'last';
    for (const seat of [A, B]) {
      // the plan view's first page (S4 step 1: the title); later S4 steps are alice paging down
      const st4 = firstPage(seat);
      const t = x.cap('S4', seat, st4) || '';
      const view = /Would you like to proceed\?/.test(t) && /Tell Claude what to change|No, keep planning/.test(t) && !!title && t.includes(title);
      const m = new RegExp(`Agree to proposal (${p1 ? esc(p1.hash) : '[0-9a-f]{12}'})\\?`).exec(t);
      const opts = /1\. Not yet/.test(t) && /2\. Agree/.test(t) && /3\. Object/.test(t);
      det(`${seat} reads the proposal in the native plan view (Yes / Tell Claude what to change), or on the fallback card`, view || (m && opts && /Consent/.test(t)),
        view ? `plan view showing "${title}" (${x.capName('S4', seat, st4)})` : m ? `card ${m[0]}; options ${opts ? 'Not yet/Agree/Object' : 'missing'} (${x.capName('S4', seat, st4)})` : `no plan view or card in ${x.capName('S4', seat, st4)}`);
    }
    // alice pages through the whole proposal (PgDn) to its end: the hook's "room proposal HASH" line under the plan
    const pages = x.caps('S4', A).filter(r => /reads the whole proposal/.test(r.caption));
    const endT = pages.length ? readText(path.join(x.screens, pages.at(-1).txt)) || '' : x.cap('S4', A, firstPage(A)) || '';
    const endOk = p1 && new RegExp(`room proposal ${esc(p1.hash)}`).test(endT);
    det(`${A} reads the whole proposal: PgDn pages through the plan view to its end (the "room proposal HASH" line)`, endOk && /Would you like to proceed\?/.test(endT),
      `${pages.length} PgDn page capture(s) (${pages.map(r => r.txt).join(', ') || 'none'}); last shows ${endOk ? `"room proposal ${p1.hash}"` : 'no end line'}`);
  },
};
