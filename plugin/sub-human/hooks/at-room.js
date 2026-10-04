#!/usr/bin/env node
'use strict';
// UserPromptSubmit: "@room TEXT" or "room:TEXT" posts the human's exact words (via human) and
// blocks the prompt, so no model turn runs and nothing is paraphrased.
//
// The payload has no `source` field (spike 3, P2), so we skip task notifications and slash commands
// by prefix instead. Notes from the probe:
//   - the TUI trims trailing whitespace before the hook sees the prompt (documented, accepted);
//   - a long paste arrives wrapped as \n\n<pasted_content id="N">\n…\n</pasted_content id="N">\n;
//     we unwrap it and record normalized:true (pasted tabs already became 4 spaces upstream);
//   - suppressOriginalPrompt only works inside hookSpecificOutput.
// For any other prompt from a joined member, inject the member's own @room posts that their Claude
// has not seen yet (a blocked prompt never reached the model).
const { room, out, run, whoami, context, readState, writeState } = require('./common.js');

const PASTE = /(?:\n\n)?<pasted_content id="?(\w+)"?>\n([\s\S]*?)\n?<\/pasted_content id="?\1"?>\n?/g;

function parse(prompt) {
  if (prompt.startsWith('@room ')) return prompt.slice('@room '.length);
  if (prompt === '@room') return '';
  if (prompt.startsWith('room:')) { const t = prompt.slice('room:'.length); return t.startsWith(' ') ? t.slice(1) : t; }
  return null;
}

function unwrap(text) {
  let normalized = false;
  const t = text.replace(PASTE, (_, _id, body) => { normalized = true; return body; });
  return { text: t, normalized };
}

const block = (reason, extra = {}) => out({
  decision: 'block', reason,
  hookSpecificOutput: { hookEventName: 'UserPromptSubmit', suppressOriginalPrompt: true, ...extra },
});

run(input => {
  const prompt = typeof input.prompt === 'string' ? input.prompt : '';
  if (prompt.startsWith('<task-notification>') || prompt.startsWith('/')) return;
  const raw = parse(prompt);
  const me = whoami(input);

  if (raw === null) {
    if (!me || me.role === 'orch') return;
    const seen = (readState(me, 'human_seen') || {}).id || 0;
    const mine = room.readAfter(seen).filter(e => e.from === me.name && e.via === 'human' && e.kind === 'say');
    const last = room.lastId();
    if (last > seen) writeState(me, 'human_seen', { id: last });
    if (!mine.length) return;
    const lines = mine.map(e => `#${e.id} ${JSON.stringify(e.text)}`);
    return context('UserPromptSubmit',
      `SUB-HUMAN: ${me.name} posted to room ${me.code} directly with @room since your last turn (verbatim, already in the log; do not re-post):\n${lines.join('\n')}`);
  }

  if (!me) return block('sub-human: not in a room. Join one first with /sub-human NAME CODE.');
  if (me.role === 'orch') return block(`sub-human: the orchestrator is unattended; join from another session with /sub-human NAME ${me.code} and post from there.`);
  const { text, normalized } = unwrap(raw);
  if (!text.trim()) return block('sub-human: nothing to post after @room.');
  const entry = { kind: 'say', text };
  if (normalized) entry.normalized = true;
  const e = room.append(entry, { via: 'human', from: me.name });
  block(`sub-human: posted to room ${me.code} as #${e.id}${normalized ? ' (pasted text unwrapped)' : ''}.`);
});
