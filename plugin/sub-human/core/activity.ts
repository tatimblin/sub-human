// activity: one finished tool call → what the room learns from it (R12), with no model call. File edits update the
// member's activity document (coalesced: a file already in it changes nothing); a commit, a push, a test or build run
// and a personal task change are log events; everything else is nothing. The call and its answer come from Claude
// Code, so they are read through schemas here. Whatever the secret filter refuses is dropped, never trimmed.
import * as v from '../vendor/valibot.mjs';
import type { Activity, ActivityDoc, Draft } from './entries.js';
import { LIMITS } from './entries.js';
import { refusedPath, secretIn } from './secrets.js';
import { oneLine } from './text.js';
import { bridgeOp, parseTag } from './tasks.js';

export interface Context {
  /** The member whose session made the call; a subagent's calls are theirs too (R16a). */
  readonly name: string;
  /** The absolute directory paths are shared relative to (the repo's root, else the session's cwd). */
  readonly root: string;
  /** The repo's ignore text: an ignored file is never shared. */
  readonly ignore?: string | undefined;
  readonly repo?: string | undefined;
  readonly branch?: string | undefined;
  /** The session's plans directory (`plansDir`): plan files written there are no edits. */
  readonly plans?: string | undefined;
  /** The member's activity document as it stands. */
  readonly doc?: ActivityDoc;
  /** Native task id → subject, which an update's result doesn't carry (the bridge's map, ARCHITECTURE §7). */
  readonly subjects?: ReadonlyMap<string, string>;
  readonly now: number;
}

export type Capture =
  | { readonly kind: 'doc'; readonly doc: ActivityDoc }
  | { readonly kind: 'events'; readonly events: readonly Draft<Activity>[] }
  | { readonly kind: 'none' };

const NONE: Capture = { kind: 'none' };
const DEFAULT_PLANS = '/.claude/plans/';
const TEXT_MAX = 200;
const TEST = /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test\b|\bnode\s+--test\b|\b(?:pytest|jest|vitest|mocha|rspec)\b|\b(?:go|cargo|deno|dotnet|mix|swift)\s+test\b|\bmake\s+(?:test|check)\b/;
const BUILD = /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?build\b|\b(?:cargo|go|dotnet|swift)\s+build\b|\btsc\b/;
// git's own first line for a commit: `[branch sha] subject`, or `[branch (root-commit) sha] subject`
const COMMIT_LINE = /^\[[^\]]*?\b[0-9a-f]{7,40}\] (.+)$/m;

const Call = v.looseObject({ tool: v.string() });
const Answer = v.looseObject({ result: v.unknown(), isError: v.optional(v.boolean()) });
const FilePath = v.looseObject({ file_path: v.string() });
const Command = v.looseObject({ command: v.string() });
const BashResult = v.looseObject({
  stdout: v.string(),
  gitOperation: v.optional(v.looseObject({
    commit: v.optional(v.looseObject({ sha: v.string(), kind: v.string(), branch: v.optional(v.string()) })),
    push: v.optional(v.looseObject({ branch: v.string() })),
  })),
});
const Subject = v.looseObject({ subject: v.string() });
const Updated = v.looseObject({ taskId: v.string(), statusChange: v.optional(v.object({ from: v.string(), to: v.string() })) });

