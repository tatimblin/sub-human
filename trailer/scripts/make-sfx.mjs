#!/usr/bin/env node
/**
 * make-sfx: synthesises public/sfx/key-click.wav, a soft 25 ms key click (a filtered noise burst with a fast
 * decay), so the optional key-click track needs no third-party asset.  node scripts/make-sfx.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const out = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public/sfx/key-click.wav');
const rate = 44100;
const n = Math.round(rate * 0.025);
const samples = new Int16Array(n);
let seed = 42;
let lp = 0;
for (let i = 0; i < n; i++) {
  seed = (seed * 16807) % 2147483647;
  const noise = (seed / 2147483647) * 2 - 1;
  lp += 0.35 * (noise - lp); // one-pole low-pass: take the hiss off
  const env = Math.exp(-i / (rate * 0.004)) * Math.min(1, i / 20);
  const thump = Math.sin((2 * Math.PI * 180 * i) / rate) * Math.exp(-i / (rate * 0.006)) * 0.35;
  samples[i] = Math.round(Math.max(-1, Math.min(1, lp * env * 0.9 + thump)) * 32767 * 0.6);
}
const data = Buffer.from(samples.buffer);
const h = Buffer.alloc(44);
h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8);
h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
h.write('data', 36); h.writeUInt32LE(data.length, 40);
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, Buffer.concat([h, data]));
console.log(`wrote ${path.relative(process.cwd(), out)} (${44 + data.length} bytes)`);
