import type { ContextUsageSnapshot } from '../../../../shared/provider-runtime.ts';

export const DEFAULT_CLAUDE_COMPACT_WINDOW = 300_000;

/** A request-sized measurement, never a sum of the agent loop's usage. */
export class ClaudeContextUsage {
  private readonly seen = new Set<string>();
  private readonly windows = new Map<string, number>();
  private latest?: { id: string; model: string; usedTokens: number; observedAt: number };

  private readonly compactWindow: number;

  constructor(compactWindow = DEFAULT_CLAUDE_COMPACT_WINDOW) {
    this.compactWindow = compactWindow;
  }

  startTurn() {
    this.seen.clear();
    this.latest = undefined;
  }

  compact() {
    // Keep IDs so a late pre-compaction snapshot cannot restore stale usage.
    this.latest = undefined;
  }

  observe(message: Record<string, unknown>, observedAt: number) {
    const id = typeof message.id === 'string' ? message.id : undefined;
    const model = typeof message.model === 'string' ? message.model : undefined;
    if (!id || !model || model === '<synthetic>') return;
    if (this.seen.has(id) && this.latest?.id !== id) return;
    this.seen.add(id);
    const usage = record(message.usage);
    const input = tokens(usage?.input_tokens);
    const read = tokens(usage?.cache_read_input_tokens ?? 0);
    const write = tokens(usage?.cache_creation_input_tokens ?? 0);
    if (input === undefined || read === undefined || write === undefined) {
      this.latest = undefined;
      return true;
    }
    if (this.latest?.id === id && this.latest.model === model &&
        this.latest.usedTokens === input + read + write) return false;
    this.latest = { id, model, usedTokens: input + read + write, observedAt };
    return true;
  }

  updateWindows(modelUsage: Record<string, unknown> | undefined) {
    // Model aliases in session configuration need not match the result keys.
    // Resolve against the model that actually produced the root response.
    const candidates = new Map<string, Set<number>>();
    for (const [model, value] of Object.entries(modelUsage ?? {})) {
      const sample = record(value);
      const window = tokens(sample?.contextWindow);
      if (!window) continue;
      for (const name of [model, sample?.canonicalModel]) {
        if (typeof name !== 'string') continue;
        const key = modelKey(name);
        const values = candidates.get(key) ?? new Set<number>();
        values.add(window);
        candidates.set(key, values);
      }
    }
    for (const [model, values] of candidates) {
      if (values.size === 1) this.windows.set(model, [...values][0]);
      else this.windows.delete(model);
    }
  }

  snapshot(turnId: string): ContextUsageSnapshot | null {
    const sample = this.latest;
    const windowTokens = sample && this.windows.get(modelKey(sample.model));
    if (!sample || !windowTokens) return null;
    return {
      usedTokens: sample.usedTokens,
      windowTokens,
      percent: Math.min(100, sample.usedTokens / windowTokens * 100),
      autoCompactWindowTokens: Math.min(this.compactWindow, windowTokens),
      measurement: 'derived',
      freshness: 'live',
      observedAt: sample.observedAt,
      turnId,
    };
  }
}

export function claudeCompactWindow(environment: Readonly<Record<string, string | undefined>>) {
  // Match the native env override, which takes precedence over SDK settings.
  const value = Number.parseInt(environment.CLAUDE_CODE_AUTO_COMPACT_WINDOW ?? '', 10);
  return Number.isFinite(value)
    ? Math.min(1_000_000, Math.max(100_000, value))
    : DEFAULT_CLAUDE_COMPACT_WINDOW;
}

function modelKey(model: string) {
  return model.replace(/\[1m\]$/u, '');
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

function tokens(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value : undefined;
}
