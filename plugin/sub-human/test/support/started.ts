import fs from 'node:fs';
/**
 * test/support/started.ts: a preload (NODE_OPTIONS=--import) that writes Date.now() to $SUB_HUMAN_TEST_STARTED
 * once the main script's synchronous start has run (setImmediate fires after it). A test that must act after a
 * child's first step (e.g. the tail's first seat lookup) waits for this file instead of sleeping a guess, which
 * a loaded machine outran. Test only.
 */
const file = process.env.SUB_HUMAN_TEST_STARTED;
if (file) {
  delete process.env.SUB_HUMAN_TEST_STARTED; // not for the child's own children
  setImmediate(() => fs.writeFileSync(file, String(Date.now())));
}
