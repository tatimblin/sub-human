// S7: typing into the room row's view. room-chat on (the view's rule "─ @CODE ─"): the row is the room's chat, so
// alice's line is posted with her exact bytes (via=human) and drawn "you: …" in the row. Off (0.7.0's hold-row): the
// read-only hint; nothing is posted.
import { clip, esc } from '../lib/io.ts';
import { rowViewLine, hereNames, roomStatus } from '../lib/panes.ts';
import type { Ctx, Det } from './context.ts';

export const scene = 'S7';

export function run(x: Ctx, { det }: { det: Det }): void {
  const { code } = x;
  const s = x.span('S7');
  const t = x.cap('S7', 'alice') || '';
  if (t.includes(`─ @${code} ─`)) return chat(x, det, t);
  const viewing = new RegExp(`─ ${esc(code)} ─`).test(t);
  const hint = /read-only · talk in main \(@room\)/.test(t);
  det('alice\'s room row view shows the read-only hint where she typed', viewing && hint && /❯ x\b/.test(t), `${viewing ? `viewing ${code}` : 'not in the row view'}; hint ${hint ? 'shown' : 'missing'}; typed x ${/❯ x\b/.test(t) ? 'shown' : 'missing'} (${x.capName('S7', 'alice')})`);
  // the row's own line (the hold's progress, mcp/hold.ts) leads with who else is here: bob, still in the room
  const line = rowViewLine(t, code);
  const names = hereNames(line);
  det('alice\'s room row line leads with who else is here ("bob here · …")', !!line && !!names && names.includes('bob') && line.startsWith(names[0] ?? '\0'),
    line ? `"${clip(line, 120)}" (${x.capName('S7', 'alice')})` : `no row line under the hold call in ${x.capName('S7', 'alice')}`);
  const posted = x.logIn(s).filter(e => e.from === 'alice');
  det('Nothing is posted', posted.length === 0, posted.length ? posted.map(x.fmt).join('; ') : 'no alice entries in S7');
  // A row is a subagent blocked in its hold call: text typed into its view is queued and reaches the row's
  // model only when that hold returns (a join, rejoin or stop). So the true check is: if the text reached the
  // row, its answer is the one-line read-only reply (and nothing else); if it never did, nothing answered it.
  const since = s ? s.from : '';
  const got = x.rowUserText('alice', since, /^\s*x\s*$/);
  const reply = x.rowReply('alice', since);
  det('The stray text gets the one-line read-only reply when the row\'s hold next returns, or no answer at all (it never reached the row)',
    got ? !!reply : !reply,
    got ? (reply ? `"x" reached row ${got.file} at ${got.at.slice(11, 19)}; reply ${reply.at.slice(11, 19)} "${clip(reply.text, 80)}"` : `"x" reached row ${got.file} at ${got.at.slice(11, 19)} but no read-only reply`)
      : (reply ? `a read-only reply with no "x" delivered: ${clip(reply.text, 80)}` : 'the "x" never reached alice\'s row model by the end of the run (its hold did not return); no reply, nothing posted'));
}

/** room-chat on: the typed line is posted as typed and drawn as hers. */
function chat(x: Ctx, det: Det, t: string): void {
  const want = x.DEMO.row7;
  const posted = x.logIn(x.span('S7')).filter(e => e.from === 'alice' && e.kind === 'say');
  const p = posted[0];
  det('alice\'s line typed into the row is posted once, with her exact bytes, via=human',
    posted.length === 1 && !!p && p.via === 'human' && p.text === want,
    p ? `${posted.map(x.fmt).join('; ')}; text ${p.text === want ? 'byte-exact' : `"${clip(p.text, 80)}" (want "${want}")`}` : 'no say from alice in S7');
  const drawn = t.split('\n').some(l => l.trim() === `you: ${want}`);
  det('The row draws it as "you: …" (no ❯ echo of it)', drawn && !t.split('\n').some(l => /^\s*❯\s/.test(l) && l.includes(want)),
    `${drawn ? `"you: ${clip(want, 60)}"` : 'no "you: …" line'} in ${x.capName('S7', 'alice')}`);
  // who's here is on main's status line under the row's view, not the row's label
  const names = hereNames(roomStatus(t, x.code));
  det('Main\'s status line under the row names who else is here: bob', !!names && names.includes('bob'),
    `"${roomStatus(t, x.code) ?? 'no status line'}" (${x.capName('S7', 'alice')})`);
}
