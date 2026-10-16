/**
 * cost: an approximate run cost for checks/context.ts: tokens from every transcript (main + subagents) of the
 * seats and the room's Claude within the run, at list prices (scripts/baselines.json prices).
 */
import fs from 'node:fs';
import path from 'node:path';
import * as metrics from '../metrics.ts';
import * as paths from '../lib/paths.ts';
import { jsonl } from '../lib/io.ts';
import type { CaptureRec, TEntry } from '../metrics.ts';

/** cost({index, runStart, seats})() → "≈ $X (model $Y, …; …)". */
export function runCost({ index, runStart, seats = ['alice', 'bob'] }: { index: CaptureRec[], runStart: string, seats?: string[] }): () => string {
  return function cost() {
    const P = metrics.BASELINES.prices;
    const price = (m: string): number[] => {
      const row = Object.entries(P).find(([k]) => k !== 'default' && m.includes(k))?.[1] ?? P.default;
      if (!row) throw new Error('scripts/baselines.json prices: no default');
      return row;
    };
    let usd = 0;
    const last = index.map(r => r.time).sort().at(-1);
    const until = last !== undefined ? new Date(Date.parse(last) + 60_000).toISOString() : ''; // not later runs
    const seen = new Set<string | undefined>();
    const byModel: Record<string, number> = {};
    const walk = (d: string): void => {
      let es: fs.Dirent[] = [];
      try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
      for (const x of es) {
        const p = path.join(d, x.name);
        if (x.isDirectory()) { walk(p); continue; }
        if (!x.name.endsWith('.jsonl')) continue;
        for (const e of jsonl<TEntry>(p)) {
          const u = e.message && e.message.usage;
          if (!u || e.type !== 'assistant' || (runStart && e.timestamp !== undefined && e.timestamp < runStart) || (until && e.timestamp !== undefined && e.timestamp > until)) continue;
          const id = e.message?.id || e.uuid;
          if (seen.has(id)) continue;
          seen.add(id);
          const m = e.message?.model || '';
          const [i = 0, o2 = 0, cw = 0, cr = 0] = price(m); // [input, output, cache write, cache read]
          const c = ((u.input_tokens || 0) * i + (u.output_tokens || 0) * o2 + (u.cache_creation_input_tokens || 0) * cw + (u.cache_read_input_tokens || 0) * cr) / 1e6;
          usd += c; byModel[m] = (byModel[m] || 0) + c;
        }
      }
    };
    for (const seat of [...seats, 'carol']) walk(paths.seatProjectDir(seat)); // the room Claude's transcript is in the first seat's folder
    return `≈ $${usd.toFixed(2)} (${Object.entries(byModel).map(([m, c]) => `${m.replace(/^claude-/, '')} $${c.toFixed(2)}`).join(', ')}; list-price estimate from transcript token usage within the run)`;
  };
}

