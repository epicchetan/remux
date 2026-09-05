import type { NativeChildBinding, ProviderTurnOutcome } from '../../../../shared/provider-runtime.ts';

export type CodexChildBinding = {
  nativeThreadId: string;
  executionId: string;
  parentExecutionId: string;
  nativeParentThreadId: string;
  ownerTurnId: string;
  ownerNativeTurnId: string;
  activeNativeTurnId?: string;
  terminalNativeTurnId?: string;
  outcome?: ProviderTurnOutcome;
  terminalNativeTurnIds?: Set<string>;
};

/** Session-local view of durable native child ownership. */
export class CodexChildRegistry {
  private readonly bindings = new Map<string, CodexChildBinding>();

  restore(bindings: readonly NativeChildBinding[]) {
    for (const binding of bindings) {
      this.bindings.set(binding.nativeThreadId, {
        ...binding,
        terminalNativeTurnIds: new Set(binding.terminalNativeTurnIds ?? []),
      });
    }
  }

  bindSpawn(binding: Omit<CodexChildBinding, 'activeNativeTurnId' | 'terminalNativeTurnId' | 'outcome'>) {
    const existing = this.bindings.get(binding.nativeThreadId);
    if (existing) return existing;
    this.bindings.set(binding.nativeThreadId, { ...binding, terminalNativeTurnIds: new Set() });
    return this.bindings.get(binding.nativeThreadId)!;
  }

  get(nativeThreadId: string) {
    return this.bindings.get(nativeThreadId);
  }

  activeAttempts() {
    return [...this.bindings.values()].flatMap((binding) => binding.activeNativeTurnId
      ? [[binding.nativeThreadId, binding.activeNativeTurnId] as const] : []);
  }

  settleCachedOutcome(nativeThreadId: string, outcome: ProviderTurnOutcome) {
    const binding = this.bindings.get(nativeThreadId);
    if (!binding || binding.activeNativeTurnId || binding.outcome) return false;
    binding.outcome = outcome;
    return true;
  }

  beginAttempt(nativeThreadId: string, nativeTurnId: string) {
    const binding = this.bindings.get(nativeThreadId);
    if (!binding) return undefined;
    if (binding.terminalNativeTurnIds?.has(nativeTurnId)) return undefined;
    binding.activeNativeTurnId = nativeTurnId;
    binding.terminalNativeTurnId = undefined;
    binding.outcome = undefined;
    return binding;
  }

  completeAttempt(nativeThreadId: string, nativeTurnId: string, outcome: ProviderTurnOutcome) {
    const binding = this.bindings.get(nativeThreadId);
    if (!binding) return undefined;
    if (binding.terminalNativeTurnIds?.has(nativeTurnId)) return undefined;
    if (binding.activeNativeTurnId && binding.activeNativeTurnId !== nativeTurnId) return undefined;
    binding.activeNativeTurnId = undefined;
    binding.terminalNativeTurnId = nativeTurnId;
    binding.terminalNativeTurnIds?.add(nativeTurnId);
    binding.outcome = outcome;
    return binding;
  }

}