/** What a finished tool call (the `tool.call` input and what `next` resolved to) adds to the room. */
export function capture(call: unknown, answer: unknown, ctx: Context): Capture {
  if (!v.is(Call, call) || !v.is(Answer, answer) || (answer.isError === true && call.tool !== 'Bash')) return NONE;
  switch (call.tool) {
    case 'Edit': case 'Write': return v.is(FilePath, call) ? edited(call.file_path, ctx) : NONE;
    case 'Bash': return v.is(Command, call) ? bash(call.command, answer, ctx) : NONE;
    case 'TaskCreate':
      return v.is(Subject, call) && !parseTag(call.subject) ? events([task(ctx, `added task: ${call.subject}`)]) : NONE;
    case 'TaskUpdate': {
      if (!v.is(Updated, answer.result)) return NONE;
      const { taskId, statusChange } = answer.result;
      const subject = ctx.subjects?.get(taskId);
      // agrees with the bridge: a tagged task's change is a room op (or nothing), never activity
      if (bridgeOp(statusChange, subject === undefined ? null : parseTag(subject)).kind !== 'activity' || !statusChange) return NONE;
      return events([task(ctx, `${VERBS[statusChange.to] ?? statusChange.to} task: ${subject ?? `#${taskId}`}`)]);
    }
    default: return NONE;
  }
}

const VERBS: Readonly<Record<string, string>> = { completed: 'completed', deleted: 'deleted', in_progress: 'started', pending: 'reopened' };

const ExitPlan = v.looseObject({ result: v.looseObject({ plan: v.string(), filePath: v.string() }) });

/** The plans directory an ExitPlanMode answer shows (its plan file's folder), or null. */
export function plansDir(answer: unknown): string | null {
  if (!v.is(ExitPlan, answer)) return null;
  const { filePath } = answer.result;
  const cut = filePath.lastIndexOf('/');
  return cut > 0 ? filePath.slice(0, cut) : null;
}

const slash = (dir: string): string => (dir.endsWith('/') ? dir : `${dir}/`);

function edited(abs: string, ctx: Context): Capture {
  const root = slash(ctx.root);
  if (!abs.startsWith(root)) return NONE; // outside the repo: not the room's business
  // a plan file is the plan flow's, not an edit (Claude Code's default plans folder, or the session's own)
  if (abs.includes(DEFAULT_PLANS) || (ctx.plans !== undefined && abs.startsWith(slash(ctx.plans)))) return NONE;
  const rel = abs.slice(root.length);
  const files = ctx.doc?.files ?? [];
  if (refusedPath(rel, ctx.ignore) || files.includes(rel)) return NONE;
  return { kind: 'doc', doc: { name: ctx.name, files: [...files, rel].slice(-LIMITS.files), at: ctx.now } };
}

function bash(command: string, answer: v.InferOutput<typeof Answer>, ctx: Context): Capture {
  const out: (Draft<Activity> | null)[] = [];
  const r = v.is(BashResult, answer.result) ? answer.result : null;
  const { commit, push } = r?.gitOperation ?? {};
  if (commit) {
    const subject = r ? COMMIT_LINE.exec(r.stdout)?.[1] : undefined;
    const verb = commit.kind === 'committed' ? 'committed' : commit.kind;
    out.push(draft(ctx, 'commit', `${verb} ${commit.sha}${subject ? `: ${subject}` : ''}`, commit.branch));
  }
  if (push) out.push(draft(ctx, 'push', `pushed ${push.branch}`, push.branch));
  const ok = answer.isError !== true;
  if (TEST.test(command)) out.push(draft(ctx, 'test', command, undefined, ok));
  else if (BUILD.test(command)) out.push(draft(ctx, 'build', command, undefined, ok));
  return events(out);
}

function task(ctx: Context, text: string): Draft<Activity> | null {
  return draft(ctx, 'task', text);
}

function draft(ctx: Context, event: Activity['event'], text: string, branch = ctx.branch, ok?: boolean): Draft<Activity> | null {
  if (secretIn(text)) return null;
  return {
    kind: 'activity', from: ctx.name, by: 'claude', event,
    text: oneLine(text, TEXT_MAX),
    ...(ok !== undefined && { ok }),
    ...(ctx.repo !== undefined && { repo: ctx.repo }),
    ...(branch !== undefined && { branch }),
  };
}

function events(drafts: readonly (Draft<Activity> | null)[]): Capture {
  const kept = drafts.filter(d => d !== null);
  return kept.length ? { kind: 'events', events: kept } : NONE;
}
