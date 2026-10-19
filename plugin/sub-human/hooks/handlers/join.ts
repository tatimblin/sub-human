// plugin/sub-human/hooks/handlers/join.ts: UserPromptExpansion(sub-human:sub-human): every /sub-human command, run before
// the model and in place of it. A thin edge: the commands are lib/commands/index.ts (a table of verbs, each returning
// one Answer; HELP in lib/commands/help.ts has them all); this file reads who asked and renders the answer as the
// hook's one Reply (hooks/types.ts), which hooks/run.ts writes.
// Who asked: the session id, its cwd, its claude process (CLAUDE_PID, or, run by the hooks module, the shim's parent)
// and its seat (hooks/seat.ts whoami). It arms the seat key's signer (admit signs, and a seat taken pins
// its public key: hooks/seat-key.ts).
// Two ways in. Normally the hooks module runs this script for the command first (mod/deliver.ts command.run;
// sub_human_via "command.run" with the session's nonce, attested here against its lease) and shows what it says
// itself: a reply is {subHuman: {say, refused, shareable}}, which the module draws as a plain notice or as the
// command's own output, never as "blocked by hook", and a join that worked also carries the mechanics block (the
// module then lets the command expand and hands that block to the model). Without the module (classic: Claude Code
// runs this hooks.json hook itself) a reply is a block, drawn "UserPromptExpansion operation blocked by hook:
// sub-human: …".
// Out: a join that worked is the mechanics block (hooks/context.ts contextBlock) plus a one-line confirmation for the
// person (module) or a systemMessage only when something in it is a warning (the room's Claude did not start, the
// bypass-permissions mode; classic); the title comes on the next prompt (mod/prompt.ts). Everything else is a reply:
// no model turn. A PIN must never reach the model: lib/commands/index.ts run answers every prompt that may hold one
// as a secret, and a throw (fail) or a stdin that does not parse is answered the same way.
import * as identity from '../../lib/identity.ts';
import * as commands from '../../lib/commands/index.ts';
import { whoami } from '../seat.ts';
import { contextBlock } from '../context.ts';
import * as launcher from '../launcher.ts';
import * as seatKey from '../seat-key.ts';
import PathMod from 'node:path';
// the module's rules (mod/core): the command's names, which prompt may hold a PIN, and the nonce check
import { COMMANDS, mayHoldSecret } from '../../mod/core/command.ts';
import { attested as leaseAttests } from '../../mod/core/state.ts';
import { assertNever } from '../../mod/core/never.ts';
import type { JoinIn, Reply } from '../types.ts';
import type { Answer } from '../../lib/commands/types.ts';

// it signs (an admission answered with /sub-human admit): the seat-key signer, in this process only
seatKey.arm();

const ROOM_CLAUDE_AGENT = 'sub-human:room-claude';
const PLUGIN_ROOT = PathMod.join(import.meta.dirname, '..', '..');
const BYPASS = ' · ⚠ bypass-permissions mode: messages from other sessions can wait behind a dialog; restart in another mode to get them live';
/** A note in a join's message that the person must hear: the room's Claude could not start, or its last start failed. */
const TROUBLE = /could not start|the last start failed: /;

/** True when the input carries this session's module nonce (its lease's): the module's command.run hook ran it. */
function attested(input: JoinIn): boolean {
  const sid = input.session_id;
  if (input.sub_human_via !== 'command.run' || typeof sid !== 'string' || typeof input.sub_human_nonce !== 'string') return false;
  return leaseAttests(identity.readModLease(sid), sid, input.sub_human_nonce);
}

/**
 * An answer as the hook's Reply. A join that worked: the mechanics block for the model, and its line for the person.
 * Through the module the line is a notice. Classic: no systemMessage, which Claude Code draws as a warning (the session
 * title and the room row say it worked), unless something in it is one.
 */
function toReply(a: Answer, input: JoinIn, module: boolean): Reply {
  switch (a.kind) {
    case 'joined': {
      launcher.refresh(); // the opt-in row status launcher and the serve shim, now that this session has rows
      const bypass = input.permission_mode === 'bypassPermissions' && a.me.role !== 'claude' ? BYPASS : '';
      const warn = bypass || TROUBLE.test(a.say) ? `sub-human: ${a.say}${bypass}` : null;
      return { kind: 'joined', context: contextBlock(a.me, a.lead), say: module ? `${a.say}${bypass}` : a.say, warn, module };
    }
    case 'secret': return { kind: 'secret', text: a.text, refused: a.refused === true, module, ...(a.pinned ? { pinned: a.pinned } : {}) };
    case 'say': case 'refused': return { kind: a.kind, text: a.text, module };
    default: return assertNever(a, 'answer');
  }
}

/** The module ran this (sub_human_via "command.run") but this session's lease does not hold its nonce (gone, or
 * another's): nothing runs, and the module is told so ({subHuman: {lease: 'stale'}}), says hello again and asks once
 * more. Before, such a run was answered as a classic block, which the module cannot read ("did not finish here"). */
const STALE: Reply = { kind: 'classic', outputs: [{ subHuman: { lease: 'stale' } }], stderr: 'sub-human: this session\'s hooks-module lease did not hold the nonce' };

export function handle(input: JoinIn): Reply | null {
  if (!COMMANDS.includes(String(input.command_name))) return null;
  const args = String(input.command_args || '').trim().split(/\s+/).filter(Boolean);
  const module = attested(input);
  if (!module && input.sub_human_via === 'command.run') return STALE;
  // the module's $.process.run child has no CLAUDE_PID of this session: its parent is the claude process
  const pid = identity.claudePid() || (module ? process.ppid : null);
  // the module seating a join the host let in, on its own (mod/deliver.ts takeSeat): only from the module, never typed
  const take = module && !args.length && identity.isRoomCode(input.sub_human_take) ? input.sub_human_take : null;
  const a = commands.run(args, {
    ...(take ? { take } : {}),
    sid: input.session_id, cwd: input.cwd || process.cwd(), pid, roomClaudeAgent: input.agent_type === ROOM_CLAUDE_AGENT, module,
    pubkey: seatKey.publicPem, pluginRoot: PLUGIN_ROOT, seat: () => whoami(input),
  });
  return toReply(a, input, module);
}

/** A throw anywhere, or a stdin that does not parse: still one reply, hidden unless the prompt surely holds no PIN (an
 *  input with no command_args to read may hold one), so a PIN-bearing prompt never reaches the model as a plain
 *  expansion. */
export function fail(err: unknown, input: JoinIn | null | undefined): Reply {
  const args = input && typeof input.command_args === 'string' ? input.command_args : null;
  let module = false;
  try { module = !!input && attested(input); } catch { /* classic */ }
  const m = err instanceof Error ? err.message : String(err);
  const [first = ''] = m.split('\n');
  const text = `sub-human could not run that (${first.slice(0, 200)}). Run /sub-human doctor.`;
  return args === null || mayHoldSecret(args) ? { kind: 'secret', text, refused: true, module } : { kind: 'refused', text, module };
}
