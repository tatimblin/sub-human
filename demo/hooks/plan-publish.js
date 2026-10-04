#!/usr/bin/env node
'use strict';
// PostToolUse(Write|Edit): publish a plan revision (plan §3.5 step 2).
// Main thread only (no agent_id). If the written file is under the plans directory, hash its bytes
// and append kind:plan_rev with plan_hash and text = the file path (project-relative when inside
// the project). Skips when the hash equals the current plan_rev's hash. This is the only caller of
// append(..., {allowPlanRev: true}).
const fs = require('node:fs');
const path = require('node:path');
const { room, run, out, asOrch, isUnder, planDirs, projectDir } = require('./common.js');

run(input => {
  if (input.agent_id) return; // subagents never publish plans (guard-room already denies the write)
  const ti = input.tool_input || {};
  const file = ti.file_path;
  if (typeof file !== 'string' || !file) return;
  const base = input.cwd || process.cwd();
  if (!isUnder(file, planDirs(), base)) return;
  const abs = path.resolve(base, file);
  let bytes;
  try { bytes = fs.readFileSync(abs); } catch { return; }
  const hash = room.hash12(bytes);
  const cur = room.currentPlan();
  if (cur && cur.hash === hash) return;

  asOrch();
  const rel = path.relative(projectDir(), abs);
  const shown = rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel : abs;
  const e = room.append({ kind: 'plan_rev', text: shown, plan_hash: hash }, { via: 'agent', allowPlanRev: true });
  out({
    hookSpecificOutput: {
      hookEventName: 'PostToolUse',
      additionalContext: `Published plan_rev #${e.id} plan=${hash}${cur ? ` (replaces ${cur.hash}; earlier sign-offs no longer count)` : ''}. Humans sign this hash with /signoff in their client.`,
    },
  });
});
