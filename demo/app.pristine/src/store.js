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
