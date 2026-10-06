'use strict';
/** io: small read helpers shared by the scripts (never throw; missing files give the default). */
const fs = require('node:fs');

const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const readText = f => { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } };
const jsonl = f => (readText(f) || '').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
const clip = (s, n = 160) => { s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** The text of a message's content (a string, or text/tool_result blocks joined). */
const textOf = c => (typeof c === 'string' ? c : Array.isArray(c) ? c.map(x => (x && (x.text || (typeof x.content === 'string' ? x.content : ''))) || '').join('\n') : '');

module.exports = { readJson, readText, jsonl, clip, esc, textOf };
