'use strict';
/**
 * cost: an approximate run cost for checks/context.js: tokens from every transcript (main + subagents) of the
 * seats and the room's Claude within the run, at list prices (scripts/baselines.json prices).
 */
const fs = require('node:fs');
const path = require('node:path');
const metrics = require('../metrics.js');
const paths = require('../lib/paths.js');
const { jsonl } = require('../lib/io.js');

/** cost({index, runStart})() → "≈ $X (model $Y, …; …)". */
function runCost({ index, runStart }) {
  return function cost() {
    const P = metrics.BASELINES.prices;
    const price = m => (Object.entries(P).find(([k]) => k !== 'default' && m.includes(k)) || [null, P.default])[1];
    let usd = 0;
    const until = index.length ? new Date(Date.parse(index.map(r => r.time).sort().at(-1)) + 60_000).toISOString() : ''; // not later runs
    const seen = new Set();
    const byModel = {};
    const walk = d => {
      let es = [];
      try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
      for (const x of es) {
        const p = path.join(d, x.name);
        if (x.isDirectory()) { walk(p); continue; }
        if (!x.name.endsWith('.jsonl')) continue;
        for (const e of jsonl(p)) {
          const u = e.message && e.message.usage;
          if (!u || e.type !== 'assistant' || (runStart && e.timestamp < runStart) || (until && e.timestamp > until)) continue;
          const id = e.message.id || e.uuid;
          if (seen.has(id)) continue;
          seen.add(id);
          const m = e.message.model || '';
          const [i, o2, cw, cr] = price(m);
          const c = ((u.input_tokens || 0) * i + (u.output_tokens || 0) * o2 + (u.cache_creation_input_tokens || 0) * cw + (u.cache_read_input_tokens || 0) * cr) / 1e6;
          usd += c; byModel[m] = (byModel[m] || 0) + c;
        }
      }
    };
    for (const seat of ['alice', 'bob', 'carol']) walk(paths.seatProjectDir(seat)); // the room Claude's transcript is in alice's folder
    return `≈ $${usd.toFixed(2)} (${Object.entries(byModel).map(([m, c]) => `${m.replace(/^claude-/, '')} $${c.toFixed(2)}`).join(', ')}; list-price estimate from transcript token usage within the run)`;
  };
}

module.exports = { runCost };
