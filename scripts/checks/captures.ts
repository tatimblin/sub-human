/**
 * captures: the pane captures (screens/index.json + *.txt) and the per-step state demo.sh saved
 * (screens/state/SCENE/N), for checks/context.ts.
 *
 *   cap, caps, capName       a seat's capture text, records and file name in a scene (step 1, N or 'last')
 *   span(scene)              {from, to}: the previous scene's last capture to this scene's last capture
 *   runStart                 3 minutes before the first capture ('' with none)
 *   stateDir, st, stText, nativeTasks, stateFile   the per-step state files
 *   holdsAt(scene, step, name)   a seat's row holds as that step saved them (session-NAME.json: its session document's
 *                            holds; holds-NAME.json from a run before the session document)
 */
import fs from 'node:fs';
import path from 'node:path';
import { readJson, readText } from '../lib/io.ts';
import type { CaptureRec } from '../metrics.ts';

/** A step of a scene: its number, or its last one. */
export type Step = number | 'last';
/** A time window: after `from`, up to and including `to` (ISO times). */
export interface Span { from: string, to: string }
/** A seat's row holds: the room row and the members inside it. */
export interface Holds { room?: string, members?: string[] }
/** A row of `claude agents --json` (state/SCENE/N/agents.json). */
export interface AgentRow { id?: string, sessionId?: string, kind?: string, name?: string, state?: string, cwd?: string }
/** A native task file (~/.claude/tasks/sh-CODE/N.json) or a tasks.json row. */
export interface TaskRec { id: string, subject?: string, status?: string, owner?: string }

export function captures({ screens, index }: { screens: string, index: CaptureRec[] }) {
  const caps = (scene: string, seat: string): CaptureRec[] => index.filter(r => r.scene === scene && r.session === `sh-${seat}`);
  const pick = (scene: string, seat: string, step: Step): CaptureRec | undefined => { const rs = caps(scene, seat); return step === 'last' ? rs.at(-1) : rs.find(x => x.step === step); };
  const cap = (scene: string, seat: string, step: Step = 1): string | null => { const r = pick(scene, seat, step); return r ? readText(path.join(screens, r.txt)) : null; };
  const capName = (scene: string, seat: string, step: Step = 1): string => { const r = pick(scene, seat, step); return r ? r.txt : `(no ${scene} step ${step} capture of sh-${seat})`; };
  const win = (scene: string): Span | null => {
    const ts = index.filter(r => r.scene === scene).map(r => r.time).sort();
    const from = ts.at(0), to = ts.at(-1);
    return from !== undefined && to !== undefined ? { from, to } : null;
  };
  // a scene's window runs from the previous scene's last capture to its own last capture
  const sceneOrder = [...new Set(index.map(r => r.scene))];
  const span = (scene: string): Span | null => {
    const w = win(scene); if (!w) return null;
    const i = sceneOrder.indexOf(scene);
    const before = sceneOrder[i - 1];
    const prev = i > 0 && before !== undefined ? win(before) : null;
    return { from: prev ? prev.to : new Date(Date.parse(w.from) - 180_000).toISOString(), to: w.to };
  };
  const first = index.map(r => r.time).sort().at(0);
  const runStart = first !== undefined ? new Date(Date.parse(first) - 180_000).toISOString() : '';
  const stateDir = (scene: string, step: Step): string | null => {
    const d = path.join(screens, 'state', scene);
    let steps: number[] = [];
    try { steps = fs.readdirSync(d).filter(x => /^\d+$/.test(x)).map(Number).sort((a, b) => a - b); } catch { /* none */ }
    const s = step === 'last' ? steps.at(-1) : step;
    return s ? path.join(d, String(s)) : null;
  };
  /** A state file's JSON (`T`: what demo.sh saved there), or d. */
  const st = <T>(scene: string, step: Step, file: string, d: T): T => { const dir = stateDir(scene, step); return dir ? readJson(path.join(dir, file), d) : d; };
  const holdsAt = (scene: string, step: Step, name: string): Holds => (st<{ holds?: Holds } | null>(scene, step, `session-${name}.json`, {}) || {}).holds || st<Holds>(scene, step, `holds-${name}.json`, {});
  const stText = (scene: string, step: Step, file: string): string | null => { const dir = stateDir(scene, step); return dir ? readText(path.join(dir, file)) : null; };
  const nativeTasks = (scene: string, step: Step): TaskRec[] => { const dir = stateDir(scene, step); const d = dir && path.join(dir, 'native-tasks'); try { return fs.readdirSync(d || '').map(f => readJson<TaskRec | null>(path.join(d || '', f), null)).filter((t): t is TaskRec => !!t); } catch { return []; } };
  const stateFile = (...p: string[]): string => path.join(screens, 'state', ...p);
  return { caps, cap, capName, span, runStart, stateDir, st, stText, nativeTasks, stateFile, holdsAt };
}

