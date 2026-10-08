'use strict';
// test/support/worker-probe.js: preloaded (--require) into a hook process, it counts the worker threads the process
// starts and writes "WORKERS=<n>" to stderr at exit. A hook that only reads in a mirrored room must start none
// (docs/archive/REMOTE-PLAN.md PR3's gate: the bridge boots at the first op over the link).
const wt = require('node:worker_threads');

let n = 0;
const { Worker } = wt;
wt.Worker = class extends Worker { constructor(...a) { n++; super(...a); } };
process.on('exit', () => process.stderr.write(`WORKERS=${n}\n`));
