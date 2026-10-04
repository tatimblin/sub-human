#!/usr/bin/env node
'use strict';
// PreToolUse(Write|Edit), members only: a session reuses one plan file for every plan cycle
// (spike 3, P3). Before the member's Claude overwrites its own local plan with a room review stub,
// copy the local plan to rooms/<code>/members/<name>/local-plan-<ts>.md and say so.
const fs = require('node:fs');
const path = require('node:path');
const { plan, run, out, whoami, memberDir, isUnder, plansRoot, stamp } = require('./common.js');

const MARK = /^sub-human:/m;

function newContent(tool, ti, old) {
  if (tool === 'Write') return typeof ti.content === 'string' ? ti.content : null;
  if (tool === 'Edit' && typeof ti.old_string === 'string' && typeof ti.new_string === 'string') {
    return ti.replace_all ? old.split(ti.old_string).join(ti.new_string) : old.replace(ti.old_string, () => ti.new_string);
  }
  return null;
}

run(input => {
  const me = whoami(input);
  if (!me || me.role === 'orch') return;
  const ti = input.tool_input || {};
  const file = ti.file_path;
  if (typeof file !== 'string' || !file) return;
  const base = input.cwd || process.cwd();
  if (!isUnder(file, plansRoot(), base)) return;
  const abs = path.resolve(base, file);
  let old;
  try { old = fs.readFileSync(abs, 'utf8'); } catch { return; }
  if (!old.trim() || MARK.test(old)) return;
  const next = newContent(input.tool_name, ti, old);
  if (next == null || !(MARK.test(next) && plan.parseFrontmatter(next))) return;
  const dir = memberDir(me);
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, `local-plan-${stamp()}.md`);
  fs.writeFileSync(dest, old);
  out({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      additionalContext: `sub-human: your local plan in ${abs} was backed up to ${dest} before the room review stub replaced it. Tell ${me.name} where it is if they ask.`,
    },
  });
});
