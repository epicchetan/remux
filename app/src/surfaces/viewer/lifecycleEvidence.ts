export type HostLifecycleEvent = {
  epoch: number;
  inactiveForMs: number | null;
  reason: 'appState' | 'connect' | 'tabActive';
  state: 'active' | 'background' | 'inactive';
};

export class HostLifecycleEvidenceClock {
  private epoch = 0;
  private inactiveDurationKnown: boolean;
  private inactiveSinceMs: number | null;
  private state: HostLifecycleEvent['state'];

  constructor(initialState: HostLifecycleEvent['state'], nowMs: number | null) {
    this.state = initialState;
    this.inactiveSinceMs = initialState === 'active' ? null : nowMs;
    this.inactiveDurationKnown = initialState !== 'active' && nowMs !== null;
  }

  sample(
    state: HostLifecycleEvent['state'],
    reason: HostLifecycleEvent['reason'],
    nowMs: number | null,
  ): HostLifecycleEvent {
    let inactiveForMs: number | null = null;
    if (state !== this.state) {
      const previous = this.state;
      this.state = state;
      this.epoch += 1;
      if (state === 'active') {
        if (
          previous !== 'active'
          && this.inactiveDurationKnown
          && nowMs !== null
          && this.inactiveSinceMs !== null
        ) {
          inactiveForMs = Math.max(0, nowMs - this.inactiveSinceMs);
        }
        this.inactiveSinceMs = null;
        this.inactiveDurationKnown = false;
      } else if (previous === 'active') {
        this.inactiveSinceMs = nowMs;
        this.inactiveDurationKnown = nowMs !== null;
      }
    }

    return {
      epoch: this.epoch,
      inactiveForMs,
      reason,
      state,
    };
  }
}
