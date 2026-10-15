// test/support/worker-probe.ts: preloaded (--import) into a hook process, it counts the worker threads the process
// starts and writes "WORKERS=<n>" to stderr at exit. A hook that only reads in a mirrored room must start none
// (the bridge boots at the first op over the link).
import wt from 'node:worker_threads';
import { syncBuiltinESMExports } from 'node:module';

let n = 0;
const { Worker } = wt;
wt.Worker = class extends Worker {
  constructor(...a: ConstructorParameters<typeof Worker>) { n++; super(...a); }
};
syncBuiltinESMExports(); // lib/ imports { Worker } by name: point that binding at the counting class too
process.on('exit', () => process.stderr.write(`WORKERS=${n}\n`));
