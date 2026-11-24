// The four command hooks (hooks.json), which keep working where policy turns user modules off (PRD C1): stdin in, one
// Reply out. Each payload passes its valibot schema first; a payload that doesn't is answered with nothing. Only the
// expansion loads the verbs, so SessionStart, Notification and SessionEnd stay cheap.
import * as v from '../vendor/valibot.mjs';
import type { Ctx } from './types.js';

/** What a command hook prints on stdout (one JSON object), on stderr (shown to the person only), and its exit code. */
export interface Reply { readonly out?: object; readonly err?: string; readonly exit: 0 | 1 }
/** Builds the verbs' context for a session, once its payload has passed. */
export type MakeCtx = (session: string, cwd: string) => Ctx;
const NOTHING: Reply = { exit: 0 };

const base = { session_id: v.pipe(v.string(), v.minLength(1)), cwd: v.string() };
type Base = { readonly session_id: string; readonly cwd: string };

export type Hook = 'expand' | 'start' | 'notify' | 'end';
type Handler = (input: unknown, ctx: MakeCtx) => Promise<Reply>;

function hook<S extends v.GenericSchema<unknown, Base>>(schema: S, fn: (p: v.InferOutput<S>, c: Ctx) => Promise<Reply>): Handler {
  return async (input, ctx) => {
    const p = v.safeParse(schema, input);
    return p.success ? fn(p.output, ctx(p.output.session_id, p.output.cwd)) : NOTHING;
  };
}

/** /clear and /resume end one session and start the next in the same place: the room goes with them (ExitReason). */
const MOVES: ReadonlySet<string> = new Set(['clear', 'resume']);
const title = (t: string): Reply => ({ out: { hookSpecificOutput: { hookEventName: 'SessionStart', sessionTitle: t } }, exit: 0 });

export const HOOKS: Readonly<Record<Hook, Handler>> = {
  /**
   * UserPromptExpansion of /room: a block ends the expansion with the answer for the person and no model turn,
   * and the typed prompt is never echoed (a join line may carry a secret).
   */
  expand: hook(v.object({ ...base, command_args: v.optional(v.string(), '') }), async (p, c) => {
    const { runCommand } = await import('./index.js');
    const a = await runCommand(p.command_args, c);
    return {
      out: { decision: 'block', reason: `sub-human: ${a.text}`, hookSpecificOutput: { hookEventName: 'UserPromptExpansion', suppressOriginalPrompt: true } },
      exit: 0,
    };
  }),
  /**
   * SessionStart: a session still in a room (compact, a resumed crash) takes back the title its join gave it, unless
   * it has a title already. After /clear or /resume the new session claims the room its predecessor handed on here.
   */
  start: hook(v.object({ ...base, source: v.optional(v.string(), ''), session_title: v.optional(v.string(), '') }), async (p, c) => {
    // a title the session already has stays: the person's own (a /rename) outranks NAME.CODE
    const named = (t: string): Reply => (p.session_title ? NOTHING : title(t));
    const m = await c.sessions.get(c.session);
    if (m) return named(m.title);
    if (!MOVES.has(p.source)) return NOTHING;
    const claimed = await c.daemon.claim(c.session, c.cwd);
    if (!claimed.ok) return { err: `sub-human: this session didn't take its room back: ${claimed.error}. Type /room.`, exit: 1 };
    return claimed.value ? named(claimed.value.title) : NOTHING;
  }),
  /**
   * Notification: a permission prompt marks the member waiting, best-effort (it comes about 6 s late). The module's
   * turn.start presence write clears it on the next turn.
   */
  notify: hook(v.object({ ...base, notification_type: v.string() }), async (p, c) => {
    const m = await c.sessions.get(c.session);
    if (!m || p.notification_type !== 'permission_prompt') return NOTHING;
    const r = await c.daemon.putDoc(m.code, { kind: 'presence', doc: { name: m.name, state: 'working', waiting: true, at: c.now() } });
    return r.ok ? NOTHING : { err: `sub-human: ${m.name} isn't shown as waiting in ${m.code}: ${r.error}`, exit: 1 };
  }),
  /**
   * SessionEnd: the member is away and the pointer goes; only /room leave leaves the room. /clear and /resume
   * hand the pointer on to the next session instead.
   */
  end: hook(v.object({ ...base, reason: v.optional(v.string(), '') }), async (p, c) => {
    const m = await c.sessions.get(c.session);
    if (!m) return NOTHING;
    const r = MOVES.has(p.reason) ? await c.daemon.handoff(m.id, c.cwd) : await c.daemon.retire(m.id);
    return r.ok ? NOTHING : { err: `sub-human: ${m.name} isn't shown away in ${m.code}: ${r.error}`, exit: 1 };
  }),
};
export const isHook = (s: string | undefined): s is Hook => s !== undefined && Object.hasOwn(HOOKS, s);
