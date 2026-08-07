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
    const values = new Map<AgentResourceKey, AgentResourceValue>();
    const missing: AgentResourceKey[] = [];
    let generationChanged = false;

    for (const resource of result.resources) {
      if (this.generation && this.generation !== resource.serverGeneration) {
        generationChanged = true;
        this.revisions.clear();
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

    return { generationChanged, missing, values };
  }
}
