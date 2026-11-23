// The hooks module hooks.json names: it wires each part's hooks and does nothing else. Every `$` call sits in the file
// that registers its hook (a `$` passed across a function or file doesn't load); the parts share plain data only.
import type { On } from 'claude-code';
import { registerCapture } from './capture.js';
import { registerContext } from './context.js';
import { registerFollow } from './follow.js';
import { registerStatus } from './status.js';
import { registerTools } from './tools.js';
import { admitCards } from './admit.js';
// not wired yet: re-exported so validate type-checks it and the vendored diff it imports (U10 uses it)
export { planDiff } from './plan-diff.js';

export function register(on: On): void {
  registerFollow(on);
  registerCapture(on);
  registerContext(on);
  registerStatus(on);
  registerTools(on);
  admitCards(on);
}
