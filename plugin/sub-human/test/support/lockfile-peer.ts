/**
 * test/support/lockfile-peer.ts: a peer that speaks proper-lockfile's protocol (the lock Claude Code bundles for its
 * task files), with no dependency: mkdir(<realpath(target)>.lock), its mtime refreshed while held, a dir older than
 * 10 s stale and removed, release by rmdir; retries 5 to 100 ms apart. test/tasklock.node-test.ts races it against
 * lib/cc/tasklock.ts.
 *
 *   node lockfile-peer.ts TARGET COUNTER N   N times: lock TARGET, read COUNTER, wait a little, write it plus one, unlock
 */
import fs from 'node:fs';

const [target = '', counter = '', n = '0'] = process.argv.slice(2);
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function lock(t: string): Promise<() => void> {
  const dir = `${fs.realpathSync(t)}.lock`;
  for (let wait = 5; ; wait = Math.min(wait * 2, 100)) {
    try {
      fs.mkdirSync(dir);
      const refresh = setInterval(() => { try { const now = new Date(); fs.utimesSync(dir, now, now); } catch { /* gone */ } }, 5000);
      return () => { clearInterval(refresh); fs.rmdirSync(dir); };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      try { if (fs.statSync(dir).mtimeMs < Date.now() - 10_000) fs.rmdirSync(dir); } catch { /* released */ }
      await sleep(wait);
    }
  }
}

for (let i = 0; i < Number(n); i++) {
  const release = await lock(target);
  const v = Number(fs.readFileSync(counter, 'utf8')) || 0;
  await sleep(1);
  fs.writeFileSync(counter, String(v + 1));
  release();
}
