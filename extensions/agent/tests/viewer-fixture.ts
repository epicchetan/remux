import type { Page } from '@playwright/test';

export const FIXTURE_CONVERSATION_ID = '11111111-1111-4111-8111-111111111111';
export const FIXTURE_SECOND_CONVERSATION_ID = '22222222-2222-4222-8222-222222222222';

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
    const contextKey = `context:${conversationId}`;
    let generation = 'fixture-generation';
    const route = new URL(window.location.href).searchParams;
    const signedOut = route.get('fixtureSignedOut') === '1';
    const routedConversation = route.get('remuxResourceKind') === 'agentConversation'
      && route.get('remuxResourceId') === conversationId;
    const longTranscript = route.get('fixtureLong') === '1';
    const markdownTranscript = route.get('fixtureMarkdown') === '1';
    const overflowTranscript = route.get('fixtureOverflow') === '1';
    const exactTranscript = route.get('fixtureExact') === '1';
    const legacyInferenceTrace = route.get('fixtureLegacyInferenceTrace') === '1';
    const staleContextInspector = route.get('fixtureStaleContextInspector') === '1';
    const contextTurns = route.get('fixtureContextTurns') === '1';
    const exactArtifactHash = 'a'.repeat(64);
    const pickedImageHash = 'b'.repeat(64);
    const pickedImageDataUrl = 'data:image/png;base64,iVBORw0KGgo=';
    const pickedImageBytes = Uint8Array.from(atob(pickedImageDataUrl.split(',')[1]!), (value) => value.charCodeAt(0));
    const exactPreview = 'Exact preview. ';
    const exactFullText = `${exactPreview}The remaining response is fetched only when requested.`;
    const contextManifestHash = 'e'.repeat(64);
    const contextDispatchHash = 'f'.repeat(64);
    const contextManifestText = JSON.stringify({
      version: 'agent-inference-context-v7',
      context: {
        requestedPlan: { version: 1, automaticDialogueTurns: 2, overrides: [] },
        resolvedTurns: [{ turnId: 'fixture-turn', resolution: 'dialogue', origin: 'automatic' }],
      },
    }, null, 2);
    const contextDispatchText = JSON.stringify({
      input: [{ role: 'user', content: 'Fixture provider input' }],
      model: 'gpt-5.4-fixture',
      tools: [{ name: 'workspace_read' }],
    }, null, 2);
    const artifactTexts = new Map([
      [exactArtifactHash, exactFullText],
      [contextManifestHash, contextManifestText],
      [contextDispatchHash, contextDispatchText],
    ]);
    const artifactBytes = new Map([[pickedImageHash, {
      bytes: pickedImageBytes,
      mediaType: 'image/png',
    }]]);
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
      ['runtime', { revision: 1, value: runtimeValue('unloaded') }],
    ]);
    const turns: Turn[] = [];
    const turnsByConversation = new Map<string, Turn[]>([[conversationId, turns]]);
    const pendingQueue: Array<{ clientMessageId: string; operationId: string; parts?: any[]; text: string }> = [];
    const executionScopes = new Map<string, any>();
    const requestLog: Array<{ method: string; summary: string }> = [];
    let sequence = 1;
    let turnCounter = 0;
    let lifecycleEpoch = 1;
    let nextTranscriptDelayMs = 0;
    let nextMessageError: string | null = null;
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
        value: conversationSummary('/tmp/remux-fixture', 'idle'),
      });
      resources.set('runtime', { revision: 2, value: runtimeValue('idle') });
      const context: any = contextValue('append');
      if (staleContextInspector) {
        context.version = 6;
        delete context.compaction;
      }
      resources.set(contextKey, { revision: 1, value: context });
      if (longTranscript) {
        for (let index = 1; index <= 72; index += 1) {
          turns.push(completedTurn(`turn-${index}`, `Historical request ${index}`, `Historical answer ${index}.`));
        }
        sequence = 72;
        turnCounter = 72;
      } else if (contextTurns) {
        for (let index = 1; index <= 4; index += 1) {
          turns.push(completedTurn(`turn-${index}`, `Context request ${index}`, `Context answer ${index}.`));
        }
        sequence = 4;
        turnCounter = 4;
      } else if (exactTranscript) {
        const exact = completedTurn('exact-turn', 'Show the bounded response', exactPreview);
        const assistant = exact.segments.find((segment) => segment.type === 'assistantMessage');
        if (assistant) {
          const returnedBytes = new TextEncoder().encode(exactPreview).byteLength;
          assistant.content = {
            sha256: exactArtifactHash,
            byteLength: new TextEncoder().encode(exactFullText).byteLength,
            returnedBytes,
            truncated: true,
            artifactHash: exactArtifactHash,
            nextRange: { kind: 'utf8', offset: returnedBytes, byteLength: 13 },
          };
        }
        turns.push(exact);
      } else if (overflowTranscript) {
        turns.push(completedTurn(
          'overflow-turn',
          'Automated recovery retry: finish the extension walkthrough requested in the prior turn using the durable context already available. Do not call tools. Keep the answer concise and end with REMUX_REPLAY_OK.',
          [
            'Yep—here’s the extension model end-to-end:',
            '',
            '1. **What an extension is**',
            '',
            '   - A folder (often under `extensions/`) with `remux-extension.json`.',
            '   - It can define:',
            '     - static **viewer assets** (HTML/JS bundle),',
            '     - optional **stdio JSON-RPC server** (mandatory for richer extension actions),',
            '     - optional **build/watch commands** for viewer bundles,',
            '     - optional **child workloads** (`version: 2` only).',
            '',
            '2. **Discovery**',
          ].join('\n'),
        ));
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
    resources.set('conversation-list', {
      revision: 1,
      value: { conversations: conversationSummaries(), truncated: false },
    });

    function conversationSummary(cwd: string, status: string, id = conversationId) {
      const targetTurns = turnsByConversation.get(id) ?? [];
      return {
        id,
        title: 'Resume this conversation',
        preview: 'Recovered from authoritative resources.',
        cwd,
        modelId: 'gpt-5.4-fixture',
        reasoning: 'high',
        status,
        latestTurnId: targetTurns.at(-1)?.id ?? null,
        createdAt: 1_700_000_000_000,
        updatedAt: Date.now(),
      };
    }

    function runtimeValue(state: string) {
      return {
        conversationId: state === 'unloaded' ? null : conversationId,
        state,
        activeTurnId: null,
        activeTurnElapsedMs: null,
        error: null,
        contextProbe: {
          hookVersion: 'agent-durable-v1', modelCallCount: routedConversation ? 1 : 0,
          messageCount: routedConversation ? 2 : 0,
          messageHash: routedConversation ? 'fixture-hash' : null,
          orderedMessageHashes: routedConversation ? ['one', 'two'] : [],
          estimatedBytes: routedConversation ? 256 : 0,
          provider: 'openai-codex', modelId: 'gpt-5.4-fixture',
          providerRequestMode: routedConversation ? 'continuation' : 'none',
        },
      };
    }

    function contextValue(_decision: 'append' | 'roll') {
      return {
        version: 7,
        conversationId,
        inferenceId: 'fixture-inference',
        frameId: 'fixture-frame',
        basisSequence: sequence,
        compilerVersion: 'agent-turn-context-v1',
        policyVersion: 'agent-explicit-selection-v1',
        estimatedInputTokens: 3_200,
        semanticHash: 'b'.repeat(64),
        buildDurationMs: 2,
        transportMode: 'continuation',
        messageCount: 2,
        turnCount: 1,
        logicalHash: '8'.repeat(64),
        renderedHash: '9'.repeat(64),
        fixedContractsHash: '0'.repeat(64),
        manifestArtifact: {
          hash: contextManifestHash,
          byteLength: new TextEncoder().encode(contextManifestText).byteLength,
          mediaType: 'application/json',
        },
        dispatchArtifact: {
          hash: contextDispatchHash,
          byteLength: new TextEncoder().encode(contextDispatchText).byteLength,
          mediaType: 'text/plain; charset=utf-8',
        },
        groups: [{
          turnId: 'fixture-turn',
          source: 'agent://conversation/fixture/turn/fixture-turn',
          messageCount: 2,
          estimatedTokens: 310,
          roles: { user: 1, assistant: 1, tool: 0 },
        }],
        groupsTruncated: false,
        scopeKind: 'turn',
        requestedPlan: { version: 1, automaticDialogueTurns: 2, overrides: [] },
        selectedTurns: [{
          turnId: 'fixture-turn',
          resolution: 'dialogue',
          origin: 'automatic',
          messageCount: 2,
          estimatedTokens: 310,
        }],
        layers: ['selected_dialogue', 'selected_full_turns', 'active_scope']
          .map((kind, index) => ({
            kind,
            hash: String(index + 1).repeat(64).slice(0, 64),
            estimatedTokens: [100, 0, 102][index],
            sources: [`agent://fixture/${kind}`],
            sourceCount: 1,
            sourcesTruncated: false,
          })),
        omissions: [{
          source: 'agent://conversation/fixture/turns',
          reason: 'not-selected',
          retrieval: 'history://conversation/fixture',
          count: 4,
        }],
        omissionsTruncated: false,
        compaction: {
          epoch: 0,
          checkpointSequence: null,
          compactedThroughSequence: null,
          warningIssued: false,
          modelRequested: false,
          policyInputTokens: 3_200,
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

    function conversationSummaries() {
      return [...resources.entries()]
        .filter(([key]) => key.startsWith('conversation:'))
        .map(([, resource]) => resource.value)
        .sort((left, right) => right.updatedAt - left.updatedAt || right.id.localeCompare(left.id));
    }

    function syncConversationList() {
      const existing = resources.get('conversation-list');
      if (!existing) return;
      existing.value = { conversations: conversationSummaries(), truncated: false };
      existing.revision += 1;
      invalidateResource('conversation-list');
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
      targetConversationId = conversationId,
    ) {
      dispatchInvalidations([{
        type: 'transcript', key: `transcript:${targetConversationId}`, conversationId: targetConversationId,
        turnId, reason, affectsOrder, affectsLayout: true, basisSequence: sequence,
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
      if (key.startsWith('conversation:')) syncConversationList();
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

    function createRunningTurn(text: string, clientMessageId: string, parts?: any[]) {
      turnCounter += 1;
      const id = `fixture-turn-${turnCounter}`;
      const workId = `${id}:work`;
      const scopeId = `00000000-0000-4000-8000-${String(turnCounter).padStart(12, '0')}`;
      const rootScopeId = `10000000-0000-4000-8000-${String(turnCounter).padStart(12, '0')}`;
      const startedAt = Date.now();
      const turn: Turn = {
        id,
        status: 'inProgress',
        startedAt,
        completedAt: null,
        durationMs: null,
        error: null,
        renderRevision: `${id}:1`,
        layoutRevision: `${id}:1`,
        segments: [
          {
            id: `${id}:user`, type: 'userMessage', clientMessageId, revision: '1', text,
            ...(parts ? { parts: storedFixtureParts(parts) } : {}),
          },
          {
            id: workId, type: 'work', scopeId: rootScopeId, state: 'running', revision: '1',
            layoutRevision: '1', durationMs: null, inferenceCount: 1,
            operationCount: 3, workUnitCount: 1,
          },
          { id: `${id}:assistant`, type: 'assistantMessage', revision: '1', text: '' },
        ],
      };
      executionScopes.set(executionScopeKey(id, rootScopeId), {
        conversationId, turnId: id, scopeId: rootScopeId,
        parentScopeId: null, parentOperationId: null, kind: 'turn', state: 'running',
        revision: 'root:1', basisSequence: sequence, startedAt, completedAt: null,
        durationMs: null, boundary: null,
        inferenceOrder: [`${id}:inference:root`],
        inferences: [{
          id: `${id}:inference:root`, ordinal: 0, state: 'completed', revision: 'inference:root:1',
          startedAt, completedAt: startedAt + 80, durationMs: 80,
          ...(!legacyInferenceTrace
            ? { contentOrder: ['reasoning', 'commentary', 'actions'] }
            : {}),
          commentary: {
            kind: 'assistantCommentary', state: 'final', text: 'Grounding the change in the current workspace.',
          },
          reasoning: {
            kind: 'providerSummary', state: 'final', text: '**Checking context.**',
          },
          actionGroup: {
            id: `${id}:actions:root`, status: 'running', callCount: 3,
            calls: [
              {
                id: `${id}:operation:readme`, callId: `${id}:readme`, name: 'workspace.read',
                presentation: { category: 'read', label: 'Read README.md', subject: 'README.md' },
                status: 'completed', revision: 'operation:readme:1',
                detailPreview: 'Read the workspace overview before editing.',
                outputPreview: '# Remux\n\nFixture file output.', durationMs: 42,
                childScopeId: null, childBoundary: null, childState: null,
                childDurationMs: null, childOperationCount: 0,
                childArtifactCount: 0, hasDetail: true,
              },
              {
                id: `${id}:operation:edit`, callId: `${id}:edit`, name: 'workspace.edit',
                presentation: { category: 'edit', label: 'Edited index.ts', subject: 'src/index.ts' },
                status: 'completed', revision: 'operation:edit:1',
                detailPreview: 'src/index.ts', outputPreview: '+export const value = 1;',
                durationMs: 34, childScopeId: null, childBoundary: null,
                childState: null, childDurationMs: null, childOperationCount: 0,
                childArtifactCount: 0, hasDetail: true,
              },
              {
                id: `${id}:operation:work-unit`, callId: `${id}:work-unit`, name: 'work_unit_start',
                presentation: { category: 'tool', label: 'Work Unit Start', subject: null },
                status: 'running', revision: 'operation:work-unit:1',
                detailPreview: 'Verify the focused seam', outputPreview: null, durationMs: null,
                childScopeId: scopeId,
                childBoundary: 'Verify the focused seam and close when its exact contract agrees.',
                childState: 'running', childDurationMs: null, childOperationCount: 1,
                childArtifactCount: 0, hasDetail: true,
              },
            ],
          },
        }],
        window: { startIndex: 0, endIndexExclusive: 1, hasEarlier: false, hasLater: false },
        result: null, artifacts: [],
      });
      executionScopes.set(executionScopeKey(id, scopeId), {
        conversationId, turnId: id, scopeId, parentScopeId: rootScopeId,
        parentOperationId: `${id}:operation:work-unit`, kind: 'workUnit', state: 'running',
        revision: 'child:1', basisSequence: sequence, startedAt, completedAt: null,
        durationMs: null,
        boundary: 'Verify the focused seam against its governing compatibility contract and close when the exact contract and implementation agree.',
        inferenceOrder: [`${id}:inference:child`],
        inferences: [{
          id: `${id}:inference:child`, ordinal: 0, state: 'completed', revision: 'inference:child:1',
          startedAt: startedAt + 90, completedAt: startedAt + 180, durationMs: 90,
          ...(!legacyInferenceTrace ? { contentOrder: ['reasoning', 'actions'] } : {}),
          commentary: null,
          reasoning: {
            kind: 'providerSummary', state: 'final',
            text: 'Compared the implementation with its contract.',
          },
          actionGroup: {
            id: `${id}:actions:child`, status: 'completed', callCount: 1,
            calls: [{
              id: `${id}:operation:test`, callId: `${id}:test`, name: 'bash',
              presentation: { category: 'command', label: 'Shell command', subject: 'npm test -- seam' },
              status: 'completed', revision: 'operation:test:1',
              detailPreview: 'npm test -- seam', outputPreview: '1 test passed', durationMs: 120,
              childScopeId: null, childBoundary: null,
              childState: null, childDurationMs: null, childOperationCount: 0,
              childArtifactCount: 0, hasDetail: true,
            }],
          },
        }],
        window: { startIndex: 0, endIndexExclusive: 1, hasEarlier: false, hasLater: false },
        result: null, artifacts: [],
      });
      turns.push(turn);
      touchTurn(turn);
      return turn;
    }

    function storedFixtureParts(parts: any[]) {
      return parts.map((part) => {
        if (part.type !== 'image') return part;
        const encoded = String(part.dataUrl).split(',')[1] ?? '';
        const bytes = Uint8Array.from(atob(encoded), (value) => value.charCodeAt(0));
        artifactBytes.set(pickedImageHash, {
          bytes,
          mediaType: String(part.mimeType ?? 'image/png'),
        });
        return {
          artifactHash: pickedImageHash,
          mimeType: String(part.mimeType ?? 'image/png'),
          name: String(part.name ?? 'Image'),
          sizeBytes: bytes.byteLength,
          type: 'image',
        };
      });
    }

    function finishTurn(
      turn: Turn,
      outcome: 'completed' | 'failed' | 'interrupted',
      dispatchQueued = true,
    ) {
      turn.status = outcome;
      turn.completedAt = Date.now();
      turn.durationMs = Math.max(1_000, turn.completedAt - turn.startedAt);
      const work = turn.segments.find((segment) => segment.type === 'work');
      const assistant = turn.segments.find((segment) => segment.type === 'assistantMessage');
      if (work) {
        work.state = outcome;
        work.durationMs = turn.durationMs;
        const rootScope = executionScopes.get(executionScopeKey(turn.id, work.scopeId));
        const workCall = rootScope?.inferences[0]?.actionGroup?.calls
          .find((call: any) => call.childScopeId);
        if (rootScope) {
          rootScope.revision = `root:${sequence + 1}`;
          rootScope.basisSequence = sequence + 1;
          rootScope.state = outcome;
          rootScope.completedAt = turn.completedAt;
          rootScope.durationMs = turn.durationMs;
          if (workCall) {
            workCall.status = outcome === 'completed' ? 'completed' : 'interrupted';
            workCall.durationMs = turn.durationMs;
            workCall.revision = `operation:work-unit:${sequence + 1}`;
            workCall.childState = outcome === 'completed' ? 'completed' : 'abandoned';
            workCall.childDurationMs = turn.durationMs;
            workCall.childArtifactCount = outcome === 'completed' ? 1 : 0;
          }
          if (rootScope.inferences[0]?.actionGroup) {
            rootScope.inferences[0].actionGroup.status = outcome;
          }
        }
        const childScope = workCall?.childScopeId
          ? executionScopes.get(executionScopeKey(turn.id, workCall.childScopeId))
          : null;
        if (childScope) {
          childScope.revision = `child:${sequence + 1}`;
          childScope.basisSequence = sequence + 1;
          childScope.state = outcome === 'completed' ? 'completed' : 'abandoned';
          childScope.completedAt = turn.completedAt;
          childScope.durationMs = turn.durationMs;
          childScope.result = outcome === 'completed'
            ? '## Verified\n\n**The focused seam matches its exact contract without changing unrelated runtime behavior.**'
            : null;
          childScope.artifacts = outcome === 'completed'
            ? [{
                ref: 'src/index.ts',
                snapshotRef: `history://artifact/${'a'.repeat(64)}`,
                byteLength: 23,
              }]
            : [];
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
      updateResource(conversationKey, (summary) => {
        summary.status = outcome === 'failed' ? 'error' : 'idle';
        summary.latestTurnId = turn.id;
        summary.updatedAt = Date.now();
      });
      updateResource('runtime', (runtime) => {
        runtime.state = outcome === 'failed' ? 'error' : 'idle';
        runtime.activeTurnId = null;
        runtime.activeTurnElapsedMs = null;
        runtime.error = outcome === 'failed' ? 'Fixture provider failure.' : null;
      });
      invalidateTranscript(turn.id, 'terminal', false);
      if (work) {
        dispatchInvalidations([{
          type: 'executionScope',
          key: executionScopeKey(turn.id, work.scopeId),
          conversationId, turnId: turn.id, scopeId: work.scopeId,
          reason: 'terminal', affectsLayout: true, basisSequence: sequence,
        }]);
        const rootScope = executionScopes.get(executionScopeKey(turn.id, work.scopeId));
        const childScopeId = rootScope?.inferences[0]?.actionGroup?.calls
          .find((call: any) => call.childScopeId)?.childScopeId;
        if (childScopeId) {
          dispatchInvalidations([{
            type: 'executionScope',
            key: executionScopeKey(turn.id, childScopeId),
            conversationId, turnId: turn.id, scopeId: childScopeId,
            reason: 'terminal', affectsLayout: true, basisSequence: sequence,
          }]);
        }
      }
      if (dispatchQueued && pendingQueue.length > 0) {
        const next = pendingQueue.shift()!;
        syncFixtureQueue();
        window.setTimeout(() => startFixtureMessage(next), 0);
      }
    }

    function syncFixtureQueue() {
      const key = `queue:${conversationId}`;
      const entry = resources.get(key);
      const value = {
        conversationId,
        entries: pendingQueue.map((item) => ({
          attachmentCount: item.parts?.filter((part) => part.type === 'image').length ?? 0,
          createdAt: Date.now(),
          id: item.operationId,
          mentionCount: item.parts?.filter((part) => part.type === 'mention').length ?? 0,
          text: item.text,
        })),
      };
      if (entry) {
        entry.revision += 1;
        entry.value = value;
      } else {
        resources.set(key, { revision: 1, value });
      }
      invalidateResource(key, entry ? 'updated' : 'created');
    }

    function startFixtureMessage(params: { clientMessageId: string; parts?: any[]; text: string }) {
      const turn = createRunningTurn(String(params.text), String(params.clientMessageId), params.parts);
      updateResource(conversationKey, (summary) => {
        summary.status = 'running';
        summary.title = String(params.text);
        summary.preview = String(params.text);
        summary.latestTurnId = turn.id;
        summary.updatedAt = Date.now();
      });
      updateResource('runtime', (runtime) => {
        runtime.conversationId = conversationId;
        runtime.state = 'running';
        runtime.activeTurnId = turn.id;
        runtime.activeTurnElapsedMs = 0;
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
      return turn;
    }

    function transcriptSync(request: any, targetConversationId: string, targetTurns: Turn[]) {
      const allIds = targetTurns.map((turn) => turn.id);
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
      const selected = targetTurns.slice(start, end);
      const known = new Map((request.knownTurns ?? []).map((entry: any) => [entry.turnId, entry.renderRevision]));
      return {
        protocolVersion: 4,
        projectionVersion: 'agent-turn-render-v4',
        conversationId: targetConversationId,
        conversationRevision: `conversation:${sequence}`,
        basisSequence: sequence,
        activeTurnId: resources.get('runtime')?.value.conversationId === targetConversationId
          ? resources.get('runtime')?.value.activeTurnId ?? null
          : null,
        turnOrder: selected.map((turn) => turn.id),
        turns: selected.map((turn) => known.get(turn.id) === turn.renderRevision
          ? { status: 'notModified', turnId: turn.id, renderRevision: turn.renderRevision }
          : { status: 'ok', turnId: turn.id, renderRevision: turn.renderRevision, frame: turn }),
        removedTurnIds: [],
        window: {
          startIndex: start,
          endIndexExclusive: end,
          hasEarlier: start > 0,
          hasLater: end < targetTurns.length,
          turnIds: selected.map((turn) => turn.id),
        },
      };
    }

    function transcriptResult(params: any) {
      const targetConversationId = String(params.conversationId);
      if (!resources.has(`conversation:${targetConversationId}`)) {
        return { conversationId: targetConversationId, serverGeneration: generation, resources: params.requests.map((_: any, requestIndex: number) => ({ requestIndex, key: `transcript:${targetConversationId}`, status: 'missing' })) };
      }
      return {
        conversationId: targetConversationId,
        serverGeneration: generation,
        resources: params.requests.map((request: any, requestIndex: number) => {
          if (request.type === 'transcriptSync') {
            const value = transcriptSync(
              request,
              targetConversationId,
              turnsByConversation.get(targetConversationId) ?? [],
            );
            return {
              requestIndex, key: `transcript:${targetConversationId}`, status: 'ok',
              revision: value.conversationRevision, value,
            };
          }
          if (request.type === 'executionScope') {
            const key = executionScopeKey(request.turnId, request.scopeId);
            const value = executionScopes.get(key);
            if (!value) return { requestIndex, key, status: 'missing' };
            if (request.knownRevision === value.revision) {
              return { requestIndex, key, status: 'notModified', revision: value.revision };
            }
            return { requestIndex, key, status: 'ok', revision: value.revision, value };
          }
          if (request.type === 'operationDetail') {
            const key = `operationDetail:${conversationId}:${request.turnId}:${request.scopeId}:${request.operationId}`;
            const scope = executionScopes.get(executionScopeKey(request.turnId, request.scopeId));
            const call = scope?.inferences
              .flatMap((inference: any) => inference.actionGroup?.calls ?? [])
              .find((candidate: any) => candidate.id === request.operationId);
            if (!call) return { requestIndex, key, status: 'missing' };
            const value = {
              conversationId, turnId: request.turnId, scopeId: request.scopeId,
              operationId: request.operationId, revision: call.revision,
              detail: call.detailPreview, output: call.outputPreview,
              truncation: {
                originalBytes: String(call.detailPreview ?? '').length + String(call.outputPreview ?? '').length,
                returnedBytes: String(call.detailPreview ?? '').length + String(call.outputPreview ?? '').length,
                truncated: false,
              },
            };
            if (request.knownRevision === value.revision) {
              return { requestIndex, key, status: 'notModified', revision: value.revision };
            }
            return { requestIndex, key, status: 'ok', revision: value.revision, value };
          }
          return { requestIndex, key: `unknown:${request.type}`, status: 'missing' };
        }),
      };
    }

    function executionScopeKey(turnId: string, scopeId: string) {
      return `executionScope:${conversationId}:${turnId}:${scopeId}`;
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
              return {
                key: item.key, status: 'notModified', revision: entry.revision,
                basisSequence: entry.revision, serverGeneration: generation,
              };
            }
            return {
              key: item.key, status: 'ok', revision: entry.revision,
              basisSequence: entry.revision, serverGeneration: generation, value: entry.value,
            };
          }),
        };
      }
      if (request.method === 'remux/agent/transcript/resources/read') return transcriptResult(params);
      if (request.method === 'remux/agent/artifact/read') {
        const binary = artifactBytes.get(params.hash);
        if (binary && params.range.kind === 'bytes') {
          const start = Math.min(Number(params.range.offset), binary.bytes.byteLength);
          const end = Math.min(binary.bytes.byteLength, start + Number(params.range.byteLength));
          const selected = binary.bytes.slice(start, end);
          const content = btoa(String.fromCharCode(...selected));
          return {
            hash: params.hash,
            mediaType: binary.mediaType,
            totalByteLength: binary.bytes.byteLength,
            totalLineCount: null,
            range: { kind: 'bytes', offset: start, byteLength: end - start },
            encoding: 'base64',
            content,
            truncated: end < binary.bytes.byteLength,
            nextRange: end < binary.bytes.byteLength
              ? { kind: 'bytes', offset: end, byteLength: Number(params.range.byteLength) }
              : null,
          };
        }
        const artifactText = artifactTexts.get(params.hash);
        if (artifactText === undefined || params.range.kind !== 'utf8') {
          throw new Error('Fixture artifact range was not found.');
        }
        const bytes = new TextEncoder().encode(artifactText);
        const start = Math.min(Number(params.range.offset), bytes.byteLength);
        const end = Math.min(bytes.byteLength, start + Number(params.range.byteLength));
        const nextRange = end < bytes.byteLength
          ? { kind: 'utf8', offset: end, byteLength: Number(params.range.byteLength) }
          : null;
        return {
          hash: params.hash,
          mediaType: params.hash === contextManifestHash ? 'application/json' : 'text/plain; charset=utf-8',
          totalByteLength: bytes.byteLength,
          totalLineCount: null,
          range: { kind: 'utf8', offset: start, byteLength: end - start },
          encoding: 'utf8',
          content: new TextDecoder().decode(bytes.slice(start, end)),
          truncated: nextRange !== null,
          nextRange,
        };
      }
      if (request.method === 'remux/agent/conversation/create') {
        resources.set(conversationKey, {
          revision: 1,
          value: { ...conversationSummary(params.cwd, 'idle'), modelId: params.modelId, reasoning: params.reasoning },
        });
        resources.set('runtime', {
          revision: (resources.get('runtime')?.revision ?? 0) + 1,
          value: { ...runtimeValue('idle'), contextProbe: { ...runtimeValue('idle').contextProbe, modelId: params.modelId } },
        });
        invalidateResource(conversationKey, 'created');
        syncConversationList();
        invalidateResource('runtime');
        return { conversationId };
      }
      if (request.method === 'remux/agent/conversation/message/send') {
        if (nextMessageError) {
          const message = nextMessageError;
          nextMessageError = null;
          throw new Error(message);
        }
        const runtime = resources.get('runtime')?.value;
        if (runtime?.state === 'running' || runtime?.state === 'interrupting') {
          pendingQueue.push({
            clientMessageId: String(params.clientMessageId),
            operationId: String(params.operationId),
            ...(Array.isArray(params.parts) ? { parts: params.parts } : {}),
            text: String(params.text),
          });
          syncFixtureQueue();
          return {
            accepted: true, delivery: 'queued', operationId: params.operationId, turnId: null,
          };
        }
        const turn = startFixtureMessage({
          clientMessageId: String(params.clientMessageId),
          ...(Array.isArray(params.parts) ? { parts: params.parts } : {}),
          text: String(params.text),
        });
        updateResource('runtime', (value) => {
          value.contextProbe = {
            ...value.contextProbe,
            modelCallCount: 1,
            messageCount: 1,
            messageHash: 'fixture-hash',
            orderedMessageHashes: ['fixture-message'],
            estimatedBytes: 128,
            providerRequestMode: 'full',
          };
        });
        resources.set(contextKey, {
          revision: (resources.get(contextKey)?.revision ?? 0) + 1,
          value: contextValue('append'),
        });
        invalidateResource(contextKey);
        return { accepted: true, operationId: params.operationId, turnId: turn.id };
      }
      if (request.method === 'remux/agent/conversation/message/queue/remove') {
        const index = pendingQueue.findIndex((entry) => entry.operationId === params.operationId);
        if (index < 0) return { status: 'retained' };
        pendingQueue.splice(index, 1);
        syncFixtureQueue();
        return { status: 'removed' };
      }
      if (request.method === 'remux/agent/conversation/message/queue/run-now') {
        const index = pendingQueue.findIndex((entry) => entry.operationId === params.operationId);
        if (index < 0) return { status: 'retained' };
        const [selected] = pendingQueue.splice(index, 1);
        pendingQueue.unshift(selected!);
        const active = turns.find((candidate) => candidate.status === 'inProgress');
        if (active) finishTurn(active, 'interrupted', false);
        const next = pendingQueue.shift();
        syncFixtureQueue();
        if (next) window.setTimeout(() => startFixtureMessage(next), 0);
        return { status: 'running' };
      }
      if (request.method === 'remux/agent/conversation/message/edit' ||
          request.method === 'remux/agent/conversation/message/fork') {
        const branchId = `33333333-3333-4333-8333-${String(turnCounter + 1).padStart(12, '0')}`;
        const isFork = request.method.endsWith('/fork');
        const sourceTurns = turnsByConversation.get(String(params.sourceConversationId)) ?? [];
        const targetIndex = sourceTurns.findIndex((turn) => turn.id === params.sourceTurnId);
        const prefix = isFork && targetIndex >= 0 ? sourceTurns.slice(0, targetIndex + 1) : sourceTurns.slice(0, Math.max(0, targetIndex));
        const replacement = completedTurn(
          `branch-turn-${turnCounter + 1}`,
          String(params.text),
          'The fixture branch completed.',
        );
        const replacementUser = replacement.segments.find((segment) => segment.type === 'userMessage');
        if (replacementUser) replacementUser.clientMessageId = String(params.clientMessageId);
        const branchTurns = [...prefix.map((turn) => structuredClone(turn)), replacement];
        turnsByConversation.set(branchId, branchTurns);
        resources.set(`conversation:${branchId}`, {
          revision: 1,
          value: {
            ...conversationSummary('/tmp/remux-fixture', 'idle', branchId),
            latestTurnId: replacement.id,
            preview: String(params.text),
            title: String(params.text),
          },
        });
        resources.set('runtime', {
          revision: (resources.get('runtime')?.revision ?? 0) + 1,
          value: { ...runtimeValue('idle'), conversationId: branchId, activeTurnId: null },
        });
        syncConversationList();
        invalidateResource(`conversation:${branchId}`, 'created');
        invalidateResource('runtime');
        invalidateTranscript(replacement.id, 'terminal', true, branchId);
        return { conversationId: branchId, turnId: replacement.id };
      }
      if (request.method === 'remux/agent/files/search') {
        const query = String(params.query ?? '').toLowerCase();
        const files = [
          {
            absolutePath: '/tmp/remux-fixture/README.md', id: 'fixture-readme', kind: 'file',
            name: 'README.md', parentPath: '.', path: 'README.md', score: 100,
          },
          {
            absolutePath: '/tmp/remux-fixture/src/index.ts', id: 'fixture-index', kind: 'file',
            name: 'index.ts', parentPath: 'src', path: 'src/index.ts', score: 90,
          },
          {
            absolutePath: '/tmp/remux-fixture/extensions/agent', id: 'fixture-agent', kind: 'directory',
            name: 'agent', parentPath: 'extensions', path: 'extensions/agent/', score: 80,
          },
        ];
        return { results: files.filter((entry) => entry.path.toLowerCase().includes(query)) };
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
      if (request.method === 'host/attachments/pick') {
        return {
          assets: [{
            dataUrl: pickedImageDataUrl,
            mimeType: 'image/png',
            name: 'picked.png',
            sizeBytes: pickedImageBytes.byteLength,
          }],
          canceled: false,
        };
      }
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
            try {
              if (request.method === 'remux/agent/transcript/resources/read' && nextTranscriptDelayMs > 0) {
                const result = resultFor(request);
                const delay = nextTranscriptDelayMs;
                nextTranscriptDelayMs = 0;
                setTimeout(() => dispatch({ type: 'remux/response', id: request.id, result }), delay);
                return;
              }
              dispatch({ type: 'remux/response', id: request.id, result: resultFor(request) });
            } catch (error) {
              dispatch({
                type: 'remux/error',
                id: request.id,
                error: {
                  code: -32019,
                  data: { kind: 'active_runtime_busy' },
                  message: error instanceof Error ? error.message : String(error),
                },
              });
            }
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
        addConversation(input: { cwd?: string; id: string; preview?: string; title: string }) {
          const key = `conversation:${input.id}`;
          resources.set(key, {
            revision: 1,
            value: {
              ...conversationSummary(input.cwd ?? '/tmp/remux-fixture', 'idle'),
              id: input.id,
              latestTurnId: null,
              preview: input.preview ?? '',
              title: input.title,
              updatedAt: Date.now() + 1,
            },
          });
          invalidateResource(key, 'created');
          syncConversationList();
        },
        delayNextTranscript(delayMs: number) {
          nextTranscriptDelayMs = Math.max(0, delayMs);
        },
        reviseLatestExecutionScope() {
          const turn = turns.at(-1);
          const work = turn?.segments.find((segment) => segment.type === 'work');
          if (!turn || !work) throw new Error('No fixture execution scope is available.');
          const key = executionScopeKey(turn.id, work.scopeId);
          const value = executionScopes.get(key);
          if (!value) throw new Error('No fixture execution-scope resource is available.');
          sequence += 1;
          const inferenceId = `${turn.id}:inference:refresh`;
          value.revision = `root:${sequence}`;
          value.basisSequence = sequence;
          value.inferenceOrder = [value.inferenceOrder[0], inferenceId];
          value.inferences = [value.inferences[0], {
            id: inferenceId, ordinal: 1, state: 'completed', revision: `inference:refresh:${sequence}`,
            startedAt: Date.now(), completedAt: Date.now() + 10, durationMs: 10,
            ...(!legacyInferenceTrace ? { contentOrder: ['reasoning'] } : {}),
            commentary: null,
            reasoning: {
              kind: 'providerSummary', state: 'final',
              text: 'Validated the refreshed execution-scope revision.',
            },
            actionGroup: null,
          }];
          dispatchInvalidations([{
            type: 'executionScope', key, conversationId, turnId: turn.id,
            scopeId: work.scopeId, reason: 'runtimeEvent', affectsLayout: true,
            basisSequence: sequence,
          }]);
        },
        rejectNextMessage(message = 'Another conversation has an active turn.') {
          nextMessageError = message;
        },
        lifecycle: dispatchLifecycle,
        navigate(resourceKind: string, resourceId: string, focusKind?: string, focusId?: string) {
          dispatch({
            type: 'remux/event',
            message: {
              jsonrpc: '2.0',
              method: 'host/navigate',
              params: {
                focusId: focusId ?? null,
                focusKind: focusKind ?? null,
                nonce: `fixture-navigation-${Date.now()}`,
                resourceId,
                resourceKind,
              },
            },
          });
        },
        reconnect() {
          dispatchStatus('reconnecting');
          setTimeout(() => {
            dispatchStatus('connected');
            dispatchLifecycle('active', 'reconnect');
          }, 20);
        },
        resetGeneration() {
          generation = `fixture-generation-${Date.now()}`;
          const auth = resources.get('auth');
          if (auth) auth.revision += 1;
          const runtime = resources.get('runtime');
          if (runtime) {
            runtime.revision += 1;
            runtime.value = runtimeValue('unloaded');
          }
          dispatchInvalidations([
            { type: 'resource', key: 'auth', reason: 'updated' },
            { type: 'resource', key: 'runtime', reason: 'updated' },
            { type: 'resource', key: conversationKey, reason: 'updated' },
          ]);
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
