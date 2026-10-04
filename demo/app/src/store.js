// In-memory task store. Stands in for a Postgres `tasks` table that, in
// production, holds ~4M rows and receives ~30 inserts/second at peak.

const tasks = [];
let nextId = 1;

export function createTask({ title, createdAt = new Date() }) {
  const task = { id: nextId++, title, done: false, createdAt: createdAt.toISOString() };
  tasks.push(task);
  return task;
}

// Every task, in insertion order. Callers decide ordering and slicing.
export function allTasks() {
  return tasks;
}

// Tasks ordered createdAt desc, then id desc (tiebreaker for shared timestamps).
function sortedTasks() {
  return [...tasks].sort((a, b) => {
    if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;
    return b.id - a.id;
  });
}

// Page of tasks after a given cursor, newest first. `after` is
// `{ createdAt, id }` of the last task the caller already saw, or null/undefined
// for the first page. Returns `{ tasks, hasNext }`, where `tasks.length <= limit`.
export function listTasks({ limit, after } = {}) {
  let rows = sortedTasks();
  if (after) {
    rows = rows.filter(
      (t) => t.createdAt < after.createdAt || (t.createdAt === after.createdAt && t.id < after.id)
    );
  }
  const page = rows.slice(0, limit + 1);
  return { tasks: page.slice(0, limit), hasNext: page.length > limit };
}

// Stand-in for a cheap Postgres row-count estimate (e.g. pg_class.reltuples)
// rather than a full COUNT(*).
export function approxCount() {
  return tasks.length;
}

export function reset() {
  tasks.length = 0;
  nextId = 1;
}

export function seed(n = 237) {
  const base = Date.parse('2026-09-01T00:00:00Z');
  for (let i = 0; i < n; i++) {
    // Some tasks share a timestamp, as bulk imports do in production.
    createTask({ title: `Task ${i + 1}`, createdAt: new Date(base + Math.floor(i / 3) * 60_000) });
  }
}
