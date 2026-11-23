// Where sub-human's files live. Pure: the caller passes the environment and the user's home, so node code and the
// hooks module (which has no node:path) share one layout. Paths join with '/', which every platform node runs on takes.
import { sha256 } from './store/store.js';

/** SUB_HUMAN_HOME, or ~/.sub-human. */
export function homeDir(env: Readonly<Record<string, string | undefined>>, userHome: string): string {
  const set = env.SUB_HUMAN_HOME;
  return set !== undefined && set !== '' ? set : `${userHome}/.sub-human`;
}

const PLAIN = /^[a-z0-9_-][a-z0-9._-]{0,63}$/;
/**
 * A name as one file name, the same on a case-insensitive disk: a plain lowercase name as is; any other (a capital,
 * a space, non-ASCII, a lone surrogate, too long) as a readable prefix, `~` and a hash of its exact code units.
 */
export async function fileKey(name: string): Promise<string> {
  if (PLAIN.test(name)) return name;
  const readable = name.toLowerCase().replace(/[^a-z0-9_-]/g, '_').slice(0, 32);
  return `${readable}~${(await sha256(JSON.stringify(name))).slice(0, 32)}`;
}

/** `key` is a fileKey; a room's is never of an empty code. */
export function roomDir(home: string, key: string): string { return `${home}/rooms/${key}`; }
export function logFile(room: string): string { return `${room}/log.jsonl`; }
export function lockFile(room: string): string { return `${room}/log.lock`; }
export function tailFile(room: string): string { return `${room}/tail.json`; }
export function snapshotFile(room: string): string { return `${room}/snapshot.json`; }
export function docDir(room: string, kind: string): string { return `${room}/docs/${kind}`; }
export function docFile(room: string, kind: string, key: string): string { return `${docDir(room, kind)}/${key}.json`; }
/** Plan text, by its content hash (checked as hex before it gets here). */
export function blobFile(room: string, hash: string): string { return `${room}/plans/${hash}.md`; }
