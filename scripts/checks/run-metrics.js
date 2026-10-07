'use strict';
// Metrics: the run's cost of the room against the baselines (scripts/baselines.json)
const metrics = require('../metrics.js');

module.exports = {
  scene: 'Metrics',
  run(x, { det, beh }, T) {
    const M = x.metrics = metrics.measure({ screens: x.screens, home: x.home, code: x.code });
    if (M.error) { det('Run metrics computed', false, M.error); return; }
    const B = metrics.BASELINE, P = metrics.PHASE0, S = metrics.STOAT;
    const per = s => `${s} ${M.seats[s].wakes.turns}`;
    beh(`Room-caused model wakes ≤ ${T.wakes} (${B.run} ${B.wakes.total}; Phase 0 ${P.wakes.total}; ${S.run} ${S.wakes.total})`, M.total.wakes, T.wakes,
      `${M.total.wakes} wakes (${['orch', 'alice', 'bob'].map(per).join(', ')}); plugin prompts (${M.total.pluginWakes}), Monitor events (${M.total.notices}), peer deliveries and row-rewake that started a turn`);
    // D3: people's words, joins and leaves are chat rows plus an isMeta copy; none starts a model turn
    const C = M.total.chat;
    det('Chat bursts cost 0 model calls (D3)', C.notices > 0 && C.calls === 0,
      `${C.notices} chat rows, ${C.pulls} isMeta copies; ${C.turns} turn(s) / ${C.calls} model call(s) started by chat alone (${C.callsPerBurst} per burst)`);
    det('Member join text small (report)', M.total.joinChars.every(n => n > 0 && n <= T.joinBlock), `alice ${M.seats.alice.injected.join}, bob ${M.seats.bob.injected.join} chars (${B.run} ${B.joinChars.alice}/${B.joinChars.bob}; Phase 0 ${P.joinChars.alice}/${P.joinChars.bob}; ${S.run} ${S.joinChars.alice}/${S.joinChars.bob})`);
    beh(`UI noise lines per capture ≤ ${T.noisePerCapture} (${B.run} ${B.noise.perCapture}; Phase 0 ${P.noise.perCapture}; ${S.run} ${S.noise.perCapture})`, M.total.noise.perCapture, T.noisePerCapture,
      `${M.total.noise.lines} lines / ${M.total.noise.captures} captures = ${M.total.noise.perCapture} (excl. "Waiting for": ${M.total.noise.perCaptureExWaiting})`);
    det('No red or "hook error" lines in any capture', M.total.noise.red === 0 && M.total.noise.hookError === 0, `red lines ${M.total.noise.red}, "hook error" lines ${M.total.noise.hookError}`);
    // a plan-view review: ToolSearch + EnterPlanMode + ExitPlanMode to open, one reply (plus the exit after an objection)
    beh(`Model calls per review ≤ ${T.callsPerReview} on the approver's model (report)`, M.total.cards.count > 0 ? M.total.cards.perCard : null, T.callsPerReview,
      `${M.total.cards.count} reviews: ${M.total.cards.toCard} call(s) to open, ${M.total.cards.after} after the answer (avg ${M.total.cards.perCard})`);
  },
};
