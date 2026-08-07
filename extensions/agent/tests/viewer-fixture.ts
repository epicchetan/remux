import type { Page } from '@playwright/test';

export const FIXTURE_CONVERSATION_ID = '11111111-1111-4111-8111-111111111111';

export async function installAgentHost(page: Page) {
  await page.addInitScript(() => {
    type HostRequest = {
      id?: number | string;
      method?: string;
      params?: any;
      type?: string;
    };
    type Resource = { revision: number; value: any };
    type Turn = {
      id: string;
      status: 'inProgress' | 'completed' | 'failed' | 'interrupted';
      startedAt: number;
      completedAt: number | null;
      durationMs: number | null;
      error: { code: 'provider_error' | 'runtime_error'; message: string } | null;
      renderRevision: string;
      layoutRevision: string;
      segments: any[];
    };

    const conversationId = '11111111-1111-4111-8111-111111111111';
    const conversationKey = `conversation:${conversationId}`;
    let generation = 'fixture-generation';
    const route = new URL(window.location.href).searchParams;
    const signedOut = route.get('fixtureSignedOut') === '1';
    const routedConversation = route.get('remuxResourceKind') === 'agentConversation'
      && route.get('remuxResourceId') === conversationId;
    const longTranscript = route.get('fixtureLong') === '1';
    const markdownTranscript = route.get('fixtureMarkdown') === '1';
    const resources = new Map<string, Resource>([
      ['auth', { revision: 1, value: {
        state: signedOut ? 'signed-out' : 'signed-in', operationId: null,
        displayLabel: signedOut ? null : 'Fixture subscription', verificationUri: null,
        userCode: null, expiresAt: null, progress: null, error: null,
      } }],
      ['models', { revision: 1, value: {
        defaultModelId: signedOut ? null : 'gpt-5.4-fixture', error: null,
        models: signedOut ? [] : [{
          id: 'gpt-5.4-fixture', name: 'GPT-5.4 Fixture', provider: 'openai-codex',
          contextWindow: 400000, supportedReasoning: ['low', 'medium', 'high', 'xhigh'],
        }],
      } }],
    ]);
    const turns: Turn[] = [];
    const workGroups = new Map<string, any>();
    const workDetails = new Map<string, any>();
    const requestLog: Array<{ method: string; summary: string }> = [];
    let sequence = 1;
    let turnCounter = 0;
    let lifecycleEpoch = 1;
    let nextTranscriptDelayMs = 0;
    let viewportMetrics = {
      keyboardHeight: 0,
      keyboardVisible: false,
      visibleBottom: window.innerHeight,
      visibleTop: 0,
      viewportHeight: window.innerHeight,
      viewportWidth: window.innerWidth,
    };

    if (routedConversation) {
      resources.set(conversationKey, {
        revision: 3,
        value: conversationValue('/tmp/remux-fixture', 'idle'),
      });
      if (longTranscript) {
        for (let index = 1; index <= 72; index += 1) {
          turns.push(completedTurn(`turn-${index}`, `Historical request ${index}`, `Historical answer ${index}.`));
        }
        sequence = 72;
        turnCounter = 72;
      } else if (markdownTranscript) {
        turns.push(completedTurn(
          'markdown-turn',
          'Show rich output',
          [
            '## Rendered answer',
            '',
            '- stable list item',
            '- another item',
            '',
            '| File | State |',
            '| --- | --- |',
            '| `README.md` | ready |',
            '',
            'See [the implementation](src/index.ts#L12).',
            '',
            '```ts',
            'const value = "a-very-long-line-that-must-remain-contained-'.repeat(8) + '";',
            '```',
          ].join('\n'),
        ));
      } else {
        turns.push(completedTurn(
          'resumed-turn',
          'Resume this conversation',
          'Recovered from authoritative resources.',
        ));
      }
    }

    function conversationValue(cwd: string, status: string) {
      return {
        id: conversationId,
        cwd,
        modelId: 'gpt-5.4-fixture',
        reasoning: 'high',
        status,
        activeTurnId: null,
        activeTurnElapsedMs: null,
        error: null,
        contextProbe: {
          hookVersion: 'phase0-v1', modelCallCount: routedConversation ? 1 : 0,
          messageCount: routedConversation ? 2 : 0,
          messageHash: routedConversation ? 'fixture-hash' : null,
          orderedMessageHashes: routedConversation ? ['one', 'two'] : [],
          estimatedBytes: routedConversation ? 256 : 0,
          provider: 'openai-codex', modelId: 'gpt-5.4-fixture',
          providerRequestMode: routedConversation ? 'continuation' : 'none',
        },
      };
    }

    function completedTurn(id: string, user: string, assistant: string): Turn {
      return {
        id,
        status: 'completed',
        startedAt: Date.now() - 2_000,
        completedAt: Date.now() - 1_000,
        durationMs: 1_000,
        error: null,
        renderRevision: `${id}:1`,
        layoutRevision: `${id}:1`,
        segments: [
          { id: `${id}:user`, type: 'userMessage', clientMessageId: null, revision: '1', text: user },
          { id: `${id}:assistant`, type: 'assistantMessage', revision: '1', text: assistant },
        ],
      };
    }

    function dispatch(message: unknown) {
      const event = new MessageEvent('message', { data: JSON.stringify(message) });
      window.dispatchEvent(event);
      document.dispatchEvent(event);
    }

    function invalidateResource(key: string, reason: 'created' | 'updated' | 'deleted' = 'updated') {
      dispatchInvalidations([{ type: 'resource', key, reason }]);
    }

    function invalidateTranscript(
      turnId: string,
      reason: 'sendAccepted' | 'runtimeEvent' | 'terminal',
      affectsOrder: boolean,
    ) {
      dispatchInvalidations([{
        type: 'transcript', key: `transcript:${conversationId}`, conversationId,
        turnId, reason, affectsOrder, affectsLayout: true,
      }]);
    }

    function dispatchInvalidations(invalidations: any[]) {
      dispatch({
        type: 'remux/event',
        message: {
          jsonrpc: '2.0', method: 'remux/agent/resources/invalidated',
          params: { invalidations, serverGeneration: generation },
        },
      });
    }

    function updateResource(key: string, mutate: (value: any) => void) {
      const entry = resources.get(key);
      if (!entry) return;
      mutate(entry.value);
      entry.revision += 1;
      invalidateResource(key);
    }

    function touchTurn(turn: Turn) {
      sequence += 1;
      turn.renderRevision = `${turn.id}:${sequence}`;
      turn.layoutRevision = `${turn.id}:${sequence}`;
      for (const segment of turn.segments) {
        segment.revision = String(sequence);
        if (segment.type === 'work') segment.layoutRevision = `${segment.id}:${sequence}`;
      }
    }

    function createRunningTurn(text: string, clientMessageId: string) {
      turnCounter += 1;
      const id = `fixture-turn-${turnCounter}`;
      const workId = `${id}:work`;
      const groupId = `${id}:workspace-reads`;
      const rowId = `${id}:readme`;
      const filesGroupId = `${id}:changed-files`;
      const fileRowId = `${id}:index-change`;
      const turn: Turn = {
        id,
        status: 'inProgress',
        startedAt: Date.now(),
        completedAt: null,
        durationMs: null,
        error: null,
        renderRevision: `${id}:1`,
        layoutRevision: `${id}:1`,
        segments: [
          { id: `${id}:user`, type: 'userMessage', clientMessageId, revision: '1', text },
          {
            id: workId, type: 'work', state: 'running', revision: '1',
            layoutRevision: '1', durationMs: null,
            timeline: [
              { id: `${id}:reason`, type: 'text', revision: '1', text: 'Checking context.' },
              {
                id: groupId, type: 'group', revision: '1', groupType: 'activity',
                title: 'Workspace reads', status: 'running', rowCount: 1, hasMoreRows: false,
              },
              {
                id: filesGroupId, type: 'group', revision: '1', groupType: 'files',
                title: 'Changed files', status: 'running', rowCount: 1, hasMoreRows: false,
              },
            ],
          },
          { id: `${id}:assistant`, type: 'assistantMessage', revision: '1', text: '' },
        ],
      };
      workGroups.set(groupKey(id, workId, groupId), {
        conversationId, turnId: id, segmentId: workId, groupId,
        type: 'activity', title: 'Workspace reads', revision: '1', layoutRevision: '1',
        rows: [{
          id: rowId, type: 'activity', revision: '1', kind: 'read', status: 'running',
          text: 'Read README.md', path: 'README.md', durationMs: null, hasDetail: true,
        }],
        nextCursor: null,
      });
      workDetails.set(detailKey(id, workId, groupId, rowId), {
        conversationId, turnId: id, segmentId: workId, groupId, rowId,
        revision: '1', layoutRevision: '1',
        detail: {
          type: 'activity', detail: 'Read the workspace overview before editing.',
          output: '# Remux\n\nFixture file output.',
        },
        truncation: { originalBytes: 38, returnedBytes: 38, truncated: false },
      });
      workGroups.set(groupKey(id, workId, filesGroupId), {
        conversationId, turnId: id, segmentId: workId, groupId: filesGroupId,
        type: 'files', title: 'Changed files', revision: '1', layoutRevision: '1',
        rows: [{
          id: fileRowId, type: 'fileChange', revision: '1', kind: 'edited',
          status: 'completed', path: 'src/index.ts', additions: 2, deletions: 1,
          hasDetail: true,
        }],
        nextCursor: null,
      });
      workDetails.set(detailKey(id, workId, filesGroupId, fileRowId), {
        conversationId, turnId: id, segmentId: workId, groupId: filesGroupId,
        rowId: fileRowId, revision: '1', layoutRevision: '1',
        detail: {
          type: 'fileChange',
          diff: '@@ -1,2 +1,3 @@\n-old value\n+export const value = 1;\n context',
        },
        truncation: { originalBytes: 66, returnedBytes: 66, truncated: false },
      });
      turns.push(turn);
      touchTurn(turn);
      return turn;
    }

    function finishTurn(turn: Turn, outcome: 'completed' | 'failed' | 'interrupted') {
      turn.status = outcome;
      turn.completedAt = Date.now();
      turn.durationMs = Math.max(1_000, turn.completedAt - turn.startedAt);
      const work = turn.segments.find((segment) => segment.type === 'work');
      const assistant = turn.segments.find((segment) => segment.type === 'assistantMessage');
      if (work) {
        work.state = outcome;
        work.durationMs = turn.durationMs;
        for (const entry of work.timeline) {
          if (entry.type === 'group') entry.status = outcome;
        }
        const group = workGroups.get(groupKey(turn.id, work.id, work.timeline[1].id));
        if (group) {
          group.revision = String(sequence + 1);
          group.layoutRevision = String(sequence + 1);
          for (const row of group.rows) {
            row.status = outcome;
            row.durationMs = turn.durationMs;
            row.revision = String(sequence + 1);
          }
        }
      }
      if (outcome === 'completed') {
        assistant.text = [
          'The fixture stream completed.',
          '',
          '- Transcript frames stayed authoritative.',
          '- Work detail remained lazy.',
          '',
          'See [README.md](README.md).',
        ].join('\n');
      } else if (outcome === 'failed') {
        turn.error = { code: 'provider_error', message: 'Fixture provider failure.' };
      }
      touchTurn(turn);
      updateResource(conversationKey, (conversation) => {
        conversation.status = outcome === 'failed' ? 'error' : 'idle';
        conversation.activeTurnId = null;
        conversation.activeTurnElapsedMs = null;
        conversation.error = outcome === 'failed' ? 'Fixture provider failure.' : null;
      });
      invalidateTranscript(turn.id, 'terminal', false);
      if (work) {
        const group = work.timeline.find((entry: any) => entry.type === 'group');
        if (group) {
          dispatchInvalidations([{
            type: 'workGroup',
            key: groupKey(turn.id, work.id, group.id),
            conversationId, turnId: turn.id, segmentId: work.id, groupId: group.id,
            reason: 'terminal', affectsLayout: true,
          }]);
        }
      }
    }

    function transcriptSync(request: any) {
      const allIds = turns.map((turn) => turn.id);
      let start = 0;
      let end = allIds.length;
      if (request.window.kind === 'tail') {
        const count = request.window.count ?? 24;
        start = Math.max(0, allIds.length - count);
      } else if (request.window.kind === 'around') {
        const anchor = Math.max(0, allIds.indexOf(request.window.turnId));
        start = Math.max(0, anchor - request.window.before);
        end = Math.min(allIds.length, anchor + request.window.after + 1);
        if (end - start > 40) start = end - 40;
      } else {
        const first = allIds.indexOf(request.window.startTurnId);
        const last = allIds.indexOf(request.window.endTurnId);
        if (first >= 0 && last >= first) {
          start = first;
          end = Math.min(allIds.length, last + 1);
        }
      }
      const selected = turns.slice(start, end);
      const known = new Map((request.knownTurns ?? []).map((entry: any) => [entry.turnId, entry.renderRevision]));
      return {
        protocolVersion: 1,
        projectionVersion: 'agent-turn-render-v1',
        conversationId,
        conversationRevision: `conversation:${sequence}`,
        basisSequence: sequence,
        activeTurnId: resources.get(conversationKey)?.value.activeTurnId ?? null,
        turnOrder: selected.map((turn) => turn.id),
        turns: selected.map((turn) => known.get(turn.id) === turn.renderRevision
          ? { status: 'notModified', turnId: turn.id, renderRevision: turn.renderRevision }
          : { status: 'ok', turnId: turn.id, renderRevision: turn.renderRevision, frame: turn }),
        removedTurnIds: [],
        window: {
          startIndex: start,
          endIndexExclusive: end,
          hasEarlier: start > 0,
          hasLater: end < turns.length,
          turnIds: selected.map((turn) => turn.id),
        },
      };
    }

    function transcriptResult(params: any) {
      if (!resources.has(conversationKey)) {
        return { conversationId, serverGeneration: generation, resources: params.requests.map((_: any, requestIndex: number) => ({ requestIndex, key: `transcript:${conversationId}`, status: 'missing' })) };
      }
      return {
        conversationId,
        serverGeneration: generation,
        resources: params.requests.map((request: any, requestIndex: number) => {
          if (request.type === 'transcriptSync') {
            const value = transcriptSync(request);
            return {
              requestIndex, key: `transcript:${conversationId}`, status: 'ok',
              revision: value.conversationRevision, value,
            };
          }
          if (request.type === 'workGroup') {
            const key = groupKey(request.turnId, request.segmentId, request.groupId);
            const value = workGroups.get(key);
            if (!value) return { requestIndex, key, status: 'missing' };
            if (request.knownRevision === value.revision) return { requestIndex, key, status: 'notModified', revision: value.revision };
            return { requestIndex, key, status: 'ok', revision: value.revision, value };
          }
          const key = detailKey(request.turnId, request.segmentId, request.groupId, request.rowId);
          const value = workDetails.get(key);
          if (!value) return { requestIndex, key, status: 'missing' };
          if (request.knownRevision === value.revision) return { requestIndex, key, status: 'notModified', revision: value.revision };
          return { requestIndex, key, status: 'ok', revision: value.revision, value };
        }),
      };
    }

    function groupKey(turnId: string, segmentId: string, groupId: string) {
      return `workGroup:${conversationId}:${turnId}:${segmentId}:${groupId}`;
    }

    function detailKey(turnId: string, segmentId: string, groupId: string, rowId: string) {
      return `workEntryDetail:${conversationId}:${turnId}:${segmentId}:${groupId}:${rowId}`;
    }

    function resultFor(request: HostRequest) {
      const params = request.params ?? {};
      requestLog.push({
        method: request.method ?? 'unknown',
        summary: request.method === 'remux/agent/transcript/resources/read'
          ? JSON.stringify(params.requests)
          : JSON.stringify(params),
      });
      if (request.method === 'remux/agent/resources/read') {
        return {
          resources: params.requests.map((item: any) => {
            const entry = resources.get(item.key);
            if (!entry) return { key: item.key, status: 'missing', serverGeneration: generation };
            if (item.ifNoneMatch === entry.revision) {
              return { key: item.key, status: 'notModified', revision: entry.revision, serverGeneration: generation };
            }
            return {
              key: item.key, status: 'ok', revision: entry.revision,
              serverGeneration: generation, value: entry.value,
            };
          }),
        };
      }
      if (request.method === 'remux/agent/transcript/resources/read') return transcriptResult(params);
      if (request.method === 'remux/agent/conversation/start') {
        resources.set(conversationKey, {
          revision: 1,
          value: { ...conversationValue(params.cwd, 'idle'), modelId: params.modelId, reasoning: params.reasoning },
        });
        invalidateResource(conversationKey, 'created');
        return { conversationId };
      }
      if (request.method === 'remux/agent/conversation/message/send') {
        const turn = createRunningTurn(String(params.text), String(params.clientMessageId));
        updateResource(conversationKey, (conversation) => {
          conversation.status = 'running';
          conversation.activeTurnId = turn.id;
          conversation.activeTurnElapsedMs = 0;
          conversation.contextProbe = {
            ...conversation.contextProbe,
            modelCallCount: 1,
            messageCount: 1,
            messageHash: 'fixture-hash',
            orderedMessageHashes: ['fixture-message'],
            estimatedBytes: 128,
            providerRequestMode: 'full',
          };
        });
        invalidateTranscript(turn.id, 'sendAccepted', true);
        const text = String(params.text);
        if (!text.includes('interrupt')) {
          setTimeout(() => {
            try {
              finishTurn(turn, text.includes('error') ? 'failed' : 'completed');
            } catch (error) {
              console.error('Agent viewer fixture failed to finish a turn.', error);
            }
          }, 80);
        }
        return { accepted: true, turnId: turn.id };
      }
      if (request.method === 'remux/agent/conversation/turn/interrupt') {
        const turn = turns.find((candidate) => candidate.id === params.turnId);
        if (turn) finishTurn(turn, 'interrupted');
        return { accepted: true };
      }
      if (request.method === 'remux/agent/auth/login/start') {
        updateResource('auth', (auth) => Object.assign(auth, {
          state: 'signing-in', operationId: 'fixture-login',
          verificationUri: 'https://example.test/device', userCode: 'REMUX-CODE',
          progress: 'Waiting for authorization.', error: null,
        }));
        return { accepted: true, operationId: 'fixture-login' };
      }
      if (request.method === 'remux/agent/auth/login/cancel') {
        updateResource('auth', (auth) => Object.assign(auth, {
          state: 'signed-out', operationId: null, verificationUri: null,
          userCode: null, progress: null,
        }));
        return { accepted: true };
      }
      if (request.method === 'remux/agent/auth/logout') {
        updateResource('auth', (auth) => Object.assign(auth, {
          state: 'signed-out', operationId: null, displayLabel: null,
          verificationUri: null, userCode: null, progress: null, error: null,
        }));
        return { accepted: true };
      }
      if (request.method === 'remux/fs/readDirectory') {
        const path = String(params.path);
        return {
          path,
          parentPath: path === '/tmp/remux-fixture' ? '/tmp' : '/tmp/remux-fixture',
          entries: path === '/tmp/remux-fixture'
            ? [{ kind: 'directory', name: 'packages', path: '/tmp/remux-fixture/packages', targetKind: null }]
            : [],
        };
      }
      if (request.method === 'host/viewport/get') return viewportMetrics;
      if (request.method === 'host/link/open') return { ok: true };
      return { ok: true };
    }

    function dispatchLifecycle(state: 'active' | 'background' | 'inactive', reason = 'fixture') {
      lifecycleEpoch += 1;
      dispatch({ type: 'remux/lifecycle', lifecycle: { epoch: lifecycleEpoch, reason, state } });
    }

    function dispatchStatus(type: 'connected' | 'connecting' | 'reconnecting' | 'disconnected') {
      dispatch({
        type: 'remux/status',
        error: null,
        status: type === 'connected'
          ? { type, cwd: '/tmp/remux-fixture', generation: lifecycleEpoch }
          : { type },
      });
    }

    Object.defineProperty(window, 'ReactNativeWebView', {
      configurable: true,
      value: {
        postMessage(raw: string) {
          const request = JSON.parse(raw) as HostRequest;
          if (request.type === 'remux/ready' || request.type === 'ready') {
            dispatch({
              type: 'remux/status', error: null,
              status: { type: 'connected', cwd: '/tmp/remux-fixture', generation: 1 },
            });
            dispatch({
              type: 'remux/lifecycle',
              lifecycle: { epoch: 1, reason: 'connect', state: 'active' },
            });
            return;
          }
          if (request.id !== undefined && request.method) {
            if (request.method === 'remux/agent/transcript/resources/read' && nextTranscriptDelayMs > 0) {
              const result = resultFor(request);
              const delay = nextTranscriptDelayMs;
              nextTranscriptDelayMs = 0;
              setTimeout(() => dispatch({ type: 'remux/response', id: request.id, result }), delay);
              return;
            }
            dispatch({ type: 'remux/response', id: request.id, result: resultFor(request) });
          }
        },
      },
    });
    Object.defineProperty(window, '__agentFixture', {
      configurable: true,
      value: {
        requestLog,
        resources,
        turns,
        appendCompletedTurn(user: string, assistant: string) {
          turnCounter += 1;
          const turn = completedTurn(`external-turn-${turnCounter}`, user, assistant);
          turns.push(turn);
          sequence += 1;
          invalidateTranscript(turn.id, 'terminal', true);
        },
        delayNextTranscript(delayMs: number) {
          nextTranscriptDelayMs = Math.max(0, delayMs);
        },
        lifecycle: dispatchLifecycle,
        reconnect() {
          dispatchStatus('reconnecting');
          setTimeout(() => {
            dispatchStatus('connected');
            dispatchLifecycle('active', 'reconnect');
          }, 20);
        },
        resetGeneration() {
          generation = `fixture-generation-${Date.now()}`;
          resources.delete(conversationKey);
          const auth = resources.get('auth');
          if (auth) auth.revision += 1;
          invalidateResource('auth');
        },
        setViewportMetrics(metrics: Partial<typeof viewportMetrics>) {
          viewportMetrics = { ...viewportMetrics, ...metrics };
          dispatch({
            type: 'remux/event',
            message: { jsonrpc: '2.0', method: 'host/viewport/changed', params: viewportMetrics },
          });
        },
      },
    });
  });
}
