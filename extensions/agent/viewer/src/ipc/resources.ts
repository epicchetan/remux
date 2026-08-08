import { rpc } from '@remux/viewer-kit/ipc';

import {
  AGENT_METHODS,
  type AgentResourceKey,
  type AgentResourceValue,
  type ResourceReadResult,
} from '../../../shared/protocol';

export type AgentResourceReadUpdate = {
  generationChanged: boolean;
  missing: AgentResourceKey[];
  serverGeneration: string | null;
  values: Map<AgentResourceKey, AgentResourceValue>;
};

export class AgentResourceReader {
  private readonly revisions = new Map<AgentResourceKey, number>();
  private generation: string | null = null;

  clear() {
    this.revisions.clear();
  }

  async read(keys: AgentResourceKey[]): Promise<AgentResourceReadUpdate> {
    const result = await rpc.query<ResourceReadResult>(AGENT_METHODS.resourcesRead, {
      requests: keys.map((key) => ({
        key,
        ...(this.revisions.has(key) ? { ifNoneMatch: this.revisions.get(key) } : {}),
      })),
    });
    const responseGeneration = result.resources[0]?.serverGeneration ?? null;
    if (this.generation && responseGeneration && this.generation !== responseGeneration) {
      this.revisions.clear();
      this.generation = responseGeneration;
      const fresh = await rpc.query<ResourceReadResult>(AGENT_METHODS.resourcesRead, {
        requests: keys.map((key) => ({ key })),
      });
      return this.apply(fresh, true);
    }
    return this.apply(result, false);
  }

  private apply(result: ResourceReadResult, generationChanged: boolean): AgentResourceReadUpdate {
    const values = new Map<AgentResourceKey, AgentResourceValue>();
    const missing: AgentResourceKey[] = [];
    const serverGeneration = result.resources[0]?.serverGeneration ?? null;

    for (const resource of result.resources) {
      if (serverGeneration !== null && resource.serverGeneration !== serverGeneration) {
        throw new Error('Agent resource batch mixed server generations.');
      }
      this.generation = resource.serverGeneration;
      if (resource.status === 'missing') {
        this.revisions.delete(resource.key);
        missing.push(resource.key);
        continue;
      }
      this.revisions.set(resource.key, resource.revision);
      if (resource.status === 'ok') values.set(resource.key, resource.value);
    }

    return { generationChanged, missing, serverGeneration, values };
  }
}
