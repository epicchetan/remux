import { useCallback, useEffect, useRef, useState } from 'react';

import {
  agentExecutionResourceKey,
  parseAgentExecutionResourceKey,
  type AgentExecutionResource,
  type NativeAgentResourceKey,
} from '../../../shared/native-agent-protocol.ts';
import { subscribeAgentResourceInvalidations } from '../ipc/resourceInvalidations.ts';
import { AgentResourceReader } from '../ipc/resources.ts';
import { newestAgentExecutions } from './executionOrder.ts';

export type AgentExecutionTree = {
  executions: readonly AgentExecutionResource[];
  loading: boolean;
  error: string | null;
};

type CachedExecutionTree = {
  rootExecutionId: string;
  byId: Map<string, AgentExecutionResource>;
  ready: boolean;
};

const reader = new AgentResourceReader();
const cache = new Map<string, CachedExecutionTree>();

export function useAgentExecutions(
  conversationId: string | null,
  rootExecutionId: string | null,
) {
  const [state, setState] = useState<AgentExecutionTree>(() =>
    snapshot(conversationId ? cache.get(conversationId) : undefined, false, null));
  const requestRef = useRef(0);
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refresh = useCallback(async (showLoading = false) => {
    if (!conversationId || !rootExecutionId) {
      setState({ executions: [], loading: false, error: null });
      return;
    }
    const request = ++requestRef.current;
    let entry = cache.get(conversationId);
    if (!entry || entry.rootExecutionId !== rootExecutionId) {
      entry = { rootExecutionId, byId: new Map(), ready: false };
      cache.set(conversationId, entry);
    }
    if (showLoading || !entry.ready) setState(snapshot(entry, true, null));

    try {
      const pending = [...new Set([rootExecutionId, ...entry.byId.keys()])];
      const visited = new Set<string>();
      while (pending.length > 0) {
        const batch = [...new Set(pending.splice(0, 32))].filter((id) => !visited.has(id));
        if (batch.length === 0) continue;
        for (const id of batch) visited.add(id);
        const keys = batch.map(agentExecutionResourceKey);
        const update = await reader.read(keys, {
          focusedConversationId: conversationId,
          focusedExecutionId: batch[0],
          visibility: 'foreground',
        });
        if (request !== requestRef.current) return;
        if (update.generationChanged) {
          entry.byId.clear();
        }
        for (const key of update.missing) {
          entry.byId.delete(executionIdFromKey(key));
        }
        for (const [key, value] of update.values) {
          if (!key.startsWith('agent/execution:')) continue;
          const execution = value as AgentExecutionResource;
          if (execution.conversationId === conversationId) entry.byId.set(execution.executionId, execution);
        }
        for (const id of batch) {
          const execution = entry.byId.get(id);
          for (const childId of execution?.childExecutionIds ?? []) {
            if (!visited.has(childId)) pending.push(childId);
          }
        }
        setState(snapshot(entry, true, null));
      }

      // Drop children that are no longer reachable from the durable root.
      const reachable = new Set<string>();
      const frontier = [rootExecutionId];
      while (frontier.length > 0) {
        const id = frontier.pop()!;
        if (reachable.has(id)) continue;
        reachable.add(id);
        frontier.push(...(entry.byId.get(id)?.childExecutionIds ?? []));
      }
      for (const id of entry.byId.keys()) {
        if (!reachable.has(id)) entry.byId.delete(id);
      }
      entry.ready = true;
      setState(snapshot(entry, false, null));
    } catch (error) {
      if (request !== requestRef.current) return;
      setState(snapshot(entry, false, messageOf(error)));
    }
  }, [conversationId, rootExecutionId]);

  useEffect(() => {
    requestRef.current += 1;
    const entry = conversationId ? cache.get(conversationId) : undefined;
    setState(snapshot(entry?.rootExecutionId === rootExecutionId ? entry : undefined, Boolean(rootExecutionId), null));
    void refresh(false);
  }, [conversationId, refresh, rootExecutionId]);

  useEffect(() => {
    const unsubscribe = subscribeAgentResourceInvalidations((keys) => {
      if (!conversationId || !rootExecutionId) return;
      const entry = cache.get(conversationId);
      const relevant = keys.some((key) => {
        if (!key.startsWith('agent/execution:')) return false;
        const id = executionIdFromKey(key);
        return id === rootExecutionId || entry?.byId.has(id) === true;
      });
      if (!relevant || refreshTimerRef.current) return;
      refreshTimerRef.current = setTimeout(() => {
        refreshTimerRef.current = null;
        void refresh(false);
      }, 16);
    });
    return () => { unsubscribe(); };
  }, [conversationId, refresh, rootExecutionId]);

  useEffect(() => () => {
    requestRef.current += 1;
    if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
  }, []);

  return { ...state, refresh: () => refresh(true) };
}

function snapshot(
  entry: CachedExecutionTree | undefined,
  loading: boolean,
  error: string | null,
): AgentExecutionTree {
  const executions = entry
    ? newestAgentExecutions([...entry.byId.values()]
      .filter(({ ownership }) => ownership !== 'root'))
    : [];
  return { executions, loading: loading && executions.length === 0, error };
}

function executionIdFromKey(key: NativeAgentResourceKey) {
  return parseAgentExecutionResourceKey(key) ?? '';
}

function messageOf(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
