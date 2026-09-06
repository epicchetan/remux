import type { Page } from '@playwright/test';
import { NATIVE_AGENT_PROTOCOL_VERSION } from '../shared/native-agent-protocol.ts';
import {
  AGENT_TRANSCRIPT_PROJECTION_VERSION,
  AGENT_TRANSCRIPT_PROTOCOL_VERSION,
} from '../shared/transcript.ts';

export const FIXTURE_CONVERSATION_ID = '11111111-1111-4111-8111-111111111111';
export const FIXTURE_SECOND_CONVERSATION_ID = '22222222-2222-4222-8222-222222222222';

export async function installAgentHost(page: Page) {
  await page.addInitScript(({
    nativeProtocolVersion,
    transcriptProjectionVersion,
    transcriptProtocolVersion,
  }) => {
    type HostRequest = {
      id?: number | string;
      method?: string;
      params?: any;
      type?: string;
    };
    type Resource = { revision: number; value: any };
    type Turn = {
      id: string;
      pathEntryId?: string;
      strandId?: string;
      ordinal?: number;
      status: 'queued' | 'inProgress' | 'completed' | 'failed' | 'interrupted';
      startedAt: number;
      completedAt: number | null;
      durationMs: number | null;
      error: { code: 'provider_error' | 'runtime_error'; message: string } | null;
      renderRevision: string;
      layoutRevision: string;
      segments: any[];
    };

    const conversationId = '11111111-1111-4111-8111-111111111111';
    const providerInstanceId = 'fixture-local';
    const capabilityRevision = 'fixture-capabilities-v1';
    const conversationKey = `conversation:${conversationId}`;
    let generation = 'fixture-generation';
    const route = new URL(window.location.href).searchParams;
    const signedOut = route.get('fixtureSignedOut') === '1';
    const resourceReadFailure = route.get('fixtureResourceFailure') === '1';
    const routedConversation = route.get('remuxResourceKind') === 'agentConversation'
      && route.get('remuxResourceId') === conversationId;
    const longTranscript = route.get('fixtureLong') === '1';
    const longFinalResponse = route.get('fixtureLongFinal') === '1';
    const markdownTranscript = route.get('fixtureMarkdown') === '1';
    const overflowTranscript = route.get('fixtureOverflow') === '1';
    const exactTranscript = route.get('fixtureExact') === '1';
    const contextTurns = route.get('fixtureContextTurns') === '1';
    const diffTranscript = route.get('fixtureDiff') === '1';
    const runningTranscript = route.get('fixtureRunning') === '1';
    const tallRunningWork = route.get('fixtureTallWork') === '1';
    const compactionTranscript = route.get('fixtureCompaction') === '1';
    const errorGeometryTranscript = route.get('fixtureErrorGeometry') === '1';
    const effortFixture = route.get('fixtureEffort');
    const compactEligibility = route.get('fixtureCompactEligibility');
    const delayModels = route.get('fixtureDelayModels') === '1';
    const currentEffortNull = route.get('fixtureCurrentEffortNull') === '1';
    let modelsDelayed = false;
    let historyState: 'failed' | 'ready' = route.get('fixtureHistoryFailed') === '1'
      ? 'failed'
      : 'ready';
    const persistedNativeConfig = JSON.parse(
      window.sessionStorage.getItem('remux.agent.fixture.native-config') ?? 'null',
    ) as { modelId?: string; reasoning?: string | null; serviceTier?: string } | null;
    let nativeModelId = persistedNativeConfig?.modelId ?? 'gpt-5.6-sol';
    let nativeReasoning: string | null = persistedNativeConfig?.reasoning ?? 'high';
    let nativeServiceTier = persistedNativeConfig?.serviceTier ?? 'default';
    let preferenceRevision = 'fixture-preference-v1';
    let usageObservedAt = 1_700_000_000_000;
    let contextUsedTokens = 36_000;
    let fiveHourUsagePercent = 18;
    let weeklyUsagePercent = 42;
    const exactArtifactHash = 'a'.repeat(64);
    const pickedImageHash = 'b'.repeat(64);
    const diffArtifactHash = 'c'.repeat(64);
    const pickedImageDataUrl = 'data:image/png;base64,iVBORw0KGgo=';
    const pickedImageBytes = Uint8Array.from(atob(pickedImageDataUrl.split(',')[1]!), (value) => value.charCodeAt(0));
    const exactPreview = 'Exact preview. ';
    const exactFullText = `${exactPreview}The remaining response is fetched only when requested.`;
    const artifactTexts = new Map([
      [exactArtifactHash, exactFullText],
      [diffArtifactHash, '--- a/src/index.ts\n+++ b/src/index.ts\n@@ -0,0 +1 @@\n+export const value = 1;\n'],
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
        defaultModelId: signedOut ? null : 'gpt-5.6-sol', error: null,
        models: signedOut ? [] : effortFixture ? [{
          id: `fixture-${effortFixture}`, name: `Fixture ${effortFixture}`, provider: 'openai-codex',
          contextWindow: 100000, supportedReasoning: effortFixture === 'none' ? [] : [effortFixture],
          serviceTiers: [{ id: 'default', name: 'Standard' }], defaultServiceTier: 'default',
        }] : [
          {
            id: 'gpt-5.4-fixture', name: 'GPT-5.4 Fixture', provider: 'openai-codex',
            contextWindow: 400000, supportedReasoning: ['low', 'medium', 'high', 'xhigh'],
            serviceTiers: [{ id: 'default', name: 'Standard', description: 'Standard speed and usage' }],
            defaultServiceTier: 'default',
          },
          {
            id: 'gpt-5.6-sol', name: 'GPT-5.6 Sol', provider: 'openai-codex',
            contextWindow: 1000000, supportedReasoning: ['low', 'medium', 'high', 'xhigh'],
            serviceTiers: [
              { id: 'default', name: 'Standard', description: 'Standard speed and usage' },
              { id: 'priority', name: 'Fast', description: 'Faster responses with higher usage' },
            ],
            defaultServiceTier: 'default',
          },
        ],
      } }],
      ['runtime', { revision: 1, value: runtimeValue('unloaded') }],
    ]);
    const turns: Turn[] = [];
    const turnsByConversation = new Map<string, Turn[]>([[conversationId, turns]]);
    const versionsByConversation = new Map<string, Array<{
      strandId: string;
      reason: 'initial' | 'edit' | 'fork' | 'restore';
      sourceStrandId: string | null;
      sourcePathEntryId: string | null;
      turns: Turn[];
      createdAt: number;
    }>>();
    const pendingQueue: Array<{
      clientMessageId: string;
      modelId: string;
      operationId: string;
      parts?: any[];
      reasoning: string | null;
      text: string;
    }> = [];
    const executionScopes = new Map<string, any>();
    const lifecycleByConversation = new Map<string, any>();
    const requestLog: Array<{ method: string; summary: string }> = [];
    const commandReceipts = new Map<string, any>(JSON.parse(
      window.sessionStorage.getItem('remux.agent.fixture.command-receipts') ?? '[]',
    ));
    const saveCommandReceipts = () => window.sessionStorage.setItem(
      'remux.agent.fixture.command-receipts', JSON.stringify(Array.from(commandReceipts)),
    );
    if (Array.from(commandReceipts.values()).some((receipt) =>
      receipt.kind === 'conversation.create' && receipt.state === 'accepted')) {
      resources.set(conversationKey, {
        revision: 1,
        value: conversationSummary('/tmp/remux-fixture', 'idle'),
      });
      resources.set('runtime', { revision: 2, value: runtimeValue('idle') });
    }
    const recoveredMessages = JSON.parse(
      window.sessionStorage.getItem('remux.agent.fixture.accepted-messages') ?? '[]',
    ) as Array<{ commandId: string; turnId: string; text: string }>;
    for (const recovered of recoveredMessages) {
      turns.push(completedTurn(recovered.turnId, recovered.text, 'The fixture stream completed.'));
    }
    let sequence = 1;
    let turnCounter = recoveredMessages.length;
    const recoveredQueue = JSON.parse(
      window.sessionStorage.getItem('remux.agent.fixture.accepted-queue') ?? '[]',
    ) as typeof pendingQueue;
    pendingQueue.push(...recoveredQueue);
    let lifecycleEpoch = 1;
    let invalidationsDropped = false;
    let nextTranscriptDelayMs = 0;
    let transcriptFailuresRemaining = 0;
    let nextMessageError: string | null = null;
    let holdReadsAfterNextMessageError = false;
    let loseNextCreateResponse = false;
    let loseNextMessageResponse = false;
    let holdCommandReadsUntilReload = false;
    let nextCreateResponseDelayMs = 0;
    let viewportMetrics = {
      keyboardHeight: 0,
      keyboardVisible: false,
      visibleBottom: window.innerHeight,
      visibleTop: 0,
      viewportHeight: window.innerHeight,
      viewportWidth: window.innerWidth,
    };
    if (recoveredQueue.length) syncFixtureQueue();

    if (routedConversation) {
      resources.set(conversationKey, {
        revision: 3,
        value: conversationSummary('/tmp/remux-fixture', 'idle'),
      });
      resources.set('runtime', { revision: 2, value: runtimeValue('idle') });
      if (errorGeometryTranscript) {
        for (let index = 1; index <= 48; index += 1) {
          const turn = completedTurn(
            `turn-${index}`,
            `Geometry request ${index}`,
            `Geometry answer ${index}.`,
          );
          if (index === 24) {
            turn.status = 'failed';
            turn.error = { code: 'provider_error', message: '   ' };
          }
          if (index === 25) {
            turn.status = 'failed';
            turn.error = { code: 'provider_error', message: 'CapacityErrorToken'.repeat(30) };
          }
          if (index === 26) {
            turn.status = 'failed';
            turn.error = { code: 'provider_error', message: 'Short capacity error.' };
          }
          if (index === 27) {
            turn.status = 'failed';
            turn.error = {
              code: 'provider_error',
              message: 'Selected model is at capacity. Please try a different model or wait briefly before retrying this request. '.repeat(4),
            };
          }
          turns.push(turn);
        }
        sequence = 48;
        turnCounter = 48;
        const workError = createRunningTurn('Expanded error request', 'expanded-error-client', undefined, 'turn-work-error');
        workError.status = 'failed';
        workError.completedAt = Date.now();
        workError.durationMs = 1_000;
        workError.error = { code: 'provider_error', message: 'Failure after expanded work.' };
        const work = workError.segments.find((segment) => segment.type === 'work');
        if (work) {
          work.state = 'failed';
          work.durationMs = 1_000;
          const scope = executionScopes.get(executionScopeKey(workError.id, work.scopeId));
          if (scope) {
            scope.state = 'failed';
            scope.completedAt = workError.completedAt;
            scope.durationMs = workError.durationMs;
          }
        }
        touchTurn(workError);
        turns.push(completedTurn('turn-after-work-error', 'Healthy request after work', 'Healthy answer after work.'));
        turnCounter = 50;
      } else if (runningTranscript) {
        if (longTranscript) {
          for (let index = 1; index <= 48; index += 1) {
            turns.push(completedTurn(`turn-${index}`, `Historical request ${index}`, `Historical answer ${index}.`));
          }
          sequence = 48;
          turnCounter = 48;
        }
        const running = createRunningTurn(
          'Resume this running turn',
          'fixture-running-client-message',
        );
        if (compactionTranscript) {
          running.segments.unshift({
            id: 'compaction:before-running',
            type: 'compaction',
            revision: 'before-running:completed',
            status: 'compacted',
            trigger: 'manual',
            beforeTokens: 82_000,
            afterTokens: 9_000,
          });
        }
        const storedStartedAt = Number(
          window.sessionStorage.getItem('remux.agent.fixture.running-started-at'),
        );
        running.startedAt = Number.isFinite(storedStartedAt) && storedStartedAt > 0
          ? storedStartedAt
          : Date.now() - 3_000;
        window.sessionStorage.setItem(
          'remux.agent.fixture.running-started-at',
          String(running.startedAt),
        );
        const summary = resources.get(conversationKey)!.value;
        summary.status = 'running';
        summary.latestTurnId = running.id;
        summary.updatedAt = Date.now();
        const runtime = runtimeValue('running');
        runtime.activeTurnId = running.id;
        resources.set('runtime', { revision: 3, value: runtime });
      } else if (longTranscript) {
        for (let index = 1; index <= 72; index += 1) {
          const response = index === 72 && longFinalResponse
            ? Array.from(
                { length: 56 },
                (_, paragraph) => `Historical answer 72, paragraph ${paragraph + 1}. This is intentionally long enough to keep the final user message reachable at its modeled anchor.`,
              ).join('\n\n')
            : `Historical answer ${index}.`;
          turns.push(completedTurn(`turn-${index}`, `Historical request ${index}`, response));
        }
        sequence = 72;
        turnCounter = 72;
      } else if (contextTurns) {
        for (let index = 1; index <= 7; index += 1) {
          turns.push(completedTurn(`turn-${index}`, `Context request ${index}`, `Context answer ${index}.`));
        }
        sequence = 7;
        turnCounter = 7;
      } else if (compactionTranscript) {
        const compacted = completedTurn(
          'compaction-turn',
          'Continue after the manual boundary.',
          'Context restored.',
        );
        compacted.segments = [{
          id: 'compaction:before', type: 'compaction', revision: 'before:completed',
          status: 'compacted', trigger: 'manual', beforeTokens: 82_000, afterTokens: 9_000,
        }, ...compacted.segments, {
          id: 'compaction:after', type: 'compaction', revision: 'after:started',
          status: 'compacting', trigger: 'automatic', beforeTokens: 96_000, afterTokens: null,
        }];
        turns.push(compacted);
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
        modelId: nativeModelId,
        reasoning: nativeReasoning,
        serviceTier: nativeServiceTier,
        access: 'workspace-write',
        status,
        latestTurnId: targetTurns.at(-1)?.id ?? null,
        parentConversationId: null,
        rootConversationId: id,
        forkedFromPathEntryId: null,
        activeStrandId: `fixture-strand:${id}:initial`,
        headRevision: 1,
        versionCount: 1,
        childCount: 0,
        archivedAt: null,
        metadataRevision: 1,
        createdAt: 1_700_000_000_000,
        subtreeUpdatedAt: Date.now(),
        updatedAt: Date.now(),
      };
    }

    function runtimeValue(state: string) {
      return {
        conversationId: state === 'unloaded' ? null : conversationId,
        state,
        activeTurnId: null as string | null,
        activeTurnElapsedMs: null,
        error: null,
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

    function fixturePathEntryId(targetConversationId: string, turnId: string) {
      return `fixture-path:${targetConversationId}:${turnId}`;
    }

    function ensureConversationVersions(targetConversationId: string) {
      const existing = versionsByConversation.get(targetConversationId);
      if (existing) return existing;
      const summary = resources.get(`conversation:${targetConversationId}`)?.value;
      const initial = [{
        strandId: String(summary?.activeStrandId ?? `fixture-strand:${targetConversationId}:initial`),
        reason: 'initial' as const,
        sourceStrandId: null,
        sourcePathEntryId: null,
        turns: structuredClone(turnsByConversation.get(targetConversationId) ?? []),
        createdAt: Number(summary?.createdAt ?? Date.now()),
      }];
      versionsByConversation.set(targetConversationId, initial);
      return initial;
    }

    function sourceTurnIndex(targetConversationId: string, sourcePathEntryId: string) {
      const targetTurns = turnsByConversation.get(targetConversationId) ?? [];
      return targetTurns.findIndex((turn) =>
        fixturePathEntryId(targetConversationId, turn.id) === sourcePathEntryId ||
        `legacy-path:${turn.id}` === sourcePathEntryId || turn.pathEntryId === sourcePathEntryId);
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
      if (invalidationsDropped) return;
      const keys = [...new Set(invalidations.flatMap(nativeInvalidationKeys))];
      if (keys.length === 0) return;
      dispatch({
        type: 'remux/event',
        message: {
          jsonrpc: '2.0', method: 'remux/agent/resources/invalidated',
          params: {
            protocolVersion: nativeProtocolVersion,
            serverGeneration: generation,
            basisSequence: sequence,
            keys,
          },
        },
      });
    }

    function nativeInvalidationKeys(invalidation: any): string[] {
      if (invalidation.type === 'transcript') {
        const targetConversationId = String(invalidation.conversationId ?? conversationId);
        return [
          `agent/transcript:${targetConversationId}:tail-24`,
          `agent/execution:${encodeURIComponent(`root:${targetConversationId}`)}`,
          ...(invalidation.turnId ? [`agent/turn:${String(invalidation.turnId)}`] : []),
        ];
      }
      if (invalidation.type === 'executionScope') {
        if (!invalidation.turnId) return [];
        const targetConversationId = String(invalidation.conversationId ?? conversationId);
        const scopeId = String(invalidation.scopeId ?? '');
        const scope = executionScopes.get(executionScopeKey(String(invalidation.turnId), scopeId));
        return [
          `agent/transcript:${targetConversationId}:tail-24`,
          `agent/turn:${String(invalidation.turnId)}`,
          ...(scope?.kind === 'childExecution' ? [
            `agent/execution:${encodeURIComponent(scopeId)}`,
            `agent/execution-transcript:${encodeURIComponent(scopeId)}:tail-24`,
            `agent/execution:${encodeURIComponent(`root:${targetConversationId}`)}`,
          ] : []),
        ];
      }
      const key = String(invalidation.key ?? '');
      if (key === 'auth') return ['agent/providers', `agent/models:${providerInstanceId}`];
      if (key === 'models') return [`agent/models:${providerInstanceId}`];
      if (key === 'conversation-list') return ['agent/conversations'];
      if (key === 'runtime') return [`agent/runtime:${activeFixtureConversationId()}`];
      if (key.startsWith('conversation-versions:')) {
        return [`agent/conversation-versions:${key.slice('conversation-versions:'.length)}`];
      }
      if (key.startsWith('conversation:')) return [`agent/conversation:${key.slice('conversation:'.length)}`];
      if (key.startsWith('queue:')) return [`agent/queue:${key.slice('queue:'.length)}`];
      return [];
    }

    function activeFixtureConversationId() {
      return String(resources.get('runtime')?.value.conversationId ?? conversationId);
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

    function createRunningTurn(text: string, clientMessageId: string, parts?: any[], queuedTurnId?: string) {
      turnCounter += 1;
      const id = queuedTurnId ?? `fixture-turn-${turnCounter}`;
      const workId = `${id}:work`;
      const scopeId = `root:${conversationId}:codex-child-${String(turnCounter).padStart(4, '0')}`;
      const rootScopeId = `10000000-0000-4000-8000-${String(turnCounter).padStart(12, '0')}`;
      const startedAt = Date.now();
      const reasoningParts = tallRunningWork
        ? Array.from(
            { length: 36 },
            (_, index) => `**Reviewing expanded work item ${index + 1}.**`,
          )
        : ['**Checking context.**', '**Reviewing workspace state.**'];
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
            operationCount: 3, childExecutionCount: 1,
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
          blocks: [
            {
              id: `${id}:reasoning`, type: 'reasoning', state: 'final',
              revision: 'reasoning:1',
              text: reasoningParts.join('\n'),
              parts: reasoningParts,
            },
            {
              id: `${id}:commentary`, type: 'commentary', state: 'final',
              revision: 'commentary:1', text: 'Grounding the change in the current workspace.',
            },
            {
              id: `${id}:action:readme`, type: 'action', state: 'completed', revision: 'operation:readme:1',
              call: {
                id: `${id}:operation:readme`, callId: `${id}:readme`, name: 'workspace.read',
                presentation: { category: 'read', label: 'Read README.md', subject: 'README.md' },
                status: 'completed', revision: 'operation:readme:1',
                detailPreview: 'Read the workspace overview before editing.',
                outputPreview: '# Remux\n\nFixture file output.', durationMs: 42,
                childScopeId: null, childBoundary: null, childState: null,
                childDurationMs: null, childOperationCount: 0,
                childArtifactCount: 0, hasDetail: true,
              },
            },
            {
              id: `${id}:action:edit`, type: 'action', state: 'completed', revision: 'operation:edit:1',
              call: {
                id: `${id}:operation:edit`, callId: `${id}:edit`, name: 'workspace.edit',
                presentation: { category: 'edit', label: 'Edited index.ts', subject: 'src/index.ts' },
                status: 'completed', revision: 'operation:edit:1',
                detailPreview: 'src/index.ts', outputPreview: '+export const value = 1;',
                durationMs: 34, childScopeId: null, childBoundary: null,
                childState: null, childDurationMs: null, childOperationCount: 0,
                childArtifactCount: 0, hasDetail: true, diffArtifactId: diffArtifactHash,
              },
            },
            {
              id: `${id}:action:child-agent`, type: 'action', state: 'running', revision: 'operation:child-agent:1',
              call: {
                id: `${id}:operation:child-agent`, callId: `${id}:child-agent`, name: 'native_subagent',
                presentation: { category: 'tool', label: 'Work Unit Start', subject: null },
                status: 'running', revision: 'operation:child-agent:1',
                detailPreview: 'Verify the focused seam', outputPreview: null, durationMs: null,
                childScopeId: scopeId,
                childBoundary: 'Verify the focused seam and close when its exact contract agrees.',
                childState: 'running', childDurationMs: null, childOperationCount: 1,
                childArtifactCount: 0, hasDetail: true,
              },
            },
          ],
        }],
        window: { startIndex: 0, endIndexExclusive: 1, hasEarlier: false, hasLater: false },
        result: null, artifacts: [],
      });
      executionScopes.set(executionScopeKey(id, scopeId), {
        conversationId, turnId: id, scopeId, parentScopeId: rootScopeId,
        parentOperationId: `${id}:operation:child-agent`, kind: 'childExecution', state: 'running',
        revision: 'child:1', basisSequence: sequence, startedAt, completedAt: null,
        durationMs: null,
        boundary: 'Verify the focused seam against its governing compatibility contract and close when the exact contract and implementation agree.',
        inferenceOrder: [`${id}:inference:child`],
        inferences: [{
          id: `${id}:inference:child`, ordinal: 0, state: 'completed', revision: 'inference:child:1',
          startedAt: startedAt + 90, completedAt: startedAt + 180, durationMs: 90,
          blocks: [{
            id: `${id}:child-reasoning`, type: 'reasoning', state: 'final',
            revision: 'child-reasoning:1', text: 'Compared the implementation with its contract.',
          }, {
            id: `${id}:child-action:test`, type: 'action', state: 'completed', revision: 'operation:test:1',
            call: {
              id: `${id}:operation:test`, callId: `${id}:test`, name: 'bash',
              presentation: { category: 'command', label: 'Shell command', subject: 'npm test -- seam' },
              status: 'completed', revision: 'operation:test:1',
              detailPreview: 'npm test -- seam', outputPreview: '1 test passed', durationMs: 120,
              childScopeId: null, childBoundary: null,
              childState: null, childDurationMs: null, childOperationCount: 0,
              childArtifactCount: 0, hasDetail: true,
            },
          }],
        }],
        window: { startIndex: 0, endIndexExclusive: 1, hasEarlier: false, hasLater: false },
        result: null, artifacts: [],
      });
      const queuedIndex = turns.findIndex((candidate) => candidate.id === id);
      if (queuedIndex >= 0) turns.splice(queuedIndex, 1, turn);
      else turns.push(turn);
      touchTurn(turn);
      return turn;
    }

    function storedFixtureParts(parts: any[]) {
      return parts.map((part) => {
        if (part.type !== 'image') return part;
        if (part.artifactHash) return part;
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

    function legacyPartsFromNative(content: any[]) {
      return content.map((part) => {
        if (part.type === 'file-reference') {
          const path = String(part.path);
          return {
            type: 'mention', kind: 'file', path,
            name: path.split(/[\\/]/u).filter(Boolean).at(-1) ?? path,
          };
        }
        if (part.type === 'image-artifact') {
          return {
            type: 'image', artifactHash: String(part.artifactId),
            mimeType: String(part.mimeType), name: String(part.name ?? 'Image'),
            sizeBytes: Number(part.byteLength ?? artifactBytes.get(String(part.artifactId))?.bytes.byteLength ?? 0),
          };
        }
        return { type: 'text', text: String(part.text ?? '') };
      });
    }

    function nativeContentText(content: any[]) {
      return content.flatMap((part) => part.type === 'text' ? [String(part.text)] : []).join('');
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
        const workBlock = rootScope?.inferences[0]?.blocks
          .find((block: any) => block.type === 'action' && block.call.childScopeId);
        const workCall = workBlock?.call;
        if (rootScope) {
          rootScope.revision = `root:${sequence + 1}`;
          rootScope.basisSequence = sequence + 1;
          rootScope.state = outcome;
          rootScope.completedAt = turn.completedAt;
          rootScope.durationMs = turn.durationMs;
          if (workCall) {
            workCall.status = outcome === 'completed' ? 'completed' : 'interrupted';
            workCall.durationMs = turn.durationMs;
            workCall.revision = `operation:child-agent:${sequence + 1}`;
            workCall.childState = outcome === 'completed' ? 'completed' : 'abandoned';
            workCall.childDurationMs = turn.durationMs;
            workCall.childArtifactCount = outcome === 'completed' ? 1 : 0;
          }
          if (workBlock) workBlock.state = workCall.status;
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
        const childScopeId = rootScope?.inferences[0]?.blocks
          .find((block: any) => block.type === 'action' && block.call.childScopeId)?.call.childScopeId;
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
          state: 'queued',
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

    function startFixtureMessage(params: {
      clientMessageId: string;
      modelId: string;
      operationId?: string;
      parts?: any[];
      reasoning: string | null;
      text: string;
    }) {
      const turn = createRunningTurn(
        String(params.text),
        String(params.clientMessageId),
        params.parts,
        params.operationId,
      );
      nativeModelId = params.modelId;
      nativeReasoning = params.reasoning;
      window.sessionStorage.setItem('remux.agent.fixture.native-config', JSON.stringify({
        modelId: nativeModelId,
        reasoning: nativeReasoning,
      }));
      updateResource(conversationKey, (summary) => {
        summary.status = 'running';
        summary.title = String(params.text);
        summary.preview = String(params.text);
        summary.latestTurnId = turn.id;
        summary.modelId = params.modelId;
        summary.reasoning = params.reasoning;
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
        protocolVersion: transcriptProtocolVersion,
        projectionVersion: transcriptProjectionVersion,
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
              .flatMap((inference: any) => inference.blocks
                .filter((block: any) => block.type === 'action')
                .map((block: any) => block.call))
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

    function fixtureCapabilities() {
      return {
        provider: 'fixture',
        providerVersion: 'viewer-fixture-1',
        adapterVersion: 'provider-runtime-v1',
        authentication: { login: 'device-code', logout: true },
        session: {
          create: true, resume: true, discoverHistory: false, readSnapshot: true,
          forkNative: true, rollbackNative: true,
        },
        turns: {
          interrupt: true, steer: false, queue: true,
          changeModelOnExistingSession: true, changeEffortOnExistingSession: true,
        },
        content: {
          images: true, fileReferences: true, reasoning: true, diffs: true,
          webActivity: true,
        },
        collaboration: {
          nativeSubagents: true, childTranscript: 'summary',
          childSteer: false, childInterrupt: true,
        },
        access: {
          presets: ['read-only', 'workspace-write', 'full-access'],
          defaultPreset: 'workspace-write',
        },
        usage: {
          turn: true, cumulative: true, context: 'provider',
          plan: 'read-and-push', estimatedCost: false,
        },
        compaction: { automaticNative: true, manualNative: true },
      };
    }

    function nativeProvidersValue() {
      const auth = resources.get('auth')!.value;
      const loginOperation = auth.operationId ? {
        operationId: String(auth.operationId),
        mode: 'device-code',
        state: auth.state === 'signing-in' ? 'waiting' : auth.state === 'signed-in' ? 'completed' : 'failed',
        ...(auth.verificationUri ? { verificationUri: String(auth.verificationUri) } : {}),
        ...(auth.userCode ? { userCode: String(auth.userCode) } : {}),
        ...(auth.error ? { error: String(auth.error) } : {}),
        startedAt: Date.now() - 1_000,
        ...(auth.state === 'signing-in' ? {} : { completedAt: Date.now() }),
      } : undefined;
      return {
        providers: [{
          providerInstanceId,
          provider: 'fixture',
          label: auth.displayLabel ?? 'Fixture subscription',
          state: auth.state === 'signed-in' ? 'ready' : auth.state === 'signed-out' || auth.state === 'signing-in'
            ? 'signed-out' : 'error',
          ...(auth.error ? { message: String(auth.error) } : {}),
          capabilityRevision,
          capabilities: fixtureCapabilities(),
          ...(loginOperation ? { loginOperation } : {}),
          ...(auth.state === 'signed-in' ? {
            stickyPreference: {
              model: nativeModelId,
              effort: nativeReasoning,
              serviceTier: nativeServiceTier,
            },
          } : {}),
          accountUsage: {
            availability: 'available',
            windows: [
              { id: 'fixture:primary', label: '5 hours', kind: 'rolling', model: null, usedPercent: fiveHourUsagePercent, resetsAt: usageObservedAt + 3_600_000 },
              { id: 'fixture:secondary', label: 'Weekly', kind: 'weekly', model: null, usedPercent: weeklyUsagePercent, resetsAt: usageObservedAt + 86_400_000 },
            ],
            source: 'provider-push', freshness: 'live', observedAt: usageObservedAt,
          },
        }],
        defaultProviderInstanceId: providerInstanceId,
        preferenceRevision,
      };
    }

    function nativeModelsValue() {
      const models = resources.get('models')!.value;
      return {
        providerInstanceId,
        defaultModelId: models.defaultModelId,
        error: models.error,
        models: models.models.map((model: any) => ({
          id: model.id,
          name: model.name,
          provider: 'fixture',
          supportedEffort: model.supportedReasoning,
          serviceTiers: model.serviceTiers ?? [],
          defaultServiceTier: model.defaultServiceTier ?? null,
          contextWindow: model.contextWindow,
          isDefault: model.id === models.defaultModelId,
        })),
      };
    }

    function nativeConversationValue(summary: any, includeDetail = false) {
      const targetConversationId = String(summary.id);
      const targetTurns = turnsByConversation.get(targetConversationId) ?? [];
      const activeTurnId = resources.get('runtime')?.value.conversationId === targetConversationId
        ? resources.get('runtime')?.value.activeTurnId ?? null
        : null;
      const state = summary.status === 'running' ? 'running' : summary.status === 'error' ? 'failed' : 'idle';
      const childCount = conversationSummaries().filter((candidate) =>
        candidate.parentConversationId === targetConversationId && candidate.archivedAt === null).length;
      const value: any = {
        conversationId: targetConversationId,
        provider: 'fixture',
        providerInstanceId,
        title: String(summary.title ?? ''),
        preview: String(summary.preview ?? ''),
        cwd: String(summary.cwd ?? '/tmp/remux-fixture'),
        model: String(summary.modelId ?? 'gpt-5.6-sol'),
        effort: String(summary.reasoning ?? 'high'),
        serviceTier: String(summary.serviceTier ?? nativeServiceTier),
        access: String(summary.access ?? 'workspace-write'),
        state,
        rootExecutionId: `root:${targetConversationId}`,
        parentConversationId: summary.parentConversationId ?? null,
        rootConversationId: String(summary.rootConversationId ?? targetConversationId),
        forkedFromPathEntryId: summary.forkedFromPathEntryId ?? null,
        activeStrandId: String(summary.activeStrandId ?? `fixture-strand:${targetConversationId}:initial`),
        headRevision: Number(summary.headRevision ?? 1),
        versionCount: Number(summary.versionCount ?? 1),
        childCount,
        subtreeUpdatedAt: Number(summary.subtreeUpdatedAt ?? summary.updatedAt ?? Date.now()),
        archivedAt: summary.archivedAt ?? null,
        metadataRevision: Number(summary.metadataRevision ?? 1),
        lastUsedModel: targetTurns.length > 0
          ? String(summary.lastUsedModel ?? summary.modelId ?? nativeModelId)
          : null,
        lastActivityAt: Number(summary.lastActivityAt ?? summary.updatedAt ?? Date.now()),
        activeTurnId,
        history: historyState === 'failed'
          ? { state: 'failed', error: 'Fixture history read failed.' }
          : { state: 'ready' },
        resumable: compactEligibility !== 'unresumable',
        createdAt: Number(summary.createdAt ?? Date.now()),
        updatedAt: Number(summary.updatedAt ?? Date.now()),
      };
      if (includeDetail) {
        value.capabilityRevision = capabilityRevision;
        value.latestTurnId = summary.latestTurnId ?? targetTurns.at(-1)?.id ?? null;
        value.turnCount = targetTurns.length;
      }
      return value;
    }

    function nativeRuntimeValue(targetConversationId: string) {
      const summary = resources.get(`conversation:${targetConversationId}`)?.value;
      if (!summary) return undefined;
      const targetTurns = turnsByConversation.get(targetConversationId) ?? [];
      const activeRuntime = resources.get('runtime')?.value;
      const active = activeRuntime?.conversationId === targetConversationId;
      const activeTurnId = active ? activeRuntime.activeTurnId ?? null : null;
      const activeTurn = activeTurnId
        ? targetTurns.find((turn) => turn.id === activeTurnId)
        : undefined;
      const state = active
        ? activeRuntime.state === 'running' || activeRuntime.state === 'interrupting' ? 'running'
          : activeRuntime.state === 'error' ? 'failed' : 'idle'
        : summary.status === 'running' ? 'running' : summary.status === 'error' ? 'failed' : 'idle';
      const childStates = targetTurns.flatMap((turn) => fixtureChildCalls(turn))
        .map(({ call, scope }) => nativeExecutionState(scope.state ?? call.childState));
      const runningCount = childStates.filter((childState) => childState === 'running').length;
      const lifecycle = lifecycleByConversation.get(targetConversationId) ?? {
        state: runningCount > 0 ? 'running' : 'idle',
        runningCount,
        checkingCount: 0,
        stoppingCount: 0,
        stopErrorCount: 0,
        stopRequested: false,
      };
      return {
        conversationId: targetConversationId,
        executionId: `root:${targetConversationId}`,
        state,
        activeTurnId,
        activeTurnElapsedMs: activeTurn
          ? Math.max(0, Date.now() - activeTurn.startedAt)
          : null,
        lifecycle,
        history: historyState === 'failed'
          ? { state: 'failed', error: 'Fixture history read failed.' }
          : { state: 'ready' },
        provider: 'fixture',
        providerInstanceId,
        activeConfiguration: {
          model: String(summary.modelId ?? 'gpt-5.6-sol'),
          effort: String(summary.reasoning ?? 'high'),
          serviceTier: String(summary.serviceTier ?? nativeServiceTier),
          access: String(summary.access ?? 'workspace-write'),
        },
        composer: {
          revision: `${capabilityRevision}:${resources.get('runtime')?.revision ?? 0}:${targetConversationId}`,
          providerInstanceId,
          nextTurn: {
            model: String(summary.modelId ?? 'gpt-5.6-sol'),
            ...(currentEffortNull ? {} : { effort: String(summary.reasoning ?? 'high') }),
            serviceTier: String(summary.serviceTier ?? nativeServiceTier),
            access: String(summary.access ?? 'workspace-write'),
            origin: 'last-used',
          },
          lastUsed: null,
          editable: { model: true, effort: true, serviceTier: true, access: true },
        },
        capabilities: fixtureCapabilities(),
        usage: {
          turn: null,
          cumulative: null,
          context: {
            usedTokens: contextUsedTokens, windowTokens: 100_000, percent: contextUsedTokens / 1_000,
            ...(route.has('fixtureAutoCompactWindow') ? { autoCompactWindowTokens: 80_000 } : {}),
            measurement: 'provider', freshness: 'live', observedAt: usageObservedAt, turnId: null,
          },
          estimatedCost: null,
        },
        compaction: {
          policy: 'native-auto',
          operation: compactEligibility === 'running'
            ? { state: 'running', operationId: 'fixture-compact', startedAt: Date.now(), lastResult: null }
            : { state: 'idle', lastResult: null },
        },
        ...(activeRuntime?.error ? { healthMessage: String(activeRuntime.error) } : {}),
      };
    }

    function nativeQueueValue(targetConversationId: string) {
      if (!resources.has(`conversation:${targetConversationId}`)) return undefined;
      const queue = resources.get(`queue:${targetConversationId}`)?.value;
      return {
        conversationId: targetConversationId,
        entries: compactEligibility === 'queued' ? [{
          kind: 'compact', commandId: 'queued-compact', operationId: 'queued-compact', createdAt: Date.now(),
        }] : (queue?.entries ?? []).map((entry: any) => ({
          kind: 'message',
          commandId: String(entry.id),
          turnId: String(entry.id),
          content: [
            { type: 'text', text: String(entry.text ?? '') },
            ...Array.from({ length: Number(entry.attachmentCount ?? 0) }, (_, index) => ({
              type: 'image-artifact', artifactId: `${pickedImageHash}-${index}`,
              mimeType: 'image/png', name: 'Image', byteLength: pickedImageBytes.byteLength,
            })),
            ...Array.from({ length: Number(entry.mentionCount ?? 0) }, (_, index) => ({
              type: 'file-reference', path: `fixture-${index}.ts`,
            })),
          ],
          model: 'gpt-5.6-sol',
          effort: 'high',
          access: 'workspace-write',
          state: entry.state ?? 'queued',
          createdAt: Number(entry.createdAt ?? Date.now()),
        })),
      };
    }

    function nativeTranscriptValue(
      targetConversationId: string,
      windowSpec: string,
      explicitTurns?: Turn[],
      explicitStrandId?: string,
    ) {
      const targetTurns = explicitTurns ?? turnsByConversation.get(targetConversationId);
      if (!targetTurns || !resources.has(`conversation:${targetConversationId}`)) return undefined;
      const range = nativeTranscriptRange(targetTurns, windowSpec);
      const selected = targetTurns.slice(range.startIndex, range.endIndexExclusive);
      const runtime = resources.get('runtime')?.value;
      return {
        conversationId: targetConversationId,
        strandId: explicitStrandId ?? String(
          resources.get(`conversation:${targetConversationId}`)?.value.activeStrandId ??
          `fixture-strand:${targetConversationId}:initial`
        ),
        executionId: `root:${targetConversationId}`,
        activeTurnId: explicitStrandId === undefined && runtime?.conversationId === targetConversationId
          ? runtime.activeTurnId ?? null
          : null,
        turnOrder: targetTurns.map((turn) => turn.id),
        turns: selected.map((turn) => nativeTurnValue(
          turn,
          targetConversationId,
          targetTurns.indexOf(turn),
        )),
        window: {
          ...range,
          hasEarlier: range.startIndex > 0,
          hasLater: range.endIndexExclusive < targetTurns.length,
        },
      };
    }

    function nativeTranscriptRange(targetTurns: Turn[], windowSpec: string) {
      const length = targetTurns.length;
      const tail = /^tail-(\d+)$/u.exec(windowSpec);
      if (tail) {
        const count = Math.min(40, Math.max(1, Number(tail[1])));
        return { startIndex: Math.max(0, length - count), endIndexExclusive: length };
      }
      const around = /^around:([^:]+):(\d+):(\d+)$/u.exec(windowSpec);
      if (around) {
        const index = targetTurns.findIndex((turn) => turn.id === around[1]);
        if (index >= 0) {
          const before = Math.min(39, Number(around[2]));
          const after = Math.min(39, Number(around[3]));
          const startIndex = Math.max(0, index - before);
          return { startIndex, endIndexExclusive: Math.min(length, startIndex + Math.min(40, before + after + 1)) };
        }
      }
      const range = /^range:([^:]+):([^:]+)$/u.exec(windowSpec);
      if (range) {
        const first = targetTurns.findIndex((turn) => turn.id === range[1]);
        const last = targetTurns.findIndex((turn) => turn.id === range[2]);
        if (first >= 0 && last >= first) return { startIndex: first, endIndexExclusive: Math.min(last + 1, first + 40) };
      }
      return { startIndex: Math.max(0, length - 24), endIndexExclusive: length };
    }

    function nativeTurnValue(
      turn: Turn,
      targetConversationId = conversationId,
      targetOrdinal = (turnsByConversation.get(targetConversationId) ?? []).indexOf(turn),
    ) {
      const user = turn.segments.find((segment) => segment.type === 'userMessage');
      const assistant = turn.segments.find((segment) => segment.type === 'assistantMessage');
      const work = turn.segments.find((segment) => segment.type === 'work');
      const scope = work ? executionScopes.get(executionScopeKey(turn.id, work.scopeId)) : null;
      const inferences = scope?.inferences ?? [];
      const blocks = inferences.flatMap((inference: any) => inference.blocks ?? []);
      const calls = blocks.filter((block: any) => block.type === 'action').map((block: any) => block.call);
      const reasoning = blocks.filter((block: any) => block.type === 'reasoning')
        .map((block: any) => block.text).join('\n\n');
      const commentary = blocks.filter((block: any) => block.type === 'commentary')
        .map((block: any) => block.text).join('\n\n');
      const operations = calls.filter((call: any) => !call.childScopeId).map((call: any) => ({
        eventId: String(call.id),
        tool: {
          callId: String(call.callId ?? call.id),
          name: String(call.name ?? 'tool'),
          category: nativeToolCategory(call.presentation?.category),
          ...(call.presentation?.label ? { title: String(call.presentation.label) } : {}),
        },
        state: call.status === 'failed' ? 'failed' : call.status === 'completed' ? 'completed' : 'running',
        ...(call.detailPreview === null || call.detailPreview === undefined ? {} : { inputPreview: String(call.detailPreview) }),
        ...(call.outputPreview === null || call.outputPreview === undefined ? {} : { outputPreview: String(call.outputPreview) }),
        startedAt: turn.startedAt,
        ...(call.durationMs === null || call.durationMs === undefined ? {} : { completedAt: turn.startedAt + Number(call.durationMs) }),
      }));
      const fileChanges = diffTranscript ? calls.flatMap((call: any) => call.diffArtifactId ? [{
        path: String(call.presentation?.subject ?? call.detailPreview ?? 'changed-file'),
        kind: 'update',
        blockId: String(call.callId ?? call.id),
        diffArtifactId: String(call.diffArtifactId),
      }] : []) : [];
      const children = calls.flatMap((call: any) => {
        if (!call.childScopeId) return [];
        const child = executionScopes.get(executionScopeKey(turn.id, call.childScopeId));
        return [{
          executionId: String(call.childScopeId),
          ownership: 'native',
          provider: 'fixture',
          providerInstanceId,
          title: 'Native subagent',
          state: nativeExecutionState(child?.state ?? call.childState),
          ...(child?.result || call.childBoundary ? { summary: String(child?.result ?? call.childBoundary) } : {}),
        }];
      });
      const nativePasses = inferences.map((inference: any, passOrdinal: number) => ({
        passId: String(inference.id),
        ordinal: passOrdinal,
        state: inference.state === 'running' ? 'streaming' : 'completed',
        blocks: (inference.blocks ?? []).map((block: any, blockOrdinal: number) =>
          nativeBlockValue(turn, inference, block, blockOrdinal)),
      }));
      const assistantText = String(assistant?.text ?? '');
      const userIndex = turn.segments.indexOf(user);
      const compactionValue = (segment: any) => ({
        operationId: String(segment.id).replace(/^compaction:/u, ''),
        trigger: segment.trigger,
        state: segment.status === 'compacting'
          ? 'started'
          : segment.status === 'failed' ? 'failed' : 'completed',
        beforeTokens: segment.beforeTokens ?? null,
        afterTokens: segment.afterTokens ?? null,
        ...(segment.error ? { error: { code: 'fixture_compaction_failed', message: String(segment.error) } } : {}),
        createdAt: turn.startedAt,
        ...(segment.status === 'compacting' || turn.completedAt === null
          ? {}
          : { completedAt: turn.completedAt }),
      });
      const beforeUserCompactions = turn.segments.slice(0, Math.max(0, userIndex))
        .filter((segment) => segment.type === 'compaction').map(compactionValue);
      const afterTurnCompactions = turn.segments.slice(Math.max(0, userIndex + 1))
        .filter((segment) => segment.type === 'compaction').map(compactionValue);
      const finalBlockId = assistantText ? `final:${turn.id}` : null;
      if (finalBlockId) {
        const target = nativePasses.at(-1) ?? {
          passId: `final-pass:${turn.id}`, ordinal: 0, state: 'completed', blocks: [],
        };
        if (nativePasses.length === 0) nativePasses.push(target);
        target.blocks.push({
          blockId: finalBlockId,
          passId: target.passId,
          ordinal: target.blocks.length,
          kind: 'final-message',
          state: turn.status === 'inProgress' ? 'streaming' : 'completed',
          revision: 1,
          payload: { kind: 'final-message', text: assistantText },
          startedAt: turn.startedAt,
          completedAt: turn.completedAt,
        });
      }
      const state = turn.status === 'inProgress' ? 'running' : turn.status;
      return {
        turnId: turn.id,
        pathEntryId: turn.pathEntryId ?? fixturePathEntryId(targetConversationId, turn.id),
        strandId: turn.strandId ?? String(
          resources.get(`conversation:${targetConversationId}`)?.value.activeStrandId ??
          `fixture-strand:${targetConversationId}:initial`
        ),
        ordinal: turn.ordinal ?? Math.max(0, targetOrdinal),
        clientMessageId: String(user?.clientMessageId ?? `fixture-client:${turn.id}`),
        executionId: String(work?.scopeId ?? `root:${turn.id}`),
        state,
        ...(turn.status === 'inProgress' || turn.status === 'queued' ? {} : { outcome: turn.status }),
        userContent: nativeUserContent(user),
        ordering: 'native-exact',
        passes: nativePasses,
        finalBlockId,
        ...(beforeUserCompactions.length > 0 || afterTurnCompactions.length > 0 ? {
          boundaryCompactions: {
            beforeUser: beforeUserCompactions,
            afterTurn: afterTurnCompactions,
          },
        } : {}),
        activity: {
          reasoning,
          commentary,
          operations,
          fileChanges,
          web: [],
          children,
          notices: [],
          compacted: false,
        },
        assistantText,
        ...(assistant?.content ? {
          assistantContent: {
            artifactId: String(assistant.content.artifactHash),
            sha256: String(assistant.content.sha256),
            byteLength: Number(assistant.content.byteLength),
            returnedBytes: Number(assistant.content.returnedBytes),
            nextOffset: assistant.content.nextRange?.offset ?? null,
          },
        } : {}),
        ...(turn.error ? { error: { code: turn.error.code, message: turn.error.message } } : {}),
        startedAt: turn.startedAt,
        ...(turn.completedAt === null ? {} : { completedAt: turn.completedAt }),
        renderRevision: turn.renderRevision,
        layoutRevision: turn.layoutRevision,
      };
    }

    function nativeBlockValue(turn: Turn, inference: any, block: any, ordinal: number) {
      const base = {
        blockId: String(block.id),
        passId: String(inference.id),
        ordinal,
        state: block.state === 'final' ? 'completed' : block.state,
        revision: 1,
        startedAt: turn.startedAt,
        completedAt: block.state === 'streaming' || block.state === 'running'
          ? null
          : turn.completedAt,
      };
      if (block.type === 'reasoning' || block.type === 'commentary' || block.type === 'assistantText') {
        const kind = block.type === 'reasoning'
          ? 'reasoning-summary'
          : block.type === 'commentary' ? 'commentary' : 'final-message';
        return {
          ...base,
          kind,
          payload: {
            kind,
            text: String(block.text),
            ...(kind === 'reasoning-summary' && Array.isArray(block.parts)
              ? { parts: block.parts.map(String) }
              : {}),
          },
        };
      }
      if (block.type === 'notice') {
        return {
          ...base, kind: 'compatibility-notice',
          payload: { kind: 'compatibility-notice', code: 'fixture_notice', message: String(block.text) },
        };
      }
      const call = block.call;
      if (call.childScopeId) {
        return {
          ...base,
          kind: 'native-child',
          payload: {
            kind: 'native-child',
            child: {
              executionId: String(call.childScopeId), ownership: 'native', provider: 'fixture',
              providerInstanceId, title: 'Native subagent',
            },
            executionState: nativeExecutionState(call.childState ?? call.status),
            ...(call.outputPreview || call.childBoundary
              ? { summary: String(call.outputPreview ?? call.childBoundary) }
              : {}),
          },
        };
      }
      return {
        ...base,
        kind: 'tool',
        payload: {
          kind: 'tool',
          tool: {
            callId: String(call.callId ?? call.id),
            name: String(call.name ?? 'tool'),
            category: nativeToolCategory(call.presentation?.category),
            ...(call.presentation?.label ? { title: String(call.presentation.label) } : {}),
          },
          ...(call.detailPreview === null || call.detailPreview === undefined
            ? {}
            : { inputPreview: String(call.detailPreview) }),
          ...(call.outputPreview === null || call.outputPreview === undefined
            ? {}
            : { outputPreview: String(call.outputPreview) }),
        },
      };
    }

    function nativeUserContent(user: any) {
      if (!user) return [{ type: 'text', text: '' }];
      if (!Array.isArray(user.parts) || user.parts.length === 0) return [{ type: 'text', text: String(user.text ?? '') }];
      return user.parts.map((part: any) => {
        if (part.type === 'mention') return { type: 'file-reference', path: String(part.path) };
        if (part.type === 'image') return {
          type: 'image-artifact', artifactId: String(part.artifactHash),
          mimeType: String(part.mimeType), name: String(part.name ?? 'Image'),
          byteLength: Number(part.sizeBytes ?? 0),
        };
        return { type: 'text', text: String(part.text ?? '') };
      });
    }

    function nativeToolCategory(category: unknown) {
      if (category === 'command') return 'shell';
      if (category === 'read' || category === 'edit') return 'file';
      if (category === 'search') return 'search';
      return 'collaboration';
    }

    function nativeExecutionState(state: unknown) {
      if (state === 'completed') return 'idle';
      if (state === 'failed') return 'failed';
      if (state === 'interrupted' || state === 'abandoned') return 'interrupted';
      return 'running';
    }

    function nativeResourceValue(key: string): { revision: number; value: any } | undefined {
      if (key === 'agent/providers') return { revision: resources.get('auth')!.revision, value: nativeProvidersValue() };
      if (key === `agent/models:${providerInstanceId}`) {
        return { revision: resources.get('models')!.revision, value: nativeModelsValue() };
      }
      if (key === 'agent/conversations') {
        return {
          revision: resources.get('conversation-list')!.revision,
          value: { conversations: conversationSummaries().map((summary) => nativeConversationValue(summary)), truncated: false },
        };
      }
      if (key.startsWith('agent/conversation-versions:')) {
        const targetConversationId = key.slice('agent/conversation-versions:'.length);
        const summary = resources.get(`conversation:${targetConversationId}`)?.value;
        if (!summary) return undefined;
        const versions = ensureConversationVersions(targetConversationId);
        const activeStrandId = String(summary.activeStrandId);
        const active = versions.find((version) => version.strandId === activeStrandId);
        if (active) active.turns = structuredClone(turnsByConversation.get(targetConversationId) ?? []);
        return {
          revision: Number(summary.headRevision ?? 1),
          value: {
            conversationId: targetConversationId,
            headRevision: Number(summary.headRevision ?? 1),
            versions: [...versions].reverse().map((version) => {
              const last = version.turns.at(-1);
              const user = last?.segments.find((segment) => segment.type === 'userMessage');
              return {
                strandId: version.strandId,
                active: version.strandId === activeStrandId,
                reason: version.reason,
                sourceStrandId: version.sourceStrandId,
                sourcePathEntryId: version.sourcePathEntryId,
                turnCount: version.turns.length,
                preview: String(user?.text ?? ''),
                createdAt: version.createdAt,
              };
            }),
          },
        };
      }
      if (key.startsWith('agent/conversation:')) {
        const targetConversationId = key.slice('agent/conversation:'.length);
        const entry = resources.get(`conversation:${targetConversationId}`);
        return entry ? { revision: entry.revision, value: nativeConversationValue(entry.value, true) } : undefined;
      }
      if (key.startsWith('agent/runtime:')) {
        const targetConversationId = key.slice('agent/runtime:'.length);
        const value = nativeRuntimeValue(targetConversationId);
        return value ? { revision: resources.get('runtime')!.revision, value } : undefined;
      }
      if (key.startsWith('agent/queue:')) {
        const targetConversationId = key.slice('agent/queue:'.length);
        const value = nativeQueueValue(targetConversationId);
        const revision = resources.get(`queue:${targetConversationId}`)?.revision ?? 0;
        return value ? { revision, value } : undefined;
      }
      if (key.startsWith('agent/execution:')) {
        const executionId = decodeURIComponent(key.slice('agent/execution:'.length));
        const value = nativeExecutionValue(executionId);
        return value ? { revision: sequence, value } : undefined;
      }
      const executionTranscript = /^agent\/execution-transcript:([^:]+):(.+)$/u.exec(key);
      if (executionTranscript) {
        const value = nativeChildTranscriptValue(
          decodeURIComponent(executionTranscript[1]!),
          executionTranscript[2]!,
        );
        return value ? { revision: sequence, value } : undefined;
      }
      const strandTranscript = /^agent\/strand-transcript:([^:]+):([^:]+):(.+)$/u.exec(key);
      if (strandTranscript) {
        const targetConversationId = decodeURIComponent(strandTranscript[1]!);
        const strandId = decodeURIComponent(strandTranscript[2]!);
        const version = ensureConversationVersions(targetConversationId)
          .find((candidate) => candidate.strandId === strandId);
        if (!version) return undefined;
        const value = nativeTranscriptValue(
          targetConversationId,
          strandTranscript[3]!,
          version.turns,
          strandId,
        );
        return value ? { revision: sequence, value } : undefined;
      }
      const transcript = /^agent\/transcript:([^:]+):(.+)$/u.exec(key);
      if (transcript) {
        const value = nativeTranscriptValue(transcript[1]!, transcript[2]!);
        return value ? { revision: sequence, value } : undefined;
      }
      if (key.startsWith('agent/turn:')) {
        const turnId = key.slice('agent/turn:'.length).replace(/:summary$/u, '');
        for (const targetTurns of turnsByConversation.values()) {
          const turn = targetTurns.find((candidate) => candidate.id === turnId);
          if (turn) return { revision: sequence, value: nativeTurnValue(turn) };
        }
      }
      return undefined;
    }

    function nativeExecutionValue(executionId: string) {
      if (executionId.startsWith('root:')) {
        const targetConversationId = executionId.slice('root:'.length);
        const summary = resources.get(`conversation:${targetConversationId}`)?.value;
        if (summary) {
          const targetTurns = turnsByConversation.get(targetConversationId) ?? [];
          const childExecutionIds = targetTurns.flatMap((turn) => fixtureChildCalls(turn)
            .map(({ call }) => String(call.childScopeId)));
          const runtime = nativeRuntimeValue(targetConversationId);
          return {
            executionId,
            conversationId: targetConversationId,
            parentExecutionId: null,
            rootTurnId: null,
            ownership: 'root',
            provider: 'fixture',
            providerInstanceId,
            model: String(summary.modelId ?? nativeModelId),
            effort: String(summary.reasoning ?? nativeReasoning),
            access: String(summary.access ?? 'workspace-write'),
            federationDepth: 0,
            state: runtime?.state ?? 'idle',
            lifecycle: {
              state: runtime?.state === 'running' ? 'running' : 'completed',
            },
            childExecutionIds: [...new Set(childExecutionIds)],
            transcriptAvailable: true,
            startedAt: Number(summary.createdAt ?? Date.now()),
          };
        }
      }
      const child = findFixtureChild(executionId);
      if (!child) return undefined;
      const state = nativeExecutionState(child.scope.state ?? child.call.childState);
      return {
        executionId,
        conversationId: child.conversationId,
        parentExecutionId: `root:${child.conversationId}`,
        rootTurnId: child.turn.id,
        ownership: 'native',
        provider: 'fixture',
        providerInstanceId,
        model: nativeModelId,
        effort: nativeReasoning,
        access: 'workspace-write',
        federationDepth: 1,
        title: 'Native subagent',
        state,
        lifecycle: {
          state: state === 'running' ? 'running'
            : state === 'failed' ? 'failed'
              : state === 'interrupted' ? 'interrupted' : 'completed',
          ...(state === 'running' ? { activeAssignmentTurnId: child.turn.id } : {}),
        },
        ...(state === 'idle' ? { outcome: 'completed' } :
          state === 'failed' ? { outcome: 'failed' } :
            state === 'interrupted' ? { outcome: 'interrupted' } : {}),
        ...(child.scope.result || child.call.childBoundary ? {
          summary: String(child.scope.result ?? child.call.childBoundary),
        } : {}),
        childExecutionIds: [],
        transcriptAvailable: true,
        startedAt: Number(child.scope.startedAt ?? child.turn.startedAt),
        ...(child.scope.completedAt ? { completedAt: Number(child.scope.completedAt) } : {}),
      };
    }

    function nativeChildTranscriptValue(executionId: string, _windowSpec: string) {
      const child = findFixtureChild(executionId);
      if (!child) return undefined;
      const state = nativeExecutionState(child.scope.state ?? child.call.childState);
      const turnState = state === 'idle' ? 'completed' : state;
      const turnId = `child-turn:${executionId}`;
      const inferences = child.scope.inferences ?? [];
      const passes: any[] = inferences.map((inference: any, passOrdinal: number) => ({
        passId: String(inference.id),
        ordinal: passOrdinal,
        state: inference.state === 'running' ? 'streaming' : 'completed',
        blocks: (inference.blocks ?? []).map((block: any, blockOrdinal: number) =>
          nativeBlockValue(child.turn, inference, block, blockOrdinal)),
      }));
      const assistantText = String(child.scope.result ?? '');
      const finalBlockId = assistantText ? `child-final:${executionId}` : null;
      if (finalBlockId) {
        const pass: any = passes.at(-1) ?? {
          passId: `child-pass:${executionId}`,
          ordinal: 0,
          state: 'completed',
          blocks: [],
        };
        if (passes.length === 0) passes.push(pass);
        pass.blocks.push({
          blockId: finalBlockId,
          passId: pass.passId,
          ordinal: pass.blocks.length,
          kind: 'final-message',
          state: turnState === 'running' ? 'streaming' : 'completed',
          revision: 1,
          payload: { kind: 'final-message', text: assistantText },
          startedAt: Number(child.scope.startedAt ?? child.turn.startedAt),
          completedAt: child.scope.completedAt ?? null,
        });
      }
      const frame = {
        pathEntryId: `child-path:${executionId}`,
        strandId: String(resources.get(`conversation:${child.conversationId}`)?.value.activeStrandId),
        ordinal: 0,
        turnId,
        clientMessageId: `child-message:${executionId}`,
        executionId,
        state: turnState,
        ...(turnState === 'running' ? {} : { outcome: turnState }),
        userContent: [{
          type: 'text',
          text: String(child.call.detailPreview ?? child.call.childBoundary ?? 'Subagent task'),
        }],
        ordering: 'native-exact',
        passes,
        finalBlockId,
        activity: {
          reasoning: '', commentary: '', operations: [], fileChanges: [], web: [], children: [],
          notices: [], compacted: false,
        },
        assistantText,
        startedAt: Number(child.scope.startedAt ?? child.turn.startedAt),
        ...(child.scope.completedAt ? { completedAt: Number(child.scope.completedAt) } : {}),
        renderRevision: String(child.scope.revision),
        layoutRevision: String(child.scope.revision),
      };
      return {
        conversationId: child.conversationId,
        strandId: frame.strandId,
        executionId,
        activeTurnId: turnState === 'running' ? turnId : null,
        turnOrder: [turnId],
        turns: [frame],
        window: { startIndex: 0, endIndexExclusive: 1, hasEarlier: false, hasLater: false },
      };
    }

    function fixtureChildCalls(turn: Turn): Array<{ call: any; scope: any }> {
      const work = turn.segments.find((segment) => segment.type === 'work');
      const root = work ? executionScopes.get(executionScopeKey(turn.id, work.scopeId)) : null;
      return (root?.inferences ?? []).flatMap((inference: any) =>
        (inference.blocks ?? []).flatMap((block: any) =>
          block.type === 'action' && block.call.childScopeId
            ? [{
                call: block.call,
                scope: executionScopes.get(executionScopeKey(turn.id, block.call.childScopeId)),
              }]
            : []));
    }

    function findFixtureChild(executionId: string) {
      for (const [targetConversationId, targetTurns] of turnsByConversation) {
        for (const turn of targetTurns) {
          const child = fixtureChildCalls(turn).find(({ call }) =>
            String(call.childScopeId) === executionId);
          if (child?.scope) return { ...child, conversationId: targetConversationId, turn };
        }
      }
      return undefined;
    }

    function nativeResourceResult(params: any) {
      const generationChanged = params.knownServerGeneration !== undefined && params.knownServerGeneration !== generation;
      return {
        protocolVersion: nativeProtocolVersion,
        serverGeneration: generation,
        capabilityRevision,
        changedKeys: generationChanged ? params.requests.map((item: any) => item.key) : [],
        resources: params.requests.map((item: any) => {
          const entry = nativeResourceValue(String(item.key));
          if (!entry) return { key: item.key, status: 'missing' };
          if (!generationChanged && item.ifNoneMatch === entry.revision) {
            return { key: item.key, status: 'notModified', revision: entry.revision, basisSequence: sequence };
          }
          return {
            key: item.key, status: 'ok', revision: entry.revision,
            basisSequence: sequence, value: entry.value,
          };
        }),
      };
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
        if (resourceReadFailure) throw new Error('Fixture Agent runtime is unavailable.');
        return nativeResourceResult(params);
      }
      if (request.method === 'remux/agent/command/read') {
        if (holdCommandReadsUntilReload) {
          return { commandId: params.commandId, kind: params.kind, state: 'dispatching' };
        }
        return commandReceipts.get(String(params.commandId)) ?? { state: 'missing' };
      }
      if (request.method === 'remux/agent/transcript/resources/read') {
        if (params.historySync === 'force') {
          historyState = 'ready';
          resources.get('runtime')!.revision += 1;
        }
        return nativeResourceResult(params);
      }
      if (request.method === 'remux/agent/artifact/read') {
        const artifactId = String(params.artifactId);
        const binary = artifactBytes.get(artifactId);
        if (binary) {
          const start = Math.min(Number(params.offset), binary.bytes.byteLength);
          const end = Math.min(binary.bytes.byteLength, start + Number(params.byteLength));
          const selected = binary.bytes.slice(start, end);
          return {
            artifactId,
            mimeType: binary.mediaType,
            totalByteLength: binary.bytes.byteLength,
            offset: start,
            byteLength: end - start,
            base64: btoa(String.fromCharCode(...selected)),
          };
        }
        const artifactText = artifactTexts.get(artifactId);
        if (artifactText === undefined) {
          throw new Error('Fixture artifact range was not found.');
        }
        const bytes = new TextEncoder().encode(artifactText);
        const start = Math.min(Number(params.offset), bytes.byteLength);
        const end = Math.min(bytes.byteLength, start + Number(params.byteLength));
        return {
          artifactId,
          mimeType: 'text/plain; charset=utf-8',
          totalByteLength: bytes.byteLength,
          offset: start,
          byteLength: end - start,
          base64: btoa(String.fromCharCode(...bytes.slice(start, end))),
        };
      }
      if (request.method === 'remux/agent/artifact/put') {
        const encoded = String(params.dataUrl).split(',')[1] ?? '';
        const bytes = Uint8Array.from(atob(encoded), (value) => value.charCodeAt(0));
        const mimeType = /^data:([^;]+);base64,/u.exec(String(params.dataUrl))?.[1] ?? 'image/png';
        artifactBytes.set(pickedImageHash, { bytes, mediaType: mimeType });
        return {
          accepted: true,
          artifactId: pickedImageHash,
          mimeType,
          ...(params.name ? { name: String(params.name) } : {}),
          byteLength: bytes.byteLength,
        };
      }
      if (request.method === 'remux/agent/conversation/create') {
        nativeModelId = String(params.model);
        nativeReasoning = typeof params.effort === 'string' ? params.effort : null;
        nativeServiceTier = String(params.serviceTier ?? 'default');
        window.sessionStorage.setItem('remux.agent.fixture.native-config', JSON.stringify({
          modelId: nativeModelId,
          reasoning: nativeReasoning,
          serviceTier: nativeServiceTier,
        }));
        resources.set(conversationKey, {
          revision: 1,
          value: {
            ...conversationSummary(params.cwd, 'idle'),
            modelId: params.model,
            reasoning: typeof params.effort === 'string' ? params.effort : null,
            serviceTier: params.serviceTier ?? 'default',
            access: params.access,
          },
        });
        resources.set('runtime', {
          revision: (resources.get('runtime')?.revision ?? 0) + 1,
          value: runtimeValue('idle'),
        });
        invalidateResource(conversationKey, 'created');
        syncConversationList();
        invalidateResource('runtime');
        const result = { accepted: true, commandId: params.commandId, conversationId };
        commandReceipts.set(String(params.commandId), {
          commandId: params.commandId, kind: 'conversation.create', state: 'accepted',
          result: { accepted: true, conversationId },
        });
        saveCommandReceipts();
        if (loseNextCreateResponse) {
          loseNextCreateResponse = false;
          holdCommandReadsUntilReload = true;
          throw new Error('Fixture connection closed after accepting conversation creation.');
        }
        return result;
      }
      if (request.method === 'remux/agent/composer/provider-preference/set') {
        nativeModelId = String(params.model);
        nativeReasoning = typeof params.effort === 'string' ? params.effort : null;
        nativeServiceTier = String(params.serviceTier ?? 'default');
        preferenceRevision = `fixture-preference-v${Number(preferenceRevision.split('v').at(-1) ?? 1) + 1}`;
        window.sessionStorage.setItem('remux.agent.fixture.native-config', JSON.stringify({
          modelId: nativeModelId,
          reasoning: nativeReasoning,
          serviceTier: nativeServiceTier,
        }));
        const auth = resources.get('auth')!;
        auth.revision += 1;
        invalidateResource('auth');
        return { accepted: true, revision: preferenceRevision };
      }
      if (request.method === 'remux/agent/composer/conversation-preference/set') {
        nativeModelId = String(params.model);
        nativeReasoning = typeof params.effort === 'string' ? params.effort : null;
        nativeServiceTier = String(params.serviceTier ?? 'default');
        preferenceRevision = `fixture-preference-v${Number(preferenceRevision.split('v').at(-1) ?? 1) + 1}`;
        window.sessionStorage.setItem('remux.agent.fixture.native-config', JSON.stringify({
          modelId: nativeModelId,
          reasoning: nativeReasoning,
          serviceTier: nativeServiceTier,
        }));
        const targetConversationKey = `conversation:${String(params.conversationId)}`;
        const targetConversation = resources.get(targetConversationKey);
        if (targetConversation) {
          targetConversation.revision += 1;
          targetConversation.value.modelId = nativeModelId;
          targetConversation.value.reasoning = nativeReasoning;
          targetConversation.value.serviceTier = nativeServiceTier;
          targetConversation.value.updatedAt = Date.now();
        }
        const runtime = resources.get('runtime')!;
        runtime.revision += 1;
        const auth = resources.get('auth')!;
        auth.revision += 1;
        invalidateResource(targetConversationKey);
        invalidateResource('runtime');
        invalidateResource('auth');
        return {
          accepted: true,
          revision: `${capabilityRevision}:${runtime.revision}:${String(params.conversationId)}`,
        };
      }
      if (request.method === 'remux/agent/composer/conversation-access/set') {
        const targetConversationKey = `conversation:${String(params.conversationId)}`;
        const targetConversation = resources.get(targetConversationKey);
        if (targetConversation) {
          targetConversation.revision += 1;
          targetConversation.value.access = String(params.access);
          targetConversation.value.updatedAt = Date.now();
        }
        const runtime = resources.get('runtime')!;
        runtime.revision += 1;
        invalidateResource(targetConversationKey);
        invalidateResource('runtime');
        return {
          accepted: true,
          revision: `${capabilityRevision}:${runtime.revision}:${String(params.conversationId)}`,
        };
      }
      if (request.method === 'remux/agent/conversation/compact') {
        const runtime = resources.get('runtime')!;
        runtime.revision += 1;
        invalidateResource('runtime');
        return {
          accepted: true,
          operationId: String(params.commandId),
          delivery: 'sent',
        };
      }
      if (request.method === 'remux/agent/conversation/message/send') {
        if (nextMessageError) {
          const message = nextMessageError;
          nextMessageError = null;
          commandReceipts.set(String(params.commandId), {
            commandId: params.commandId,
            kind: 'turn.send',
            state: 'rejected',
            errorMessage: message,
          });
          saveCommandReceipts();
          if (holdReadsAfterNextMessageError) {
            holdReadsAfterNextMessageError = false;
            holdCommandReadsUntilReload = true;
          }
          throw new Error(message);
        }
        const runtime = resources.get('runtime')?.value;
        const content = Array.isArray(params.content) ? params.content : [];
        const text = nativeContentText(content);
        const parts = legacyPartsFromNative(content);
        const conversation = resources.get(`conversation:${String(params.conversationId)}`)?.value
          ?? resources.get(conversationKey)?.value;
        if (runtime?.state === 'running' || runtime?.state === 'interrupting') {
          const queued = {
            clientMessageId: String(params.clientMessageId),
            modelId: String(conversation?.modelId ?? 'gpt-5.6-sol'),
            operationId: String(params.commandId),
            parts,
            reasoning: String(conversation?.reasoning ?? 'high'),
            text,
          };
          pendingQueue.push(queued);
          syncFixtureQueue();
          window.sessionStorage.setItem(
            'remux.agent.fixture.accepted-queue', JSON.stringify(pendingQueue),
          );
          const result = {
            accepted: true, commandId: params.commandId,
            delivery: 'queued', turnId: params.commandId,
          };
          commandReceipts.set(String(params.commandId), {
            commandId: params.commandId, kind: 'turn.send', state: 'accepted', result,
          });
          saveCommandReceipts();
          if (loseNextMessageResponse) {
            loseNextMessageResponse = false;
            holdCommandReadsUntilReload = true;
            throw new Error('Fixture connection closed after accepting the first message.');
          }
          return result;
        }
        const turn = startFixtureMessage({
          clientMessageId: String(params.clientMessageId),
          modelId: String(conversation?.modelId ?? 'gpt-5.6-sol'),
          parts,
          reasoning: String(conversation?.reasoning ?? 'high'),
          text,
        });
        const result = {
          accepted: true,
          commandId: params.commandId,
          delivery: 'sent',
          turnId: turn.id,
        };
        commandReceipts.set(String(params.commandId), {
          commandId: params.commandId, kind: 'turn.send', state: 'accepted',
          result,
        });
        const acceptedMessages = JSON.parse(
          window.sessionStorage.getItem('remux.agent.fixture.accepted-messages') ?? '[]',
        ) as Array<{ commandId: string; turnId: string; text: string }>;
        if (!acceptedMessages.some((entry) => entry.commandId === String(params.commandId))) {
          acceptedMessages.push({ commandId: String(params.commandId), turnId: turn.id, text });
          window.sessionStorage.setItem(
            'remux.agent.fixture.accepted-messages', JSON.stringify(acceptedMessages),
          );
        }
        saveCommandReceipts();
        if (loseNextMessageResponse) {
          loseNextMessageResponse = false;
          holdCommandReadsUntilReload = true;
          throw new Error('Fixture connection closed after accepting the first message.');
        }
        return result;
      }
      if (request.method === 'remux/agent/conversation/message/queue/remove') {
        const index = pendingQueue.findIndex((entry) => entry.operationId === params.turnId);
        if (index < 0) return { status: 'retained' };
        pendingQueue.splice(index, 1);
        syncFixtureQueue();
        return { accepted: true, commandId: params.commandId, status: 'removed' };
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
      if (request.method === 'remux/agent/conversation/rename') {
        const targetConversationId = String(params.conversationId);
        const entry = resources.get(`conversation:${targetConversationId}`);
        if (!entry || Number(entry.value.metadataRevision) !== Number(params.expectedMetadataRevision)) {
          throw new Error('Conversation metadata changed; refresh and retry.');
        }
        entry.value.title = String(params.title);
        entry.value.metadataRevision = Number(entry.value.metadataRevision) + 1;
        entry.value.updatedAt = Date.now();
        entry.value.subtreeUpdatedAt = entry.value.updatedAt;
        entry.revision += 1;
        syncConversationList();
        invalidateResource(`conversation:${targetConversationId}`);
        return { accepted: true, metadataRevision: entry.value.metadataRevision };
      }
      if (request.method === 'remux/agent/conversation/archive/set') {
        const targetConversationId = String(params.conversationId);
        const entry = resources.get(`conversation:${targetConversationId}`);
        if (!entry || Number(entry.value.metadataRevision) !== Number(params.expectedMetadataRevision)) {
          throw new Error('Conversation metadata changed; refresh and retry.');
        }
        entry.value.archivedAt = params.archived ? Date.now() : null;
        entry.value.metadataRevision = Number(entry.value.metadataRevision) + 1;
        entry.value.updatedAt = Date.now();
        entry.value.subtreeUpdatedAt = entry.value.updatedAt;
        entry.revision += 1;
        syncConversationList();
        invalidateResource(`conversation:${targetConversationId}`);
        return { accepted: true };
      }
      if (request.method === 'remux/agent/conversation/strand/activate') {
        const targetConversationId = String(params.conversationId);
        const entry = resources.get(`conversation:${targetConversationId}`);
        if (!entry || Number(entry.value.headRevision) !== Number(params.expectedHeadRevision)) {
          throw new Error('Conversation history changed; refresh and retry.');
        }
        const versions = ensureConversationVersions(targetConversationId);
        const selected = versions.find((version) => version.strandId === String(params.strandId));
        if (!selected) throw new Error('The selected fixture version does not exist.');
        turnCounter += 1;
        const restoreStrandId = `fixture-strand:${targetConversationId}:restore-${turnCounter}`;
        const restoredTurns = structuredClone(selected.turns);
        versions.push({
          strandId: restoreStrandId,
          reason: 'restore',
          sourceStrandId: selected.strandId,
          sourcePathEntryId: selected.turns.at(-1)
            ? fixturePathEntryId(targetConversationId, selected.turns.at(-1)!.id)
            : null,
          turns: structuredClone(restoredTurns),
          createdAt: Date.now(),
        });
        turnsByConversation.set(targetConversationId, restoredTurns);
        Object.assign(entry.value, {
          activeStrandId: restoreStrandId,
          headRevision: Number(entry.value.headRevision) + 1,
          versionCount: versions.length,
          latestTurnId: restoredTurns.at(-1)?.id ?? null,
          updatedAt: Date.now(),
          subtreeUpdatedAt: Date.now(),
        });
        entry.revision += 1;
        syncConversationList();
        invalidateResource(`conversation:${targetConversationId}`);
        invalidateResource(`conversation-versions:${targetConversationId}`);
        invalidateTranscript(restoredTurns.at(-1)?.id ?? '', 'terminal', true, targetConversationId);
        return {
          accepted: true,
          strandId: restoreStrandId,
          headRevision: entry.value.headRevision,
        };
      }
      if (request.method === 'remux/agent/conversation/message/edit' ||
          request.method === 'remux/agent/conversation/message/fork') {
        const isFork = request.method.endsWith('/fork');
        const sourceConversationId = String(params.sourceConversationId);
        const sourceTurns = turnsByConversation.get(sourceConversationId) ?? [];
        const targetIndex = sourceTurnIndex(sourceConversationId, String(params.sourcePathEntryId));
        if (targetIndex < 0) throw new Error('The fixture branch point is not on the active strand.');
        const sourceResource = resources.get(`conversation:${sourceConversationId}`);
        if (!sourceResource) throw new Error('The fixture source conversation does not exist.');
        const sourceConversation = sourceResource.value;
        if (String(params.sourceStrandId) !== String(sourceConversation.activeStrandId) ||
            Number(params.expectedHeadRevision) !== Number(sourceConversation.headRevision)) {
          throw new Error('Conversation history changed; refresh and retry.');
        }
        ensureConversationVersions(sourceConversationId);
        turnCounter += 1;
        const destinationConversationId = isFork
          ? `33333333-3333-4333-8333-${String(turnCounter).padStart(12, '0')}`
          : sourceConversationId;
        const destinationStrandId = `fixture-strand:${destinationConversationId}:${turnCounter}`;
        const prefix = sourceTurns.slice(0, isFork ? targetIndex + 1 : targetIndex);
        const content = Array.isArray(params.content) ? params.content : [];
        const text = nativeContentText(content);
        const replacement = completedTurn(
          `branch-turn-${turnCounter}`,
          text,
          'The fixture branch completed.',
        );
        const replacementUser = replacement.segments.find((segment) => segment.type === 'userMessage');
        if (replacementUser) {
          replacementUser.clientMessageId = String(params.clientMessageId);
          replacementUser.parts = legacyPartsFromNative(content);
        }
        const branchTurns = [...prefix.map((turn) => structuredClone(turn)), replacement];
        turnsByConversation.set(destinationConversationId, branchTurns);
        const destinationVersions = isFork ? [] : ensureConversationVersions(sourceConversationId);
        destinationVersions.push({
          strandId: destinationStrandId,
          reason: isFork ? 'fork' : 'edit',
          sourceStrandId: String(sourceConversation.activeStrandId),
          sourcePathEntryId: String(params.sourcePathEntryId),
          turns: structuredClone(branchTurns),
          createdAt: Date.now(),
        });
        versionsByConversation.set(destinationConversationId, destinationVersions);
        const now = Date.now();
        if (isFork) {
          resources.set(`conversation:${destinationConversationId}`, {
            revision: 1,
            value: {
              ...conversationSummary('/tmp/remux-fixture', 'idle', destinationConversationId),
              latestTurnId: replacement.id,
              modelId: String(sourceConversation.modelId ?? 'gpt-5.6-sol'),
              preview: text,
              reasoning: String(sourceConversation.reasoning ?? 'high'),
              access: String(sourceConversation.access ?? 'workspace-write'),
              title: `${String(sourceConversation.title)} (fork)`,
              parentConversationId: sourceConversationId,
              rootConversationId: String(sourceConversation.rootConversationId ?? sourceConversationId),
              forkedFromPathEntryId: String(params.sourcePathEntryId),
              activeStrandId: destinationStrandId,
              subtreeUpdatedAt: now,
              updatedAt: now,
            },
          });
          sourceConversation.subtreeUpdatedAt = now;
          sourceResource.revision += 1;
        } else {
          Object.assign(sourceConversation, {
            activeStrandId: destinationStrandId,
            headRevision: Number(sourceConversation.headRevision) + 1,
            versionCount: destinationVersions.length,
            latestTurnId: replacement.id,
            preview: text,
            subtreeUpdatedAt: now,
            updatedAt: now,
          });
          sourceResource.revision += 1;
        }
        resources.set('runtime', {
          revision: (resources.get('runtime')?.revision ?? 0) + 1,
          value: { ...runtimeValue('idle'), conversationId: destinationConversationId, activeTurnId: null },
        });
        syncConversationList();
        invalidateResource(
          `conversation:${destinationConversationId}`,
          isFork ? 'created' : 'updated',
        );
        invalidateResource(`conversation-versions:${destinationConversationId}`);
        if (isFork) invalidateResource(`conversation:${sourceConversationId}`);
        invalidateResource('runtime');
        invalidateTranscript(replacement.id, 'terminal', true, destinationConversationId);
        return {
          accepted: true,
          commandId: params.commandId,
          conversationId: destinationConversationId,
          strandId: destinationStrandId,
          headRevision: Number(
            resources.get(`conversation:${destinationConversationId}`)?.value.headRevision ?? 1
          ),
          turnId: replacement.id,
        };
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
        return { accepted: true, commandId: params.commandId };
      }
      if (request.method === 'remux/agent/conversation/interrupt') {
        const activeTurnId = resources.get('runtime')?.value.activeTurnId;
        const turn = [...turnsByConversation.values()].flat()
          .find((candidate) => candidate.id === activeTurnId);
        if (turn) finishTurn(turn, 'interrupted');
        return { accepted: true, commandId: params.commandId };
      }
      if (request.method === 'remux/agent/conversation/execution/interrupt') {
        const executionId = String(params.executionId);
        const child = findFixtureChild(executionId);
        if (!child) throw new Error('Fixture child execution was not found.');
        const completedAt = Date.now();
        touchTurn(child.turn);
        Object.assign(child.scope, {
          state: 'interrupted',
          completedAt,
          durationMs: Math.max(1, completedAt - Number(child.scope.startedAt)),
          revision: `child:${sequence}`,
          basisSequence: sequence,
        });
        Object.assign(child.call, {
          status: 'interrupted',
          childState: 'interrupted',
          durationMs: Math.max(1, completedAt - Number(child.scope.startedAt)),
          childDurationMs: Math.max(1, completedAt - Number(child.scope.startedAt)),
          revision: `operation:child-agent:${sequence}`,
        });
        invalidateTranscript(child.turn.id, 'runtimeEvent', false, child.conversationId);
        dispatchInvalidations([{
          type: 'executionScope',
          key: executionScopeKey(child.turn.id, executionId),
          conversationId: child.conversationId,
          turnId: child.turn.id,
          scopeId: executionId,
          reason: 'terminal',
          affectsLayout: true,
          basisSequence: sequence,
        }]);
        return { accepted: true, commandId: params.commandId };
      }
      if (request.method === 'remux/agent/provider/login/start') {
        updateResource('auth', (auth) => Object.assign(auth, {
          state: 'signing-in', operationId: params.commandId,
          verificationUri: 'https://example.test/device', userCode: 'REMUX-CODE',
          progress: 'Waiting for authorization.', error: null,
        }));
        return { accepted: true, commandId: params.commandId, operationId: params.commandId };
      }
      if (request.method === 'remux/agent/provider/login/cancel') {
        updateResource('auth', (auth) => Object.assign(auth, {
          state: 'signed-out', operationId: null, verificationUri: null,
          userCode: null, progress: null,
        }));
        return { accepted: true, commandId: params.commandId };
      }
      if (request.method === 'remux/agent/provider/logout') {
        updateResource('auth', (auth) => Object.assign(auth, {
          state: 'signed-out', operationId: null, displayLabel: null,
          verificationUri: null, userCode: null, progress: null, error: null,
        }));
        return { accepted: true, commandId: params.commandId };
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
              if (request.method === 'remux/agent/conversation/create' && nextCreateResponseDelayMs > 0) {
                const delay = nextCreateResponseDelayMs;
                nextCreateResponseDelayMs = 0;
                const lose = loseNextCreateResponse;
                loseNextCreateResponse = false;
                const result = resultFor(request);
                if (lose) holdCommandReadsUntilReload = true;
                setTimeout(() => dispatch(lose
                  ? { type: 'remux/error', id: request.id, error: { code: -32019,
                      data: { kind: 'active_runtime_busy' },
                      message: 'Fixture connection closed after accepting conversation creation.' } }
                  : { type: 'remux/response', id: request.id, result }), delay);
                return;
              }
              if (delayModels && !modelsDelayed && request.method === 'remux/agent/resources/read'
                  && request.params?.requests?.some((entry: any) => String(entry.key).startsWith('agent/models:'))) {
                modelsDelayed = true;
                const result = JSON.parse(JSON.stringify(resultFor(request)));
                setTimeout(() => dispatch({ type: 'remux/response', id: request.id, result }), 250);
                return;
              }
              if (request.method === 'remux/agent/transcript/resources/read' && nextTranscriptDelayMs > 0) {
                // The native bridge crosses a JSON boundary. Snapshot delayed results now so
                // later fixture mutations cannot retroactively alter an in-flight response.
                const result = JSON.parse(JSON.stringify(resultFor(request)));
                const delay = nextTranscriptDelayMs;
                nextTranscriptDelayMs = 0;
                setTimeout(() => dispatch({ type: 'remux/response', id: request.id, result }), delay);
                return;
              }
              if (
                request.method === 'remux/agent/transcript/resources/read' &&
                transcriptFailuresRemaining > 0
              ) {
                transcriptFailuresRemaining -= 1;
                dispatch({
                  type: 'remux/error',
                  id: request.id,
                  error: {
                    code: -32000,
                    data: { kind: 'fixture_transient_failure' },
                    message: 'Fixture transcript read failed transiently.',
                  },
                });
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
        appendCompletedTurnTo(targetConversationId: string, user: string, assistant: string) {
          const targetTurns = turnsByConversation.get(targetConversationId);
          if (!targetTurns) throw new Error(`Unknown fixture conversation ${targetConversationId}.`);
          turnCounter += 1;
          const turn = completedTurn(`external-turn-${turnCounter}`, user, assistant);
          targetTurns.push(turn);
          sequence += 1;
          invalidateTranscript(turn.id, 'terminal', true, targetConversationId);
        },
        reviseLatestAssistant(targetConversationId: string, assistantText: string) {
          const turn = turnsByConversation.get(targetConversationId)?.at(-1);
          const assistant = turn?.segments.find((segment) => segment.type === 'assistantMessage');
          if (!turn || !assistant) {
            throw new Error(`Fixture conversation ${targetConversationId} has no assistant turn.`);
          }
          assistant.text = assistantText;
          touchTurn(turn);
          invalidateTranscript(turn.id, 'runtimeEvent', false, targetConversationId);
        },
        setTurnError(turnId: string, message: string | null) {
          const turn = turns.find((candidate) => candidate.id === turnId);
          if (!turn) throw new Error(`Unknown fixture turn ${turnId}.`);
          turn.error = message ? { code: 'provider_error', message } : null;
          turn.status = message ? 'failed' : 'completed';
          touchTurn(turn);
          invalidateTranscript(turn.id, 'runtimeEvent', true);
        },
        addConversation(input: {
          archivedAt?: number;
          cwd?: string;
          id: string;
          preview?: string;
          title: string;
        }) {
          const key = `conversation:${input.id}`;
          if (!turnsByConversation.has(input.id)) turnsByConversation.set(input.id, []);
          resources.set(key, {
            revision: 1,
            value: {
              ...conversationSummary(input.cwd ?? '/tmp/remux-fixture', 'idle', input.id),
              id: input.id,
              latestTurnId: null,
              archivedAt: input.archivedAt ?? null,
              preview: input.preview ?? '',
              title: input.title,
              updatedAt: Date.now() + 1,
            },
          });
          invalidateResource(key, 'created');
          syncConversationList();
        },
        addConversations(inputs: Array<{
          createdAt?: number;
          cwd?: string;
          id: string;
          lastActivityAt?: number;
          parentConversationId?: string;
          preview?: string;
          title: string;
          updatedAt?: number;
        }>) {
          for (const input of inputs) {
            if (!turnsByConversation.has(input.id)) turnsByConversation.set(input.id, []);
            const parent = input.parentConversationId
              ? resources.get(`conversation:${input.parentConversationId}`)?.value
              : null;
            const createdAt = input.createdAt ?? Date.now();
            resources.set(`conversation:${input.id}`, {
              revision: 1,
              value: {
                ...conversationSummary(input.cwd ?? '/tmp/remux-fixture', 'idle', input.id),
                id: input.id,
                parentConversationId: input.parentConversationId ?? null,
                rootConversationId: String(parent?.rootConversationId ?? input.id),
                createdAt,
                lastActivityAt: input.lastActivityAt ?? input.updatedAt ?? createdAt,
                latestTurnId: null,
                preview: input.preview ?? '',
                title: input.title,
                subtreeUpdatedAt: createdAt,
                updatedAt: input.updatedAt ?? createdAt,
              },
            });
          }
          syncConversationList();
        },
        delayNextTranscript(delayMs: number) {
          nextTranscriptDelayMs = Math.max(0, delayMs);
        },
        dropInvalidations(value = true) {
          invalidationsDropped = Boolean(value);
        },
        failNextTranscriptReads(count = 1) {
          transcriptFailuresRemaining = Math.max(0, Number(count));
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
            blocks: [{
              id: `${inferenceId}:reasoning`, type: 'reasoning', state: 'final',
              revision: `reasoning:${sequence}`,
              text: 'Validated the refreshed execution-scope revision.',
            }],
          }];
          dispatchInvalidations([{
            type: 'executionScope', key, conversationId, turnId: turn.id,
            scopeId: work.scopeId, reason: 'runtimeEvent', affectsLayout: true,
            basisSequence: sequence,
          }]);
        },
        refreshLatestRunningTurn() {
          const turn = turns.at(-1);
          if (!turn || turn.status !== 'inProgress') {
            throw new Error('No running fixture turn is available.');
          }
          touchTurn(turn);
          invalidateTranscript(turn.id, 'runtimeEvent', true);
        },
        streamLatestAssistantText(text: string) {
          const turn = turns.at(-1);
          const assistant = turn?.segments.find((segment) => segment.type === 'assistantMessage');
          if (!turn || turn.status !== 'inProgress' || !assistant) {
            throw new Error('No running fixture assistant message is available.');
          }
          assistant.text = text;
          touchTurn(turn);
          invalidateTranscript(turn.id, 'runtimeEvent', false);
        },
        rejectNextMessage(message = 'Another conversation has an active turn.') {
          nextMessageError = message;
        },
        rejectNextMessageUntilReload(message = 'Another conversation has an active turn.') {
          nextMessageError = message;
          holdReadsAfterNextMessageError = true;
        },
        loseNextCreateAcknowledgement() {
          loseNextCreateResponse = true;
        },
        delayNextCreateAcknowledgement(delayMs = 750) {
          nextCreateResponseDelayMs = Number(delayMs);
        },
        loseNextMessageAcknowledgement() {
          loseNextMessageResponse = true;
        },
        releaseCommandReads() {
          holdCommandReadsUntilReload = false;
        },
        acceptLegacyDraft(operationId: string) {
          resources.set(conversationKey, {
            revision: 1,
            value: conversationSummary('/tmp/remux-fixture', 'idle'),
          });
          resources.set('runtime', { revision: 2, value: runtimeValue('idle') });
          syncConversationList();
          commandReceipts.set(operationId, {
            commandId: operationId, kind: 'conversation.create', state: 'accepted',
            result: { accepted: true, conversationId },
          });
          saveCommandReceipts();
        },
        connection: dispatchStatus,
        lifecycle: dispatchLifecycle,
        setRuntimeLifecycle(input: {
          state: 'idle' | 'running' | 'checking' | 'stopping' | 'unavailable';
          runningCount?: number;
          checkingCount?: number;
          stoppingCount?: number;
          stopErrorCount?: number;
          stopRequested?: boolean;
        }, targetConversationId = conversationId) {
          lifecycleByConversation.set(targetConversationId, {
            runningCount: 0,
            checkingCount: 0,
            stoppingCount: 0,
            stopErrorCount: 0,
            stopRequested: false,
            ...input,
          });
          sequence += 1;
          const runtime = resources.get('runtime');
          if (runtime) runtime.revision += 1;
          if (activeFixtureConversationId() === targetConversationId) invalidateResource('runtime');
        },
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
        updateComposerUsage(input: {
          contextUsedTokens: number;
          fiveHourUsedPercent: number;
          weeklyUsedPercent: number;
        }) {
          contextUsedTokens = input.contextUsedTokens;
          fiveHourUsagePercent = input.fiveHourUsedPercent;
          weeklyUsagePercent = input.weeklyUsedPercent;
          usageObservedAt += 1_000;
          const auth = resources.get('auth');
          if (auth) auth.revision += 1;
          const runtime = resources.get('runtime');
          if (runtime) runtime.revision += 1;
          invalidateResource('auth');
          invalidateResource('runtime');
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
  }, {
    nativeProtocolVersion: NATIVE_AGENT_PROTOCOL_VERSION,
    transcriptProjectionVersion: AGENT_TRANSCRIPT_PROJECTION_VERSION,
    transcriptProtocolVersion: AGENT_TRANSCRIPT_PROTOCOL_VERSION,
  });
}
