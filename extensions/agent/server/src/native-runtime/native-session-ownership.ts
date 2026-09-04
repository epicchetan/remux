import type { ProviderKind } from '../../../shared/provider-runtime.ts';

export type NativeSessionOwnership = {
  provider: ProviderKind;
  providerInstanceId: string;
  sessionId: string;
  executionId: string;
  acquiredAt: number;
};

export type NativeSessionLease = {
  readonly ownership: NativeSessionOwnership;
  release(): void;
};

/**
 * Process-local control leases prevent two provider sessions from mutating the
 * same native conversation. The contract is provider-neutral so it can move to
 * the host runtime manager when independent Remux clients participate.
 */
export class NativeSessionOwnershipRegistry {
  private readonly leases = new Map<string, {
    token: symbol;
    ownership: NativeSessionOwnership;
  }>();
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  acquire(input: Omit<NativeSessionOwnership, 'acquiredAt'>): NativeSessionLease {
    const key = ownershipKey(input.provider, input.providerInstanceId, input.sessionId);
    const existing = this.leases.get(key);
    if (existing) {
      throw new Error(
        `${providerLabel(input.provider)} session ${JSON.stringify(input.sessionId)} is already controlled `
        + `by execution ${JSON.stringify(existing.ownership.executionId)}.`,
      );
    }
    const token = Symbol(key);
    const ownership = { ...input, acquiredAt: this.now() };
    this.leases.set(key, { token, ownership });
    let released = false;
    return {
      ownership,
      release: () => {
        if (released) return;
        released = true;
        if (this.leases.get(key)?.token === token) this.leases.delete(key);
      },
    };
  }

  snapshot(): readonly NativeSessionOwnership[] {
    return [...this.leases.values()]
      .map(({ ownership }) => structuredClone(ownership))
      .sort((left, right) => left.acquiredAt - right.acquiredAt ||
        left.executionId.localeCompare(right.executionId));
  }
}

function ownershipKey(provider: ProviderKind, providerInstanceId: string, sessionId: string) {
  return `${provider}\0${providerInstanceId}\0${sessionId}`;
}

function providerLabel(provider: ProviderKind) {
  return provider === 'claude-code' ? 'Claude Code' : provider === 'codex' ? 'Codex' : provider;
}
