// Preloaded (`--import`) into a daemon a test starts, as a stand-in for a sandbox whose listener has gone away (seccomp
// user-notify): once the file $SUB_HUMAN_ENOSYS names exists, every exclusive open (`'wx'`: a lock, a crash-safe write,
// the write probe) fails with ENOSYS. Reads, stat and mkdir still work, as they do there.
import fs from 'node:fs';
import fsp from 'node:fs/promises';

const marker = process.env.SUB_HUMAN_ENOSYS;
const open = fsp.open.bind(fsp);
fsp.open = (...a: Parameters<typeof fsp.open>): ReturnType<typeof fsp.open> => {
  const [file, flags] = a;
  if (marker !== undefined && typeof flags === 'string' && flags.includes('x') && fs.existsSync(marker)) {
    const e = Object.assign(new Error(`ENOSYS: function not implemented, open '${String(file)}'`), { code: 'ENOSYS', syscall: 'open' });
    return Promise.reject(e);
  }
  return open(...a);
};
