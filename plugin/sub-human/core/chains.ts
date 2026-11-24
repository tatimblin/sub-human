// Calls run one at a time per key, in the order they came: how the daemon keeps a room's writes, a cwd's handoffs and
// the joins from racing. A call that throws rejects only its own caller; the next on its key runs on.
export class Chains {
  private readonly chains = new Map<string, Promise<unknown>>();

  /** Runs `fn` after every earlier call on `key` has finished. */
  run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const run = (this.chains.get(key) ?? Promise.resolve()).then(fn);
    this.chains.set(key, run.catch(() => undefined));
    return run;
  }

  /** Settles once every call started so far has finished. */
  async drain(): Promise<void> { await Promise.all(this.chains.values()); }
}
