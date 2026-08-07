import { randomUUID } from 'node:crypto';

import type {
  AgentResourceKey,
  AgentResourceValue,
  ResourceReadParams,
  ResourceReadResult,
  ResourcesInvalidatedParams,
} from '../../shared/protocol.ts';
import type { AgentResourceInvalidation } from '../../shared/transcript.ts';

type Entry = {
  revision: number;
  value: AgentResourceValue;
};

export class ResourceStore {
  readonly serverGeneration = randomUUID();
  private readonly entries = new Map<AgentResourceKey, Entry>();
  private readonly invalidate: (params: ResourcesInvalidatedParams) => void;
  private readonly pendingInvalidations = new Map<string, AgentResourceInvalidation>();
  private invalidationScheduled = false;

  constructor(invalidate: (params: ResourcesInvalidatedParams) => void) {
    this.invalidate = invalidate;
  }

  set(key: AgentResourceKey, value: AgentResourceValue, notify = true) {
    const previous = this.entries.get(key);
    this.entries.set(key, {
      revision: (previous?.revision ?? 0) + 1,
      value: structuredClone(value),
    });
    if (notify) {
      this.scheduleInvalidation(key, previous ? 'updated' : 'created');
    }
  }

  get<T extends AgentResourceValue>(key: AgentResourceKey): T | undefined {
    const value = this.entries.get(key)?.value;
    return value === undefined ? undefined : structuredClone(value) as T;
  }

  delete(key: AgentResourceKey, notify = true) {
    if (!this.entries.delete(key)) return;
    if (notify) this.scheduleInvalidation(key, 'deleted');
  }

  read(
    params: ResourceReadParams,
    projectValue?: (key: AgentResourceKey, value: AgentResourceValue) => AgentResourceValue,
  ): ResourceReadResult {
    return {
      resources: params.requests.map((request) => {
        const entry = this.entries.get(request.key);
        if (!entry) {
          return {
            key: request.key,
            status: 'missing' as const,
            serverGeneration: this.serverGeneration,
          };
        }
        if (request.ifNoneMatch === entry.revision) {
          return {
            key: request.key,
            status: 'notModified' as const,
            revision: entry.revision,
            serverGeneration: this.serverGeneration,
          };
        }
        const cloned = structuredClone(entry.value);
        return {
          key: request.key,
          status: 'ok' as const,
          revision: entry.revision,
          serverGeneration: this.serverGeneration,
          value: projectValue ? projectValue(request.key, cloned) : cloned,
        };
      }),
    };
  }

  private scheduleInvalidation(
    key: AgentResourceKey,
    reason: 'created' | 'updated' | 'deleted',
  ) {
    const invalidation = resourceInvalidation(key, reason);
    const invalidationKey = `${invalidation.type}:${invalidation.key}`;
    const pending = this.pendingInvalidations.get(invalidationKey);
    this.pendingInvalidations.set(
      invalidationKey,
      pending?.type === 'resource' && invalidation.type === 'resource'
        ? { ...invalidation, reason: mergedReason(pending.reason, invalidation.reason) }
        : invalidation,
    );
    if (this.invalidationScheduled) return;
    this.invalidationScheduled = true;
    queueMicrotask(() => {
      this.invalidationScheduled = false;
      const invalidations = [...this.pendingInvalidations.values()];
      this.pendingInvalidations.clear();
      this.invalidate({ invalidations, serverGeneration: this.serverGeneration });
    });
  }
}

function resourceInvalidation(
  key: AgentResourceKey,
  reason: 'created' | 'updated' | 'deleted',
): AgentResourceInvalidation {
  if (key === 'auth' || key === 'models' || key.startsWith('conversation:')) {
    return {
      type: 'resource',
      key: key as Extract<AgentResourceInvalidation, { type: 'resource' }>['key'],
      reason,
    };
  }
  throw new Error(`Unsupported Agent resource invalidation key: ${key}`);
}

function mergedReason(
  previous: 'created' | 'updated' | 'deleted',
  next: 'created' | 'updated' | 'deleted',
) {
  if (next === 'deleted') return 'deleted';
  if (previous === 'created') return 'created';
  return next;
}
