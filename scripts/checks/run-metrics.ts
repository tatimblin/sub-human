// Metrics: the run's cost of the room against the baselines (scripts/baselines.json)
import * as metrics from '../metrics.ts';
import type { Ctx, Det, Beh } from './context.ts';
import type { Thresholds, TEntry } from '../metrics.ts';
import { clip } from '../lib/io.ts';

export const scene = 'Metrics';

/** One scene's lines from sub-human in a seat's transcript. */
export interface SceneLines { scene: string, lines: string[] }
/**
 * The lines sub-human wrote that seat saw, per scene of the run (each scene's span): the hooks module's $.ui.log rows
 * and receipts, which Claude Code keeps in the transcript as system entries ("sub-human: …", "✓ sent"), a multi-line
 * one counted by its lines; other people's words ("sub-human: bob: …", "bob's Claude …") are content and left out.
 * The transcript, not the panes: a pane capture is a sample and misses a line drawn and scrolled away between snaps.
 */
export function linesPerScene(x: Ctx, seat: string): SceneLines[] {
  const people = [...new Set([...Object.keys(x.members), x.A, x.B, 'carol'])].filter(n => n !== 'claude');
  const mine = (e: TEntry): string[] => {
    if (e.type !== 'system' || typeof e.content !== 'string') return [];
    const c = e.content;
    if (!c.startsWith('sub-human: ') && !/^[✓⧗] /.test(c)) return [];
    const body = c.replace(/^sub-human: /, '');
    return people.some(n => body.startsWith(`${n}: `) || body.startsWith(`${n}'s Claude`)) ? [] : c.split('\n');
  };
  const es = x.entries(seat).filter(e => !e.isSidechain);
  return [...new Set(x.index.map(r => r.scene))].flatMap(sc => {
    const s = x.span(sc);
    return s ? [{ scene: sc, lines: x.inSpan(es, s).flatMap(mine) }] : [];
  });
}

export function run(x: Ctx, { det, beh }: { det: Det, beh: Beh }, T: Thresholds): void {
  const M = x.metrics = metrics.measure({ screens: x.screens, home: x.home, code: x.code, seats: [x.A, x.B] });
  if ('error' in M) { det('Run metrics computed', false, M.error); return; }
  const B = metrics.BASELINE, P = metrics.PHASE0, S = metrics.PREV;
  const per = (s: string): string => `${s} ${M.seats[s]?.wakes.turns}`;
  beh(`Room-caused model wakes ≤ ${T.wakes} (${B.run} ${B.wakes.total}; Phase 0 ${P.wakes.total}; ${S.run} ${S.wakes.total})`, M.total.wakes, T.wakes,
    `${M.total.wakes} wakes (${['claude', x.A, x.B].map(per).join(', ')}); plugin prompts (${M.total.pluginWakes}), and peer deliveries that started a turn`);
  // people's words, joins and leaves are chat rows plus an isMeta copy; none starts a model turn
  const C = M.total.chat;
  det('Chat bursts cost 0 model calls (chat is shown, never a wake)', C.notices > 0 && C.calls === 0,
    `${C.notices} chat rows, ${C.pulls} isMeta copies; ${C.turns} turn(s) / ${C.calls} model call(s) started by chat alone (${C.callsPerBurst} per burst)`);
  det('Member join text small (report)', M.total.joinChars.every(n => n > 0 && n <= T.joinBlock), `${x.A} ${M.seats[x.A]?.injected.join}, ${x.B} ${M.seats[x.B]?.injected.join} chars (${B.run} ${B.joinChars.alice}/${B.joinChars.bob}; Phase 0 ${P.joinChars.alice}/${P.joinChars.bob}; ${S.run} ${S.joinChars.alice}/${S.joinChars.bob})`);
  beh(`UI noise lines per capture ≤ ${T.noisePerCapture} (${B.run} ${B.noise.perCapture}; Phase 0 ${P.noise.perCapture}; ${S.run} ${S.noise.perCapture})`, M.total.noise.perCapture, T.noisePerCapture,
    `${M.total.noise.lines} lines / ${M.total.noise.captures} captures = ${M.total.noise.perCapture} (excl. "Waiting for": ${M.total.noise.perCaptureExWaiting})`);
  det('No red or "hook error" lines in any capture', M.total.noise.red === 0 && M.total.noise.hookError === 0, `red lines ${M.total.noise.red}, "hook error" lines ${M.total.noise.hookError}`);
  // release gate: sub-human's own lines a person sees, per scene (docs/next/quiet/PRINCIPLES.md: other people's words
  // are content and not counted; nor are the native plan view, cards or rows)
  for (const seat of [x.A, x.B]) {
    const per = linesPerScene(x, seat);
    const worst = per.reduce<SceneLines | null>((w, p) => (!w || p.lines.length > w.lines.length ? p : w), null);
    beh(`${seat} sees at most ${T.linesPerScene} lines from sub-human in any scene`, worst ? worst.lines.length : null, T.linesPerScene,
      worst ? `${per.map(p => `${p.scene} ${p.lines.length}`).join(', ')}; most in ${worst.scene}: ${worst.lines.map(l => `"${clip(l, 50)}"`).join(' ')}` : `no scene with ${seat}'s transcript`);
  }
  // a plan-view review: ToolSearch + EnterPlanMode + ExitPlanMode to open, one reply (plus the exit after an objection)
  beh(`Model calls per review ≤ ${T.callsPerReview} on the approver's model (report)`, M.total.cards.count > 0 ? M.total.cards.perCard : null, T.callsPerReview,
    `${M.total.cards.count} reviews: ${M.total.cards.toCard} call(s) to open, ${M.total.cards.after} after the answer (avg ${M.total.cards.perCard})`);
}
