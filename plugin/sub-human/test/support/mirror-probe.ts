// test/remote-reconnect.node-test.ts: one MirrorRoomStore.place in its own process (the bridge blocks the calling thread,
// so the fake daemon socket lives in the test's process). argv: code, mirror dir, payload JSON. Prints the outcome.
import { MirrorRoomStore } from '../../lib/room/store-mirror.ts';

const [code, dir, payload] = process.argv.slice(2);
let out: object;
try {
  out = { ok: true, placed: new MirrorRoomStore(code, { dir }).place(JSON.parse(payload), { queue: true }) };
} catch (err) {
  const e = err as Error & { code?: string; unknown?: boolean };
  out = { code: e.code, message: e.message, unknown: e.unknown };
}
process.stdout.write(JSON.stringify(out));
process.exit(0);
