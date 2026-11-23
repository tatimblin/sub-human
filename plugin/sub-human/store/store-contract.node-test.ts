// The RoomStore contract over the memory and fs backends.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { storeContract } from '../test/support/store-contract.js';
import { MemoryStore, memoryRoom } from './memory-store.js';
import { FsStore } from './fs-store.js';
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
    const o = every === undefined ? {} : { every };
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
