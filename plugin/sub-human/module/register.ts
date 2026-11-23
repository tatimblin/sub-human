// The hooks module hooks.json names: it wires each part's hooks and does nothing else. Every `$` call sits in the file
// that registers its hook (a `$` passed across a function or file doesn't load); the parts share plain data only.
import type { On } from 'claude-code';
import { registerCapture } from './capture.js';
import { registerContext } from './context.js';
import { registerFollow } from './follow.js';
import { registerMessages } from './messages.js';
import { registerStatus } from './status.js';
import { registerTools } from './tools.js';
import { registerTasks } from './tasks.js';
import { admitCards } from './admit.js';
import { registerWake } from './wake.js';
import { registerPlans } from './plans.js';

export function register(on: On): void {
  registerFollow(on);
  registerCapture(on);
  registerContext(on);
  registerStatus(on);
  registerTools(on);
  registerTasks(on);
  admitCards(on);
  registerMessages(on);
  registerWake(on);
  registerPlans(on);
}
