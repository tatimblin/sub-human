// The RoomStore contract over the memory, fs and mirror backends.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { storeContract } from '../test/support/store-contract.js';
import { MemoryStore, memoryRoom } from '../test/support/memory-store.js';
import { FsStore } from './fs-store.js';
import { MirrorStore } from './mirror-store.js';
import { logFile, roomDir } from '../home.js';

storeContract('memory', {
  room: every => {
    const room = memoryRoom();
    return Promise.resolve({
      open: () => new MemoryStore(room, every),
      forge: (seq, edit) => { room.lines[seq - 1] = edit(room.lines[seq - 1] ?? ''); return Promise.resolve(); },
    });
  },
});

storeContract('fs', {
  room: async every => {
    const home = await fs.mkdtemp(path.join(process.env.SUB_HUMAN_HOME ?? os.tmpdir(), 'h-'));
    const dir = roomDir(home, 'room');
    const lock = { waitMs: 600_000 }; // the contract checks the chain, not the speed
    const o = every === undefined ? { lock } : { every, lock };
    const log = logFile(dir);
    return {
      open: () => new FsStore(dir, o),
      forge: async (seq, edit) => {
        const lines = (await fs.readFile(log, 'utf8')).split('\n');
        lines[seq - 1] = edit(lines[seq - 1] ?? '');
        await fs.writeFile(log, lines.join('\n'));
      },
    };
  },
});

// A mirror over a memory host: an append goes up, and the host's new lines come back down before it answers, as the
// link brings them; one sync at a time, as one link makes them. The copy starts at seq 1, so forge edits line seq.
storeContract('mirror', {
  room: async every => {
    const home = await fs.mkdtemp(path.join(process.env.SUB_HUMAN_HOME ?? os.tmpdir(), 'm-'));
    const dir = roomDir(home, 'room');
    const host = new MemoryStore(memoryRoom(), every);
    const o = every === undefined ? {} : { every };
    let sync: Promise<unknown> = Promise.resolve();
    const mirror = (): MirrorStore => new MirrorStore(dir, {
      append: async d => {
        const r = await host.append(d);
        if (!r.ok) return r;
        const run = sync.then(async () => {
          const mine = await copy.head();
          const lines = await host.read(mine.ok ? mine.value.seq : 0);
          return lines.ok ? copy.extend(lines.value) : lines;
        });
        sync = run.catch(() => undefined);
        return run;
      },
      putDoc: () => Promise.resolve(),
      putBlob: () => Promise.resolve(),
    }, o);
    const copy = mirror();
    const log = logFile(dir);
    return {
      open: mirror,
      forge: async (seq, edit) => {
        const lines = (await fs.readFile(log, 'utf8')).split('\n');
        lines[seq - 1] = edit(lines[seq - 1] ?? '');
        await fs.writeFile(log, lines.join('\n'));
      },
    };
  },
});
