export type StreamingRefreshSchedulerClock = {
  clearTimer: (timer: number) => void;
  now: () => number;
  setTimer: (callback: () => void, delayMs: number) => number;
};

const browserClock: StreamingRefreshSchedulerClock = {
  clearTimer: (timer) => window.clearTimeout(timer),
  now: () => performance.now(),
  setTimer: (callback, delayMs) => window.setTimeout(callback, delayMs),
};

export class StreamingRefreshScheduler<T> {
  private readonly cadenceMs: number;
  private readonly clock: StreamingRefreshSchedulerClock;
  private readonly key: (value: T) => string;
  private readonly run: (values: T[]) => Promise<void> | void;
  private inFlight = false;
  private lastRunStartedAt = Number.NEGATIVE_INFINITY;
  private readonly pendingByKey = new Map<string, T>();
  private timer: number | null = null;

  constructor({
    cadenceMs,
    clock = browserClock,
    key,
    run,
  }: {
    cadenceMs: number;
    clock?: StreamingRefreshSchedulerClock;
    key: (value: T) => string;
    run: (values: T[]) => Promise<void> | void;
  }) {
    this.cadenceMs = Math.max(0, cadenceMs);
    this.clock = clock;
    this.key = key;
    this.run = run;
  }

  enqueue(values: T[]) {
    for (const value of values) {
      this.pendingByKey.set(this.key(value), value);
    }
    this.schedule();
  }

  cancelPending({ resetCadence = true }: { resetCadence?: boolean } = {}) {
    this.pendingByKey.clear();
    if (this.timer !== null) {
      this.clock.clearTimer(this.timer);
      this.timer = null;
    }
    if (resetCadence) {
      this.lastRunStartedAt = Number.NEGATIVE_INFINITY;
    }
  }

  private schedule() {
    if (this.inFlight || this.timer !== null || this.pendingByKey.size === 0) {
      return;
    }

    const delayMs = Math.max(0, this.lastRunStartedAt + this.cadenceMs - this.clock.now());
    if (delayMs <= 0) {
      this.startPending();
      return;
    }

    this.timer = this.clock.setTimer(() => {
      this.timer = null;
      this.startPending();
    }, delayMs);
  }

  private startPending() {
    if (this.inFlight || this.pendingByKey.size === 0) {
      return;
    }

    const values = Array.from(this.pendingByKey.values());
    this.pendingByKey.clear();
    this.inFlight = true;
    this.lastRunStartedAt = this.clock.now();

    let result: Promise<void> | void;
    try {
      result = this.run(values);
    } catch {
      this.finishRun();
      return;
    }

    void Promise.resolve(result)
      .catch(() => undefined)
      .finally(() => this.finishRun());
  }

  private finishRun() {
    this.inFlight = false;
    this.schedule();
  }
}
