'use strict';
/**
 * captures: the pane captures (screens/index.json + *.txt) and the per-step state demo.sh saved
 * (screens/state/SCENE/N), for checks/context.js.
 *
 *   cap, caps, capName       a seat's capture text, records and file name in a scene (step 1, N or 'last')
 *   span(scene)              {from, to}: the previous scene's last capture to this scene's last capture
 *   runStart                 3 minutes before the first capture ('' with none)
 *   stateDir, st, stText, nativeTasks, stateFile   the per-step state files
 */
const fs = require('node:fs');
const path = require('node:path');
const { readJson, readText } = require('../lib/io.js');

function captures({ screens, index }) {
  const caps = (scene, seat) => index.filter(r => r.scene === scene && r.session === `sh-${seat}`);
  const pick = (scene, seat, step) => { const rs = caps(scene, seat); return step === 'last' ? rs.at(-1) : rs.find(x => x.step === step); };
  const cap = (scene, seat, step = 1) => { const r = pick(scene, seat, step); return r ? readText(path.join(screens, r.txt)) : null; };
  const capName = (scene, seat, step = 1) => { const r = pick(scene, seat, step); return r ? r.txt : `(no ${scene} step ${step} capture of sh-${seat})`; };
  const win = scene => { const rs = index.filter(r => r.scene === scene); return rs.length ? { from: rs.map(r => r.time).sort()[0], to: rs.map(r => r.time).sort().at(-1) } : null; };
  // a scene's window runs from the previous scene's last capture to its own last capture
  const sceneOrder = [...new Set(index.map(r => r.scene))];
  const span = scene => {
    const w = win(scene); if (!w) return null;
    const i = sceneOrder.indexOf(scene);
    const prev = i > 0 ? win(sceneOrder[i - 1]) : null;
    return { from: prev ? prev.to : new Date(Date.parse(w.from) - 180_000).toISOString(), to: w.to };
  };
  const runStart = index.length ? new Date(Date.parse(index.map(r => r.time).sort()[0]) - 180_000).toISOString() : '';
  const stateDir = (scene, step) => {
    const d = path.join(screens, 'state', scene);
    let steps = [];
    try { steps = fs.readdirSync(d).filter(x => /^\d+$/.test(x)).map(Number).sort((a, b) => a - b); } catch { /* none */ }
    const s = step === 'last' ? steps.at(-1) : step;
    return s ? path.join(d, String(s)) : null;
  };
  const st = (scene, step, file, d) => { const dir = stateDir(scene, step); return dir ? readJson(path.join(dir, file), d) : d; };
  const stText = (scene, step, file) => { const dir = stateDir(scene, step); return dir ? readText(path.join(dir, file)) : null; };
  const nativeTasks = (scene, step) => { const dir = stateDir(scene, step); const d = dir && path.join(dir, 'native-tasks'); try { return fs.readdirSync(d).map(f => readJson(path.join(d, f), null)).filter(Boolean); } catch { return []; } };
  const stateFile = (...p) => path.join(screens, 'state', ...p);
  return { caps, cap, capName, span, runStart, stateDir, st, stText, nativeTasks, stateFile };
}

module.exports = { captures };
