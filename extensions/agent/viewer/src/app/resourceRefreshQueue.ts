export class ResourceRefreshQueue<Key> {
  private refreshAll = false;
  private readonly keys = new Set<Key>();
  private readonly waiters: Array<{
    reject: (reason: unknown) => void;
    resolve: () => void;
  }> = [];
  private running = false;

  constructor(private readonly run: (keys?: Key[]) => Promise<void>) {}

  enqueue(keys?: Key[]): Promise<void> {
    if (keys?.length === 0) return Promise.resolve();
    if (keys === undefined) {
      this.refreshAll = true;
      this.keys.clear();
    } else if (!this.refreshAll) {
      for (const key of keys) this.keys.add(key);
    }

    const result = new Promise<void>((resolve, reject) => {
      this.waiters.push({ reject, resolve });
    });
    if (!this.running) {
      this.running = true;
      queueMicrotask(() => void this.drain());
    }
    return result;
  }

  private async drain() {
    while (this.refreshAll || this.keys.size > 0) {
      const keys = this.refreshAll ? undefined : [...this.keys];
      this.refreshAll = false;
      this.keys.clear();
      const waiters = this.waiters.splice(0);
      try {
        await this.run(keys);
        for (const waiter of waiters) waiter.resolve();
      } catch (error) {
        for (const waiter of waiters) waiter.reject(error);
      }
    }
    this.running = false;
  }
}
