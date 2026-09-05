import { rpc } from '@remux/viewer-kit/ipc';

import {
  NATIVE_AGENT_METHODS,
  type NativeAgentResourceKey,
  type NativeAgentResourceReadResult,
  type NativeAgentResourceValue,
} from '../../../shared/native-agent-protocol.ts';

export type NativeAgentResourceReadUpdate = {
  capabilityRevision: string;
  generationChanged: boolean;
  missing: NativeAgentResourceKey[];
  serverGeneration: string;
  values: Map<NativeAgentResourceKey, NativeAgentResourceValue>;
};

export class AgentResourceReader {
  private readonly revisions = new Map<NativeAgentResourceKey, number>();
  private readonly values = new Map<NativeAgentResourceKey, NativeAgentResourceValue>();
  private generation: string | null = null;
  private capabilityRevision: string | null = null;

  clear() {
    this.revisions.clear();
    this.values.clear();
    this.generation = null;
    this.capabilityRevision = null;
  }

  async read(
    keys: NativeAgentResourceKey[],
    options: {
      focusedConversationId?: string;
      focusedExecutionId?: string;
      signal?: AbortSignal;
      visibility?: 'foreground' | 'background' | 'inactive';
    } = {},
  ): Promise<NativeAgentResourceReadUpdate> {
    const result = await this.request(keys, options, true);
    const generationChanged = this.generation !== null && this.generation !== result.serverGeneration;
    const capabilitiesChanged = this.capabilityRevision !== null &&
      this.capabilityRevision !== result.capabilityRevision;
    if (generationChanged || capabilitiesChanged) {
      this.revisions.clear();
      this.values.clear();
      return this.apply(await this.request(keys, options, false), generationChanged);
    }
    return this.apply(result, false);
  }

  private request(
    keys: NativeAgentResourceKey[],
    options: {
      focusedConversationId?: string;
      focusedExecutionId?: string;
      signal?: AbortSignal;
      visibility?: 'foreground' | 'background' | 'inactive';
    },
    conditional: boolean,
  ) {
    const { signal, ...params } = options;
    return rpc.query<NativeAgentResourceReadResult>(NATIVE_AGENT_METHODS.resourcesRead, {
      ...(conditional && this.generation ? { knownServerGeneration: this.generation } : {}),
      ...(conditional && this.capabilityRevision
        ? { capabilityRevision: this.capabilityRevision }
        : {}),
      ...params,
      requests: keys.map((key) => ({
        key,
        ...(conditional && this.revisions.has(key)
          ? { ifNoneMatch: this.revisions.get(key) }
          : {}),
      })),
    }, { signal });
  }

  private apply(
    result: NativeAgentResourceReadResult,
    generationChanged: boolean,
  ): NativeAgentResourceReadUpdate {
    const values = new Map<NativeAgentResourceKey, NativeAgentResourceValue>();
    const missing: NativeAgentResourceKey[] = [];
    this.generation = result.serverGeneration;
    this.capabilityRevision = result.capabilityRevision;
    for (const resource of result.resources) {
      if (resource.status === 'missing') {
        this.revisions.delete(resource.key);
        this.values.delete(resource.key);
        missing.push(resource.key);
        continue;
      }
      this.revisions.set(resource.key, resource.revision);
      if (resource.status === 'ok') this.values.set(resource.key, resource.value);
      const value = resource.status === 'ok' ? resource.value : this.values.get(resource.key);
      if (value !== undefined) values.set(resource.key, value);
    }
    return {
      capabilityRevision: result.capabilityRevision,
      generationChanged,
      missing,
      serverGeneration: result.serverGeneration,
      values,
    };
  }
}
