import { expect, type Page, test } from '@playwright/test';

import type { ThreadTokenUsage } from '../shared/protocol/v2/ThreadTokenUsage';
import type { CodexTranscriptTurn, CodexWorkDetails, CodexWorkItem } from '../shared/transcript';

type HostRequest = {
  id?: number | string;
  method?: string;
  params?: unknown;
  type?: string;
};

type MockHostOptions = {
  attachments?: Array<{
    dataUrl: string;
    mimeType: string;
    name: string;
    sizeBytes: number;
  }>;
  commandErrors?: Record<string, string>;
  cwd?: string;
  fuzzyFiles?: Array<{ path: string; isDirectory?: boolean }>;
  narrationStatus?: 'planning' | 'ready';
  sendUpdatesTranscript?: boolean;
  runtime?: {
    activeTurnElapsedMs: number | null;
    activeTurnId: string | null;
    status: 'failed' | 'ready' | 'running' | 'stopping';
  };
  threadCwd?: string;
  tokenUsage?: ThreadTokenUsage | null;
  transcriptV2?: boolean;
  transcriptReadDelayMs?: number;
  turns?: CodexTranscriptTurn[];
  workDetails?: Record<string, CodexWorkDetails>;
  workItems?: Record<string, CodexWorkItem>;
};

const defaultFuzzyFiles = [
  { path: 'package.json' },
  { path: 'package-lock.json' },
  { path: 'extensions/codex/viewer/composer/mentions/MentionPicker.tsx' },
  { path: 'extensions/codex/viewer/composer/ComposerEditor.tsx' },
  { path: 'README.md' },
] satisfies Array<{ path: string; isDirectory?: boolean }>;

async function installMockRemuxHost(page: Page, options: MockHostOptions = {}) {
  const attachments = options.attachments ?? [];
  const commandErrors = options.commandErrors ?? {};
  const cwd = options.cwd ?? '/tmp/remux';
  const fuzzyFiles = options.fuzzyFiles ?? defaultFuzzyFiles;
  const narrationStatus = options.narrationStatus ?? 'ready';
  const sendUpdatesTranscript = options.sendUpdatesTranscript ?? false;
  const runtime = options.runtime ?? {
    activeTurnElapsedMs: null,
    activeTurnId: null,
    status: 'ready' as const,
  };
  const threadCwd = options.threadCwd ?? cwd;
  const tokenUsage = options.tokenUsage ?? null;
  const transcriptV2 = options.transcriptV2 ?? false;
  const transcriptReadDelayMs = options.transcriptReadDelayMs ?? 0;
  const turns = options.turns ?? [];
  const workDetails = options.workDetails ?? {};
  const workItems = options.workItems ?? {};

  await page.addInitScript(
    ({ attachments, commandErrors, cwd, files, narrationStatus, runtime, sendUpdatesTranscript, threadCwd, tokenUsage, transcriptReadDelayMs, transcriptV2, turns, workDetails, workItems }) => {
      const capturedMessages: HostRequest[] = [];
      const narrationResources = new Map<string, Record<string, unknown>>();
      let queueRevision = 0;
      let sentTurnCount = 0;
      const queuedEntries: Array<Record<string, unknown>> = [];

      function dispatchHostMessage(message: unknown) {
        const event = new MessageEvent('message', {
          data: JSON.stringify(message),
        });
        window.dispatchEvent(event);
        document.dispatchEvent(event);
      }

      const mockWindow = window as typeof window & {
        __remuxDispatchMockHostMessage?: (message: unknown) => void;
        __remuxSetMockTranscriptTurns?: (nextTurns: CodexTranscriptTurn[]) => void;
      };
      mockWindow.__remuxDispatchMockHostMessage = dispatchHostMessage;
      mockWindow.__remuxSetMockTranscriptTurns = (nextTurns) => {
        turns.splice(0, turns.length, ...nextTurns);
      };

      function postResult(request: HostRequest, result: unknown) {
        const deliver = () => dispatchHostMessage({
          id: request.id,
          result,
          type: 'remux/response',
        });
        if (request.method === 'remux/codex/transcript/resources/read' && transcriptReadDelayMs > 0) {
          window.setTimeout(deliver, transcriptReadDelayMs);
          return;
        }
        deliver();
      }

      function postError(request: HostRequest, message: string) {
        dispatchHostMessage({
          error: {
            code: -32000,
            message,
          },
          id: request.id,
          type: 'remux/error',
        });
      }

      function silentWavBase64(seconds: number) {
        const sampleRate = 24_000;
        const samples = Math.max(1, Math.round(seconds * sampleRate));
        const bytes = new Uint8Array(44 + samples * 2);
        const view = new DataView(bytes.buffer);
        const write = (offset: number, value: string) => {
          for (let index = 0; index < value.length; index += 1) view.setUint8(offset + index, value.charCodeAt(index));
        };
        write(0, 'RIFF');
        view.setUint32(4, 36 + samples * 2, true);
        write(8, 'WAVE');
        write(12, 'fmt ');
        view.setUint32(16, 16, true);
        view.setUint16(20, 1, true);
        view.setUint16(22, 1, true);
        view.setUint32(24, sampleRate, true);
        view.setUint32(28, sampleRate * 2, true);
        view.setUint16(32, 2, true);
        view.setUint16(34, 16, true);
        write(36, 'data');
        view.setUint32(40, samples * 2, true);
        let binary = '';
        for (let offset = 0; offset < bytes.length; offset += 0x8000) {
          binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
        }
        return btoa(binary);
      }

      function resultFor(request: HostRequest) {
        switch (request.method) {
          case 'remux/codex/transcript/capabilities/read':
            return transcriptV2 ? {
              limits: {
                maxGroupRows: 256,
                maxKnownTurns: 80,
                maxResponseBytes: 8 * 1024 * 1024,
                maxWindowTurns: 40,
              },
              preferredProtocolVersion: 2,
              projectionVersions: { 2: 'turn-render-v2' },
              protocolVersions: [1, 2],
            } : null;
          case 'remux/codex/thread/resources/read': {
            const params =
              request.params && typeof request.params === 'object'
                ? (request.params as { requests?: unknown })
                : {};
            const requests = Array.isArray(params.requests) ? params.requests : [];
            const mockThread = {
              archived: false,
              createdAt: 1782000000,
              cwd: threadCwd,
              id: 'mock-thread-1',
              modelProvider: 'openai',
              name: 'Mock thread',
              path: `${threadCwd}/.codex/sessions/mock-thread-1.jsonl`,
              preview: 'Mock thread preview',
              sessionId: 'mock-thread-1',
              source: 'test',
              status: { type: 'notLoaded' },
              title: 'Mock thread',
              updatedAt: 1782000100,
            };

            return {
              resources: requests.map((resourceRequest, requestIndex) => {
                const typedRequest =
                  resourceRequest && typeof resourceRequest === 'object'
                    ? (resourceRequest as { threadId?: unknown; type?: unknown })
                    : {};
                const threadId = typeof typedRequest.threadId === 'string' ? typedRequest.threadId : 'mock-thread-1';

                if (typedRequest.type === 'threadHistory') {
                  return {
                    key: 'threadHistory:updated_at:desc:50::false:',
                    requestIndex,
                    revision: 'mock-history-revision',
                    status: 'ok',
                    value: {
                      backwardsCursor: null,
                      nextCursor: null,
                      revision: 'mock-history-revision',
                      threads: [mockThread],
                    },
                  };
                }

                if (typedRequest.type === 'threadSummary') {
                  return {
                    key: `threadSummary:${threadId}`,
                    requestIndex,
                    revision: `mock-summary-revision:${threadId}`,
                    status: 'ok',
                    value: {
                      revision: `mock-summary-revision:${threadId}`,
                      thread: { ...mockThread, id: threadId },
                    },
                  };
                }

                if (typedRequest.type === 'threadRuntime') {
                  return {
                    key: `threadRuntime:${threadId}`,
                    requestIndex,
                    revision: `mock-runtime-revision:${threadId}`,
                    status: 'ok',
                    value: {
                      activeTurnElapsedMs: runtime.activeTurnElapsedMs,
                      activeTurnId: runtime.activeTurnId,
                      lastError: null,
                      revision: `mock-runtime-revision:${threadId}`,
                      status: runtime.status,
                      threadId,
                    },
                  };
                }

                if (typedRequest.type === 'threadOperationQueue') {
                  return {
                    key: `threadOperationQueue:${threadId}`,
                    requestIndex,
                    revision: String(queueRevision),
                    status: 'ok',
                    value: {
                      entries: queuedEntries,
                      revision: String(queueRevision),
                      threadId,
                    },
                  };
                }

                if (typedRequest.type === 'threadComposerState') {
                  return {
                    key: `threadComposerState:${threadId}`,
                    requestIndex,
                    revision: `mock-composer-state-revision:${threadId}`,
                    status: 'ok',
                    value: {
                      effective: {
                        cwd: threadCwd,
                        model: 'gpt-5.1-codex',
                        modelContextWindow: tokenUsage?.modelContextWindow ?? null,
                        modelProvider: 'openai',
                      },
                      lastAppliedTurnId: tokenUsage ? 'mock-token-turn-1' : null,
                      observedConfig: {
                        intelligence: 'medium',
                        model: null,
                        reviewMode: 'auto-review',
                        speed: null,
                      },
                      preference: {
                        intelligence: 'medium',
                        model: null,
                        reviewMode: 'auto-review',
                        revision: `mock-composer-state-revision:${threadId}`,
                        speed: 'fast',
                      },
                      revision: `mock-composer-state-revision:${threadId}`,
                      rolloutRevision: 'mock-rollout-revision',
                      threadId,
                      tokenUsage,
                      tokenUsageSource: tokenUsage ? 'rollout' : 'none',
                      tokenUsageTurnId: tokenUsage ? 'mock-token-turn-1' : null,
                    },
                  };
                }

                if (typedRequest.type === 'threadTokenUsage') {
                  return {
                    key: `threadTokenUsage:${threadId}`,
                    requestIndex,
                    revision: `mock-token-usage-revision:${threadId}`,
                    status: 'ok',
                    value: {
                      revision: `mock-token-usage-revision:${threadId}`,
                      threadId,
                      tokenUsage,
                      turnId: tokenUsage ? 'mock-token-turn-1' : null,
                    },
                  };
                }

                return {
                  key: `${String(typedRequest.type)}:${threadId}`,
                  requestIndex,
                  revision: 'mock-thread-resource-revision',
                  status: 'missing',
                };
              }),
            };
          }
          case 'remux/codex/transcript/resources/read': {
            const params =
              request.params && typeof request.params === 'object'
                ? (request.params as { requests?: unknown; threadId?: unknown })
                : {};
            const requests = Array.isArray(params.requests) ? params.requests : [];
            const threadId = typeof params.threadId === 'string' ? params.threadId : 'mock-thread-1';

            return {
              resources: requests.map((resourceRequest, requestIndex) => {
                const typedRequest =
                  resourceRequest && typeof resourceRequest === 'object'
                    ? (resourceRequest as {
                        itemId?: unknown;
                        segmentId?: unknown;
                        turnId?: unknown;
                        type?: unknown;
                        window?: unknown;
                      })
                    : {};

                if (typedRequest.type === 'threadTranscript') {
                  return {
                    key: `threadTranscript:${threadId}`,
                    requestIndex,
                    revision: 'mock-transcript-revision',
                    status: 'ok',
                    value: {
                      revision: 'mock-transcript-revision',
                      threadId,
                      turnOrder: turns.map((turn) => turn.id),
                    },
                  };
                }

                if (typedRequest.type === 'transcriptSync') {
                  const requestedWindow = typedRequest.window && typeof typedRequest.window === 'object'
                    ? typedRequest.window as {
                        after?: unknown;
                        before?: unknown;
                        count?: unknown;
                        endTurnId?: unknown;
                        kind?: unknown;
                        startTurnId?: unknown;
                        turnId?: unknown;
                      }
                    : { count: 24, kind: 'tail' };
                  let startIndex = 0;
                  let endIndexExclusive = turns.length;
                  if (requestedWindow.kind === 'tail') {
                    const count = typeof requestedWindow.count === 'number' ? requestedWindow.count : 24;
                    startIndex = Math.max(0, turns.length - count);
                  } else if (requestedWindow.kind === 'around' && typeof requestedWindow.turnId === 'string') {
                    const index = Math.max(0, turns.findIndex((turn) => turn.id === requestedWindow.turnId));
                    const before = typeof requestedWindow.before === 'number' ? requestedWindow.before : 12;
                    const after = typeof requestedWindow.after === 'number' ? requestedWindow.after : 12;
                    startIndex = Math.max(0, index - before);
                    endIndexExclusive = Math.min(turns.length, index + after + 1);
                  } else if (
                    requestedWindow.kind === 'range' &&
                    typeof requestedWindow.startTurnId === 'string' &&
                    typeof requestedWindow.endTurnId === 'string'
                  ) {
                    startIndex = Math.max(0, turns.findIndex((turn) => turn.id === requestedWindow.startTurnId));
                    const endIndex = turns.findIndex((turn) => turn.id === requestedWindow.endTurnId);
                    endIndexExclusive = endIndex < startIndex ? startIndex + 1 : endIndex + 1;
                  }
                  const windowTurns = turns.slice(startIndex, endIndexExclusive);
                  return {
                    key: `transcriptSync:${threadId}`,
                    requestIndex,
                    revision: 'mock-transcript-v2-resource-revision',
                    status: 'ok',
                    value: {
                      activeTurnId: windowTurns.find((turn) => turn.status === 'inProgress')?.id ?? null,
                      projectionVersion: 'turn-render-v2',
                      protocolVersion: 2,
                      removedTurnIds: [],
                      sessionId: threadId,
                      threadId,
                      threadRevision: 'mock-transcript-v2-thread-revision',
                      turnOrder: turns.map((turn) => turn.id),
                      turns: windowTurns.map((turn) => ({
                        frame: {
                          ...turn,
                          layoutRevision: turn.revision,
                          renderRevision: turn.revision,
                        },
                        renderRevision: turn.revision,
                        status: 'ok',
                        turnId: turn.id,
                      })),
                      window: {
                        endIndexExclusive,
                        hasEarlier: startIndex > 0,
                        hasLater: endIndexExclusive < turns.length,
                        startIndex,
                        turnIds: windowTurns.map((turn) => turn.id),
                      },
                    },
                  };
                }

                if (
                  transcriptV2 &&
                  typedRequest.type === 'workGroup' &&
                  typeof typedRequest.segmentId === 'string' &&
                  typeof typedRequest.turnId === 'string'
                ) {
                  const groupId = String((typedRequest as { groupId?: unknown }).groupId ?? 'group');
                  return {
                    key: `workGroup:${threadId}:${typedRequest.turnId}:${typedRequest.segmentId}:${groupId}`,
                    requestIndex,
                    revision: `mock-group-revision:${groupId}`,
                    status: 'ok',
                    value: {
                      groupId,
                      layoutRevision: `mock-group-layout:${groupId}`,
                      nextCursor: null,
                      revision: `mock-group-revision:${groupId}`,
                      rows: [{
                        category: 'generic',
                        detailPreview: 'Arguments',
                        hasDetail: true,
                        id: `row:${groupId}`,
                        label: 'Mock tool call',
                        mediaCount: 0,
                        revision: `mock-row-revision:${groupId}`,
                        status: 'completed',
                        type: 'tool',
                      }],
                      segmentId: typedRequest.segmentId,
                      threadId,
                      title: 'Tools',
                      turnId: typedRequest.turnId,
                      type: 'tools',
                    },
                  };
                }

                if (
                  transcriptV2 &&
                  typedRequest.type === 'workEntryDetail' &&
                  typeof typedRequest.segmentId === 'string' &&
                  typeof typedRequest.turnId === 'string'
                ) {
                  const groupId = String((typedRequest as { groupId?: unknown }).groupId ?? 'group');
                  const rowId = String((typedRequest as { rowId?: unknown }).rowId ?? 'row');
                  return {
                    key: `workEntryDetail:${threadId}:${typedRequest.turnId}:${typedRequest.segmentId}:${groupId}:${rowId}`,
                    requestIndex,
                    revision: `mock-detail-revision:${rowId}`,
                    status: 'ok',
                    value: {
                      detail: {
                        detail: 'Mock arguments',
                        media: [],
                        result: 'Mock result',
                        type: 'tool',
                      },
                      groupId,
                      layoutRevision: `mock-detail-layout:${rowId}`,
                      revision: `mock-detail-revision:${rowId}`,
                      rowId,
                      segmentId: typedRequest.segmentId,
                      threadId,
                      truncation: { originalBytes: 11, returnedBytes: 11, truncated: false },
                      turnId: typedRequest.turnId,
                    },
                  };
                }

                if (typedRequest.type === 'turn') {
                  const turn = turns.find((turn) => turn.id === typedRequest.turnId);
                  if (turn) {
                    return {
                      key: `turn:${threadId}:${turn.id}`,
                      requestIndex,
                      revision: turn.revision,
                      status: 'ok',
                      value: {
                        layoutRevision: turn.revision,
                        revision: turn.revision,
                        threadId,
                        turn,
                        turnId: turn.id,
                      },
                    };
                  }
                }

                if (
                  typedRequest.type === 'workDetails' &&
                  typeof typedRequest.segmentId === 'string' &&
                  typeof typedRequest.turnId === 'string'
                ) {
                  const details = workDetails[typedRequest.segmentId];
                  if (details) {
                    return {
                      key: `workDetails:${threadId}:${typedRequest.turnId}:${typedRequest.segmentId}`,
                      requestIndex,
                      revision: details.revision,
                      status: 'ok',
                      value: {
                        details,
                        revision: details.revision,
                        segmentId: typedRequest.segmentId,
                        threadId,
                        turnId: typedRequest.turnId,
                      },
                    };
                  }
                }

                if (
                  typedRequest.type === 'workItem' &&
                  typeof typedRequest.itemId === 'string' &&
                  typeof typedRequest.turnId === 'string'
                ) {
                  const item = workItems[typedRequest.itemId];
                  if (item) {
                    const revision = `mock-work-item-revision:${typedRequest.itemId}`;
                    return {
                      key: `workItem:${threadId}:${typedRequest.turnId}:${typedRequest.itemId}`,
                      requestIndex,
                      revision,
                      status: 'ok',
                      value: {
                        item,
                        itemId: typedRequest.itemId,
                        revision,
                        threadId,
                        turnId: typedRequest.turnId,
                      },
                    };
                  }
                }

                return {
                  key: `turn:${threadId}:${String(typedRequest.turnId ?? '')}`,
                  requestIndex,
                  revision: 'mock-turn-revision',
                  status: 'missing',
                };
              }),
              threadId,
            };
          }
          case 'remux/codex/thread/message/send': {
            const params = request.params as {
              clientMessageId?: string;
              parts?: Array<Record<string, unknown>>;
              threadId?: string;
            };
            const wasRunning = runtime.status === 'running';
            if (wasRunning) {
              queuedEntries.push({
                createdAt: Date.now(),
                id: `queued-message-${queuedEntries.length + 1}`,
                kind: 'message',
                preview: {
                  attachmentCount: (params.parts ?? []).filter((part) => part.type === 'image').length,
                  mentionCount: (params.parts ?? []).filter((part) => part.type === 'mention').length,
                  text: (params.parts ?? [])
                    .filter((part) => part.type === 'text')
                    .map((part) => part.text)
                    .join(''),
                },
              });
              queueRevision += 1;
            }
            let sentTurnId: string | undefined;
            if (!wasRunning && sendUpdatesTranscript) {
              sentTurnCount += 1;
              sentTurnId = `mock-sent-turn-${sentTurnCount}`;
              // Match production: the segment id is server-assigned; the
              // composer's clientMessageId only comes back as clientId.
              const userMessageId = `mock-sent-user-${sentTurnCount}`;
              const userText = (params.parts ?? [])
                .filter((part) => part.type === 'text')
                .map((part) => String(part.text ?? ''))
                .join('');
              turns.push({
                completedAt: null,
                durationMs: null,
                error: null,
                id: sentTurnId,
                revision: `${sentTurnId}-running-revision`,
                segments: [{
                  clientId: params.clientMessageId ?? null,
                  content: [{ text: userText, text_elements: [], type: 'text' }],
                  id: userMessageId,
                  revision: `${userMessageId}-revision`,
                  type: 'userMessage',
                }],
                startedAt: Date.now(),
                status: 'inProgress',
              });
              runtime.activeTurnElapsedMs = 0;
              runtime.activeTurnId = sentTurnId;
              runtime.status = 'running';
            }
            const sentInvalidations = sendUpdatesTranscript && sentTurnId
              ? [
                  {
                    key: 'threadRuntime:mock-thread-1',
                    reason: 'sendAccepted',
                    threadId: 'mock-thread-1',
                    type: 'threadRuntime',
                  },
                  {
                    key: 'threadTranscript:mock-thread-1',
                    reason: 'sendAccepted',
                    threadId: 'mock-thread-1',
                    type: 'threadTranscript',
                  },
                  {
                    affectsLayout: true,
                    affectsOrder: true,
                    key: 'transcriptSync:mock-thread-1',
                    reason: 'sendAccepted',
                    threadId: 'mock-thread-1',
                    turnId: sentTurnId,
                    type: 'transcript',
                  },
                ]
              : [
                  {
                    key: 'threadOperationQueue:mock-thread-1',
                    reason: 'commandAccepted',
                    threadId: 'mock-thread-1',
                    type: 'threadOperationQueue',
                  },
                ];
            return {
              invalidations: sentInvalidations,
              delivery: wasRunning ? 'queued' : 'sent',
              status: 'accepted',
              threadId: 'mock-thread-1',
              turnId: sentTurnId ?? (wasRunning ? undefined : 'mock-turn-1'),
            };
          }
          case 'remux/codex/thread/compact': {
            if (runtime.status === 'running') {
              queuedEntries.push({
                createdAt: Date.now(),
                id: `queued-compact-${queuedEntries.length + 1}`,
                kind: 'compact',
              });
              queueRevision += 1;
            }
            return {
              delivery: runtime.status === 'running' ? 'queued' : 'sent',
              invalidations: [{
                key: 'threadOperationQueue:mock-thread-1',
                reason: 'commandAccepted',
                threadId: 'mock-thread-1',
                type: 'threadOperationQueue',
              }],
              status: 'accepted',
              threadId: 'mock-thread-1',
            };
          }
          case 'remux/codex/thread/queue/remove':
          case 'remux/codex/thread/queue/run-now': {
            const params = request.params as { operationId?: string };
            const index = queuedEntries.findIndex((entry) => entry.id === params.operationId);
            if (index >= 0) queuedEntries.splice(index, 1);
            queueRevision += 1;
            return {
              invalidations: [{
                key: 'threadOperationQueue:mock-thread-1',
                reason: 'commandAccepted',
                threadId: 'mock-thread-1',
                type: 'threadOperationQueue',
              }],
              queueRevision: String(queueRevision),
              status: 'accepted',
              threadId: 'mock-thread-1',
            };
          }
          case 'remux/codex/thread/turn/interrupt': {
            queuedEntries.splice(0, queuedEntries.length);
            queueRevision += 1;
            return {
              invalidations: [{
                key: 'threadOperationQueue:mock-thread-1',
                reason: 'commandAccepted',
                threadId: 'mock-thread-1',
                type: 'threadOperationQueue',
              }],
              status: 'accepted',
              threadId: 'mock-thread-1',
              turnId: 'active-turn-1',
            };
          }
          case 'remux/codex/thread/message/start':
            return {
              invalidations: [
                {
                  key: 'threadHistory:updated_at:desc:50::false:',
                  reason: 'sendAccepted',
                  type: 'threadHistory',
                },
                {
                  key: 'threadSummary:mock-new-thread-1',
                  reason: 'sendAccepted',
                  threadId: 'mock-new-thread-1',
                  type: 'threadSummary',
                },
                {
                  key: 'threadTranscript:mock-new-thread-1',
                  reason: 'sendAccepted',
                  threadId: 'mock-new-thread-1',
                  type: 'threadTranscript',
                },
              ],
              status: 'accepted',
              threadId: 'mock-new-thread-1',
              turnId: 'mock-new-turn-1',
            };
          case 'remux/codex/thread/message/fork':
            return {
              invalidations: [
                {
                  key: 'threadHistory:updated_at:desc:50::false:',
                  reason: 'forkAccepted',
                  type: 'threadHistory',
                },
                {
                  key: 'threadSummary:mock-fork-thread-1',
                  reason: 'forkAccepted',
                  threadId: 'mock-fork-thread-1',
                  type: 'threadSummary',
                },
                {
                  key: 'threadTranscript:mock-fork-thread-1',
                  reason: 'forkAccepted',
                  threadId: 'mock-fork-thread-1',
                  type: 'threadTranscript',
                },
              ],
              status: 'accepted',
              threadId: 'mock-fork-thread-1',
              turnId: 'mock-fork-turn-1',
            };
          case 'remux/codex/narration/start': {
            const params = request.params as {
              document?: {
                blocks?: Array<{ id?: string; displayText?: string; targetIds?: string[] }>;
                targets?: Array<{ id?: string; blockId?: string; kind?: string; role?: string }>;
              };
              target?: Record<string, unknown>;
            };
            const blocks = params.document?.blocks ?? [];
            const targets = params.document?.targets ?? [];
            const artifactKey = `mock-narration-${String(params.target?.assistantMessageId ?? 'assistant')}`;
            const units = blocks.map((block, index) => ({
              blockId: block.id ?? `md:${index}`,
              chunkId: '000',
              end: index + 0.9,
              fallbackTargetIds: [block.targetIds?.find((id) => id.endsWith('/target/block')) ?? `${block.id}/target/block`],
              id: `unit:${block.id ?? `md:${index}`}`,
              mode: 'verbatim',
              sentenceRanges: [{ end: index + 0.9, spokenEnd: block.displayText?.length ?? 0, spokenStart: 0, start: index }],
              spokenText: block.displayText ?? '',
              start: index,
            }));
            const cues = blocks.map((block, index) => {
              const wordTarget = targets.find((target) => target.blockId === block.id && target.kind === 'textRange' && target.role === 'word');
              const semanticTarget = targets.find((target) => target.blockId === block.id && (target.kind === 'tableCell' || target.kind === 'codeLines'));
              const activeTarget = semanticTarget ?? wordTarget;
              return {
                confidence: 0.98,
                end: index + 0.8,
                granularity: semanticTarget ? semanticTarget.kind : 'word',
                id: `unit:${block.id}/cue/0`,
                origin: 'deterministic',
                spokenEnd: Math.min(4, block.displayText?.length ?? 0),
                spokenStart: 0,
                start: index + 0.1,
                targetIds: [activeTarget?.id ?? block.targetIds?.[0]],
                unitId: `unit:${block.id ?? `md:${index}`}`,
              };
            });
            const manifest = {
              alignmentKey: 'mock-alignment-v2',
              artifactKey,
              audioKey: 'mock-audio-v2',
              chunks: [{ end: Math.max(1, units.length), id: '000', sampleRate: 24000, sizeBytes: 44, start: 0 }],
              cues,
              durationSeconds: Math.max(1, units.length),
              profile: {
                aligner: { algorithmVersion: '2', provider: 'mock' },
                id: 'mock-v2',
                scriptGenerator: { model: 'mock', promptVersion: '2', provider: 'mock' },
                synthesizer: { model: 'mock', modelRevision: '2', optionsVersion: '2', provider: 'mock', sampleRate: 24000, voice: 'mock' },
              },
              scriptKey: 'mock-script-v2',
              sourceDocumentKey: 'mock-source-v2',
              sourceHash: params.target?.sourceHash,
              targets,
              units,
              version: 2,
            };
            const resource = {
              artifactKey,
              completedUnits: narrationStatus === 'ready' ? blocks.length : null,
              error: null,
              manifest: narrationStatus === 'ready' ? manifest : null,
              revision: '1',
              stage: narrationStatus === 'ready' ? null : 'planning',
              status: narrationStatus,
              target: params.target,
              totalUnits: narrationStatus === 'ready' ? blocks.length : null,
            };
            narrationResources.set(artifactKey, resource);
            return { artifactKey, resource, status: 'accepted' };
          }
          case 'remux/codex/narration/resources/read': {
            const artifactKey = (request.params as { artifactKey?: string }).artifactKey ?? '';
            const resource = narrationResources.get(artifactKey) ?? null;
            return { resource, status: resource ? 'ok' : 'missing' };
          }
          case 'remux/codex/narration/cancel':
            return {
              artifactKey: (request.params as { artifactKey?: string }).artifactKey,
              status: 'accepted',
            };
          case 'remux/codex/narration/audio/read':
            return {
              artifactKey: (request.params as { artifactKey?: string }).artifactKey,
              chunkId: '000',
              dataBase64: silentWavBase64(3),
              mimeType: 'audio/wav',
              sizeBytes: 44,
            };
          case 'host/viewport/get':
            return {
              keyboardHeight: 0,
              keyboardVisible: false,
              visibleBottom: window.innerHeight,
              visibleTop: 0,
              viewportHeight: window.innerHeight,
              viewportWidth: window.innerWidth,
            };
          case 'host/attachments/pick':
            return {
              assets: attachments,
              canceled: false,
            };
          case 'remux/codex/files': {
            const params =
              request.params && typeof request.params === 'object'
                ? (request.params as { requests?: unknown })
                : {};
            const requests = Array.isArray(params.requests) ? params.requests : [];

            return {
              resources: requests.map((resourceRequest, requestIndex) => {
                const typedRequest =
                  resourceRequest && typeof resourceRequest === 'object'
                    ? (resourceRequest as {
                        path?: unknown;
                        query?: unknown;
                        roots?: unknown;
                        type?: unknown;
                      })
                    : {};
                const key = `${String(typedRequest.type)}:${String(typedRequest.path ?? typedRequest.query ?? '')}`;

                if (typedRequest.type === 'fileSearch') {
                  const query = typeof typedRequest.query === 'string' ? typedRequest.query.toLowerCase() : '';
                  return {
                    key,
                    requestIndex,
                    revision: 'mock-files-revision',
                    status: 'ok',
                    value: {
                      query,
                      results: files
                        .filter((entry) => entry.path.toLowerCase().includes(query))
                        .map((entry, index) => {
                          const normalizedPath = entry.path.replace(/^\/+/, '');
                          const name = normalizedPath.split('/').pop() ?? normalizedPath;
                          const parentPath = normalizedPath.includes('/')
                            ? normalizedPath.slice(0, normalizedPath.lastIndexOf('/'))
                            : '';
                          return {
                            absolutePath: `${cwd}/${normalizedPath}`,
                            id: `${cwd}:${normalizedPath}`,
                            kind: (entry as { isDirectory?: boolean }).isDirectory ? 'directory' : 'file',
                            name,
                            parentPath,
                            path: normalizedPath,
                            score: 100 - index,
                          };
                        }),
                      revision: 'mock-files-revision',
                      roots: Array.isArray(typedRequest.roots) ? typedRequest.roots : [cwd],
                    },
                  };
                }

                if (typedRequest.type === 'directoryDetails') {
                  return {
                    key,
                    requestIndex,
                    revision: 'mock-directory-details-revision',
                    status: 'ok',
                    value: {
                      isDirectory: true,
                      itemCount: 0,
                      modifiedAtMs: 1782000000000,
                      path: typeof typedRequest.path === 'string' ? typedRequest.path : cwd,
                      revision: 'mock-directory-details-revision',
                      sizeBytes: null,
                    },
                  };
                }

                if (typedRequest.type === 'fileBytes') {
                  return {
                    key,
                    requestIndex,
                    revision: 'mock-file-bytes-revision',
                    status: 'ok',
                    value: {
                      dataBase64: '',
                      path: typeof typedRequest.path === 'string' ? typedRequest.path : '',
                      revision: 'mock-file-bytes-revision',
                      sizeBytes: 0,
                    },
                  };
                }

                return {
                  key,
                  requestIndex,
                  revision: 'mock-directory-listing-revision',
                  status: 'ok',
                  value: {
                    entries: [],
                    path: typeof typedRequest.path === 'string' ? typedRequest.path : cwd,
                    revision: 'mock-directory-listing-revision',
                  },
                };
              }),
            };
          }
          default:
            return null;
        }
      }

      Object.defineProperty(window, '__remuxWebViewMessages', {
        configurable: true,
        value: capturedMessages,
      });

      Object.defineProperty(window, 'ReactNativeWebView', {
        configurable: true,
        value: {
          postMessage(rawMessage: string) {
            const request = JSON.parse(rawMessage) as HostRequest;
            capturedMessages.push(request);

            if (request.type === 'ready' || request.type === 'remux/ready') {
              dispatchHostMessage({
                error: null,
                status: {
                  cwd,
                  type: 'connected',
                  websocketUrl: 'ws://127.0.0.1:48124',
                },
                type: 'remux/status',
              });
              dispatchHostMessage({
                lifecycle: { epoch: 1, reason: 'connect', state: 'active' },
                type: 'remux/lifecycle',
              });
              return;
            }

            if (request.id != null && request.method) {
              const message = commandErrors[request.method];
              if (message) {
                postError(request, message);
                return;
              }

              postResult(request, resultFor(request));
            }
          },
        },
      });
    },
    {
      attachments,
      commandErrors,
      cwd,
      files: fuzzyFiles,
      narrationStatus,
      runtime,
      sendUpdatesTranscript,
      threadCwd,
      tokenUsage,
      transcriptReadDelayMs,
      transcriptV2,
      turns,
      workDetails,
      workItems,
    },
  );
}

async function capturedHostMethods(page: Page) {
  return page.evaluate(() =>
    ((window as unknown as { __remuxWebViewMessages?: HostRequest[] }).__remuxWebViewMessages ?? [])
      .map((message) => message.method ?? message.type)
      .filter(Boolean),
  );
}

async function capturedHostRequests(page: Page) {
  return page.evaluate(() =>
    ((window as unknown as { __remuxWebViewMessages?: HostRequest[] }).__remuxWebViewMessages ?? []),
  );
}

function hasFileResourceRequest(params: unknown, expected: { path: string; type: string }) {
  if (!params || typeof params !== 'object') {
    return false;
  }

  const requests = (params as { requests?: unknown }).requests;
  if (!Array.isArray(requests)) {
    return false;
  }

  return requests.some((request) => {
    if (!request || typeof request !== 'object') {
      return false;
    }

    const typedRequest = request as { path?: unknown; type?: unknown };
    return typedRequest.path === expected.path && typedRequest.type === expected.type;
  });
}

test.describe('codex viewer route', () => {
  test('version two renders commentary between work groups without item fan-out', async ({ page }) => {
    const turn = {
      completedAt: 20,
      durationMs: 10,
      error: null,
      id: 'turn-v2-work',
      revision: 'turn-v2-work-revision',
      segments: [
        {
          content: [{ text: 'Inspect this', text_elements: [], type: 'text' as const }],
          id: 'user-v2',
          revision: 'user-v2-revision',
          type: 'userMessage' as const,
        },
        {
          durationMs: 10,
          hasDetails: true,
          id: 'work-v2',
          layoutRevision: 'work-v2-layout',
          revision: 'work-v2-revision',
          state: 'completed' as const,
          timeline: [
            {
              groupType: 'tools' as const,
              hasMoreRows: false,
              id: 'group-tools-one',
              revision: 'group-tools-one-revision',
              rowCount: 1,
              status: 'completed' as const,
              title: 'Tools',
              type: 'group' as const,
            },
            {
              id: 'commentary-v2',
              phase: 'commentary' as const,
              revision: 'commentary-v2-revision',
              text: 'The first result changes the next step.',
              type: 'message' as const,
            },
            {
              groupType: 'tools' as const,
              hasMoreRows: false,
              id: 'group-tools-two',
              revision: 'group-tools-two-revision',
              rowCount: 1,
              status: 'completed' as const,
              title: 'Tools',
              type: 'group' as const,
            },
          ],
          type: 'work' as const,
        },
        {
          id: 'assistant-v2',
          phase: 'final_answer' as const,
          revision: 'assistant-v2-revision',
          text: 'Finished.',
          type: 'assistantMessage' as const,
        },
      ],
      startedAt: 10,
      status: 'completed' as const,
    } satisfies CodexTranscriptTurn;

    await installMockRemuxHost(page, { transcriptV2: true, turns: [turn] });
    await page.goto('/viewers/codex/?remuxResourceKind=thread&remuxResourceId=mock-thread-1');
    await page.getByTestId('work-section-work-v2').click();

    await expect(page.getByText('The first result changes the next step.')).toBeVisible();
    await expect(page.locator('[data-work-group-ids^="group-tools-"]')).toHaveCount(2);
    await page.locator('[data-work-group-ids="group-tools-one"]').click();
    await expect(page.getByText('Mock tool call')).toBeVisible();
    await page.getByTestId('work-row-v2-row:group-tools-one').click();
    await expect(page.getByText('Mock result')).toBeVisible();
    const transcriptRequests = await page.evaluate(() =>
      ((window as typeof window & { __remuxWebViewMessages?: HostRequest[] }).__remuxWebViewMessages ?? [])
        .filter((message) => message.method === 'remux/codex/transcript/resources/read'));
    const requestTypes = transcriptRequests.flatMap((message) => {
      const params = message.params as { requests?: Array<{ type?: string }> } | undefined;
      return params?.requests?.map((request) => request.type) ?? [];
    });
    expect(requestTypes).toContain('transcriptSync');
    expect(requestTypes.filter((type) => type === 'workGroup')).toHaveLength(1);
    expect(requestTypes.filter((type) => type === 'workEntryDetail')).toHaveLength(1);
    expect(requestTypes).not.toContain('turn');
    expect(requestTypes).not.toContain('workDetails');
    expect(requestTypes).not.toContain('workItem');
  });

  test('groups adjacent Version 2 actions into one deterministic summary', async ({ page }) => {
    const base = completedTurn({ turnId: 'turn-action-run-v2' });
    const turn: CodexTranscriptTurn = {
      ...base,
      segments: [
        base.segments[0]!,
        {
          durationMs: 500,
          hasDetails: true,
          id: 'work-action-run-v2',
          revision: 'work-action-run-v2-revision',
          state: 'completed',
          timeline: [
            {
              id: 'commentary-action-run-v2',
              phase: null,
              revision: 'commentary-action-run-v2-revision',
              text: 'I applied and verified the change.',
              type: 'message',
            },
            {
              groupType: 'tools',
              hasMoreRows: false,
              id: 'group-tools-action-run-v2',
              revision: 'group-tools-action-run-v2-revision',
              rowCount: 3,
              status: 'completed',
              summary: { commands: 3, fileNames: [], files: 0, reads: 0, searches: 0, tools: 0 },
              title: 'Tools',
              type: 'group',
            },
            {
              groupType: 'files',
              hasMoreRows: false,
              id: 'group-files-action-run-v2',
              revision: 'group-files-action-run-v2-revision',
              rowCount: 2,
              status: 'completed',
              summary: {
                commands: 0,
                fileNames: ['/repo/src/app.rs', '/repo/deploy/systemd.rs'],
                files: 2,
                reads: 0,
                searches: 0,
                tools: 0,
              },
              title: 'Changed files',
              type: 'group',
            },
          ],
          type: 'work',
        },
        base.segments[1]!,
      ],
    };
    await installMockRemuxHost(page, { transcriptV2: true, turns: [turn] });
    await page.goto('/viewers/codex/?remuxResourceKind=thread&remuxResourceId=mock-thread-1');
    await page.getByTestId('work-section-work-action-run-v2').click();

    const actionRun = page.locator('[data-work-group-ids="group-tools-action-run-v2 group-files-action-run-v2"]');
    await expect(actionRun).toHaveCount(1);
    await expect(actionRun).toContainText('Ran 3 commands, edited app.rs and systemd.rs');
  });

  test('defers transcript invalidations in background and verifies once active', async ({ page }) => {
    await installMockRemuxHost(page, { transcriptV2: true, turns: [completedTurn()] });
    await page.goto('/viewers/codex/?remuxResourceKind=thread&remuxResourceId=mock-thread-1');
    await expect(page.getByText('mock assistant response')).toBeVisible();

    const syncCount = () => page.evaluate(() =>
      ((window as typeof window & { __remuxWebViewMessages?: HostRequest[] }).__remuxWebViewMessages ?? [])
        .filter((message) => {
          if (message.method !== 'remux/codex/transcript/resources/read') return false;
          const params = message.params as { requests?: Array<{ type?: string }> } | undefined;
          return params?.requests?.some((request) => request.type === 'transcriptSync') === true;
        }).length);
    const before = await syncCount();

    await page.evaluate(() => {
      const dispatch = (message: unknown) => window.dispatchEvent(new MessageEvent('message', {
        data: JSON.stringify(message),
      }));
      dispatch({
        lifecycle: { epoch: 1, reason: 'appState', state: 'background' },
        type: 'remux/lifecycle',
      });
      dispatch({
        message: {
          jsonrpc: '2.0',
          method: 'remux/codex/resources/invalidated',
          params: {
            invalidations: [{
              affectsLayout: true,
              affectsOrder: false,
              key: 'transcriptSync:mock-thread-1',
              reason: 'appServerEvent',
              threadId: 'mock-thread-1',
              turnId: 'mock-turn-completed',
              type: 'transcript',
            }],
          },
        },
        type: 'remux/event',
      });
    });
    await page.waitForTimeout(300);
    expect(await syncCount()).toBe(before);

    await page.evaluate(() => {
      window.dispatchEvent(new MessageEvent('message', {
        data: JSON.stringify({
          lifecycle: { epoch: 2, reason: 'appState', state: 'active' },
          type: 'remux/lifecycle',
        }),
      }));
    });
    await expect.poll(syncCount).toBeGreaterThan(before);
  });

  test('appends a Version 2 turn from a live invalidation without reloading', async ({ page }) => {
    const completed = completedTurn();
    const running: CodexTranscriptTurn = {
      ...inProgressUserTurn({
        turnId: 'turn-live-2',
        userId: 'user-live-2',
        userText: 'new live user message',
      }),
      segments: [
        ...inProgressUserTurn({
          turnId: 'turn-live-2',
          userId: 'user-live-2',
          userText: 'new live user message',
        }).segments,
        {
          durationMs: null,
          hasDetails: true,
          id: 'work-live-2',
          revision: 'work-live-2-revision',
          state: 'running',
          timeline: [{
            id: 'work-live-message-2',
            phase: null,
            revision: 'work-live-message-2-revision',
            text: 'live work commentary',
            type: 'message',
          }],
          type: 'work',
        },
      ],
    };
    await installMockRemuxHost(page, { transcriptV2: true, turns: [completed] });
    await page.goto('/viewers/codex/?remuxResourceKind=thread&remuxResourceId=mock-thread-1');
    await expect(page.getByText('mock assistant response')).toBeVisible();

    await page.evaluate(({ completed, running }) => {
      const mockWindow = window as typeof window & {
        __remuxDispatchMockHostMessage?: (message: unknown) => void;
        __remuxSetMockTranscriptTurns?: (turns: CodexTranscriptTurn[]) => void;
      };
      mockWindow.__remuxSetMockTranscriptTurns?.([completed, running]);
      mockWindow.__remuxDispatchMockHostMessage?.({
        message: {
          jsonrpc: '2.0',
          method: 'remux/codex/resources/invalidated',
          params: {
            invalidations: [{
              affectsLayout: true,
              affectsOrder: true,
              key: 'transcriptSync:mock-thread-1',
              reason: 'appServerEvent',
              threadId: 'mock-thread-1',
              turnId: 'turn-live-2',
              type: 'transcript',
            }],
          },
        },
        type: 'remux/event',
      });
    }, { completed, running });

    await expect(page.getByText('new live user message')).toBeVisible();
    await expect(page.getByTestId('work-section-work-live-2')).toBeVisible();
    const latestWindow = await page.evaluate(() => {
      const requests = ((window as typeof window & { __remuxWebViewMessages?: HostRequest[] }).__remuxWebViewMessages ?? [])
        .filter((message) => message.method === 'remux/codex/transcript/resources/read');
      const params = requests.at(-1)?.params as { requests?: Array<{ window?: unknown }> } | undefined;
      return params?.requests?.find((request) => request.window)?.window;
    });
    expect(latestWindow).toMatchObject({ kind: 'tail' });
  });

  test('keeps an in-flight sent-turn tail sync authoritative over trailing streaming refreshes', async ({ page }) => {
    const turns = Array.from({ length: 60 }, (_, index) => completedTurn({
      assistantId: `assistant-${index + 1}`,
      assistantText: `completed response ${index + 1}`,
      turnId: `turn-${index + 1}`,
      userId: `user-${index + 1}`,
      userText: `completed prompt ${index + 1}`,
    }));
    await installMockRemuxHost(page, {
      sendUpdatesTranscript: true,
      transcriptReadDelayMs: 180,
      transcriptV2: true,
      turns,
    });
    await page.goto('/viewers/codex/?remuxResourceKind=thread&remuxResourceId=mock-thread-1');
    await expect(page.getByText('completed response 60')).toBeVisible();

    const transcriptSyncCount = () => page.evaluate(() =>
      ((window as typeof window & { __remuxWebViewMessages?: HostRequest[] }).__remuxWebViewMessages ?? [])
        .filter((message) => {
          if (message.method !== 'remux/codex/transcript/resources/read') return false;
          const params = message.params as { requests?: Array<{ type?: string }> } | undefined;
          return params?.requests?.some((request) => request.type === 'transcriptSync') === true;
        }).length);
    const syncsBeforeSend = await transcriptSyncCount();

    const editor = page.locator('.remux-composer-contenteditable');
    await editor.click();
    await editor.pressSequentially('sent while transcript syncs overlap');
    await page.getByRole('button', { name: 'Send message' }).click();
    await expect.poll(transcriptSyncCount).toBeGreaterThan(syncsBeforeSend);

    await page.evaluate(() => {
      const mockWindow = window as typeof window & {
        __remuxDispatchMockHostMessage?: (message: unknown) => void;
      };
      mockWindow.__remuxDispatchMockHostMessage?.({
        message: {
          jsonrpc: '2.0',
          method: 'remux/codex/resources/invalidated',
          params: {
            invalidations: [{
              affectsLayout: true,
              affectsOrder: false,
              key: 'transcriptSync:mock-thread-1',
              reason: 'appServerEvent',
              threadId: 'mock-thread-1',
              turnId: 'mock-sent-turn-1',
              type: 'transcript',
            }],
          },
        },
        type: 'remux/event',
      });
    });

    await expect(page.getByText('sent while transcript syncs overlap')).toBeVisible();
    await expect(page.locator('[data-row-kind="userMessage"][data-turn-id="mock-sent-turn-1"]')).toBeVisible();
  });

  test('keeps a sent user message anchored when work collapses and assistant output starts', async ({ page }) => {
    const initialTurns = Array.from({ length: 12 }, (_, index) => completedTurn({
      assistantId: `assistant-anchor-${index}`,
      assistantText: `completed anchor response ${index}\n\n${'history '.repeat(80)}`,
      turnId: `turn-anchor-${index}`,
      userId: `user-anchor-${index}`,
      userText: `completed anchor prompt ${index}`,
    }));
    await installMockRemuxHost(page, {
      sendUpdatesTranscript: true,
      transcriptV2: true,
      turns: initialTurns,
    });
    await page.goto('/viewers/codex/?remuxResourceKind=thread&remuxResourceId=mock-thread-1');
    await expect(page.getByText('completed anchor response 11')).toBeVisible();

    const editor = page.locator('.remux-composer-contenteditable');
    await editor.click();
    await editor.pressSequentially('message whose anchor survives collapse');
    await page.getByRole('button', { name: 'Send message' }).click();
    const sentRow = page.locator('[data-row-kind="userMessage"][data-turn-id="mock-sent-turn-1"]');
    await expect(sentRow).toBeVisible();

    const publishTurn = async (assistantStarted: boolean) => {
      await page.evaluate(({ assistantStarted, initialTurns }) => {
        const mockWindow = window as typeof window & {
          __remuxDispatchMockHostMessage?: (message: unknown) => void;
          __remuxSetMockTranscriptTurns?: (turns: CodexTranscriptTurn[]) => void;
          __remuxWebViewMessages?: HostRequest[];
        };
        const sendRequest = [...(mockWindow.__remuxWebViewMessages ?? [])]
          .reverse()
          .find((message) => message.method === 'remux/codex/thread/message/send');
        const clientMessageId = (sendRequest?.params as { clientMessageId?: string } | undefined)?.clientMessageId;
        if (!clientMessageId) throw new Error('missing client message id');
        const work = {
          durationMs: assistantStarted ? 900 : null,
          hasDetails: true,
          id: 'work-anchor-live',
          revision: assistantStarted ? 'work-anchor-complete' : 'work-anchor-running',
          state: assistantStarted ? 'completed' as const : 'running' as const,
          timeline: [{
            id: 'work-anchor-commentary',
            phase: null,
            revision: assistantStarted ? 'commentary-complete' : 'commentary-running',
            text: Array.from({ length: 80 }, (_, index) => `Work line ${index}`).join('\n\n'),
            type: 'message' as const,
          }],
          type: 'work' as const,
        };
        const liveTurn: CodexTranscriptTurn = {
          completedAt: null,
          durationMs: null,
          error: null,
          id: 'mock-sent-turn-1',
          revision: assistantStarted ? 'anchor-turn-assistant' : 'anchor-turn-work',
          segments: [
            {
              // The authoritative segment keeps its server-assigned id; the
              // composer id only ever appears as clientId.
              clientId: clientMessageId,
              content: [{
                text: 'message whose anchor survives collapse',
                text_elements: [],
                type: 'text',
              }],
              id: 'mock-sent-user-1',
              revision: 'user:mock-sent-user-1',
              type: 'userMessage',
            },
            work,
            ...(assistantStarted ? [{
              id: 'assistant-anchor-live',
              phase: null,
              revision: 'assistant-anchor-live-revision',
              text: 'Assistant output has started.',
              type: 'assistantMessage' as const,
            }] : []),
          ],
          startedAt: Date.now(),
          status: 'inProgress',
        };
        mockWindow.__remuxSetMockTranscriptTurns?.([...initialTurns, liveTurn]);
        mockWindow.__remuxDispatchMockHostMessage?.({
          message: {
            jsonrpc: '2.0',
            method: 'remux/codex/resources/invalidated',
            params: {
              invalidations: [{
                affectsLayout: true,
                affectsOrder: false,
                key: 'transcriptSync:mock-thread-1',
                reason: 'appServerEvent',
                threadId: 'mock-thread-1',
                turnId: 'mock-sent-turn-1',
                type: 'transcript',
              }],
            },
          },
          type: 'remux/event',
        });
      }, { assistantStarted, initialTurns });
    };

    await publishTurn(false);
    await expect(page.getByText('Work line 79')).toBeVisible();
    const viewport = page.locator('.remux-transcript-viewport');
    const rowOffset = () => sentRow.evaluate((row) => {
      const viewport = document.querySelector<HTMLElement>('.remux-transcript-viewport')!;
      return row.getBoundingClientRect().top - viewport.getBoundingClientRect().top;
    });
    await expect.poll(rowOffset).toBeLessThan(80);
    const anchoredOffset = await rowOffset();

    await viewport.evaluate((node) => node.dispatchEvent(new Event('scrollend')));
    await page.evaluate(() => {
      window.dispatchEvent(new MessageEvent('message', {
        data: JSON.stringify({
          lifecycle: { epoch: 10, reason: 'appState', state: 'background' },
          type: 'remux/lifecycle',
        }),
      }));
    });
    await publishTurn(true);
    await page.waitForTimeout(150);
    await expect(page.getByText('Assistant output has started.')).toHaveCount(0);
    await page.evaluate(() => {
      window.dispatchEvent(new MessageEvent('message', {
        data: JSON.stringify({
          lifecycle: { epoch: 11, reason: 'appState', state: 'active' },
          type: 'remux/lifecycle',
        }),
      }));
    });
    await expect(page.getByText('Assistant output has started.')).toBeVisible();
    await expect.poll(async () => Math.abs((await rowOffset()) - anchoredOffset)).toBeLessThanOrEqual(2);
  });

  test('releases a sent message anchor pinned in a shrunken viewport once it grows', async ({ page }) => {
    const initialTurns = Array.from({ length: 6 }, (_, index) => completedTurn({
      assistantId: `assistant-shrunk-${index}`,
      assistantText: `completed shrunk response ${index}\n\n${'history '.repeat(40)}`,
      turnId: `turn-shrunk-${index}`,
      userId: `user-shrunk-${index}`,
      userText: `completed shrunk prompt ${index}`,
    }));
    await installMockRemuxHost(page, {
      sendUpdatesTranscript: true,
      transcriptV2: true,
      turns: initialTurns,
    });
    // Mimic the keyboard-open state: the transcript viewport is at its
    // smallest exactly when a message is sent.
    await page.setViewportSize({ height: 360, width: 390 });
    await page.goto('/viewers/codex/?remuxResourceKind=thread&remuxResourceId=mock-thread-1');
    await expect(page.getByText('completed shrunk response 5')).toBeVisible();

    const editor = page.locator('.remux-composer-contenteditable');
    await editor.click();
    await editor.pressSequentially('message pinned only while shrunken');
    await page.getByRole('button', { name: 'Send message' }).click();
    const sentRow = page.locator('[data-row-kind="userMessage"][data-turn-id="mock-sent-turn-1"]');
    await expect(sentRow).toBeVisible();

    const publishWork = async (lineCount: number) => {
      await page.evaluate(({ initialTurns, lineCount }) => {
        const mockWindow = window as typeof window & {
          __remuxDispatchMockHostMessage?: (message: unknown) => void;
          __remuxSetMockTranscriptTurns?: (turns: CodexTranscriptTurn[]) => void;
          __remuxWebViewMessages?: HostRequest[];
        };
        const sendRequest = [...(mockWindow.__remuxWebViewMessages ?? [])]
          .reverse()
          .find((message) => message.method === 'remux/codex/thread/message/send');
        const clientMessageId = (sendRequest?.params as { clientMessageId?: string } | undefined)?.clientMessageId;
        if (!clientMessageId) throw new Error('missing client message id');
        const liveTurn: CodexTranscriptTurn = {
          completedAt: null,
          durationMs: null,
          error: null,
          id: 'mock-sent-turn-1',
          revision: `shrunk-turn-${lineCount}`,
          segments: [
            {
              clientId: clientMessageId,
              content: [{
                text: 'message pinned only while shrunken',
                text_elements: [],
                type: 'text',
              }],
              id: 'mock-sent-user-1',
              revision: 'user:mock-sent-user-1',
              type: 'userMessage',
            },
            {
              durationMs: null,
              hasDetails: true,
              id: 'work-shrunk-live',
              revision: `work-shrunk-${lineCount}`,
              state: 'running' as const,
              timeline: [{
                id: 'work-shrunk-commentary',
                phase: null,
                revision: `commentary-shrunk-${lineCount}`,
                text: Array.from({ length: lineCount }, (_, index) => `Shrunk work line ${index}`).join('\n\n'),
                type: 'message' as const,
              }],
              type: 'work' as const,
            },
          ],
          startedAt: Date.now(),
          status: 'inProgress',
        };
        mockWindow.__remuxSetMockTranscriptTurns?.([...initialTurns, liveTurn]);
        mockWindow.__remuxDispatchMockHostMessage?.({
          message: {
            jsonrpc: '2.0',
            method: 'remux/codex/resources/invalidated',
            params: {
              invalidations: [{
                affectsLayout: true,
                affectsOrder: false,
                key: 'transcriptSync:mock-thread-1',
                reason: 'appServerEvent',
                threadId: 'mock-thread-1',
                turnId: 'mock-sent-turn-1',
                type: 'transcript',
              }],
            },
          },
          type: 'remux/event',
        });
      }, { initialTurns, lineCount });
    };

    const rowOffset = () => sentRow.evaluate((row) => {
      const viewport = document.querySelector<HTMLElement>('.remux-transcript-viewport')!;
      return row.getBoundingClientRect().top - viewport.getBoundingClientRect().top;
    });

    await publishWork(8);
    await expect(page.getByText('Shrunk work line 7')).toBeVisible();
    await expect.poll(rowOffset).toBeLessThan(80);

    // The keyboard closes: the viewport grows back and the early pin must
    // release to bottom-following instead of holding blank runway space.
    await page.setViewportSize({ height: 900, width: 390 });
    await expect.poll(rowOffset).toBeGreaterThan(120);
    const viewport = page.locator('.remux-transcript-viewport');
    await expect.poll(() => viewport.evaluate((node) =>
      node.scrollHeight - node.clientHeight - node.scrollTop)).toBeLessThanOrEqual(4);

    // Once real content fills the grown viewport, the anchor pins again.
    await publishWork(60);
    await expect(page.getByText('Shrunk work line 59')).toBeVisible();
    await expect.poll(rowOffset).toBeLessThan(80);
  });

  test('refreshes a visible Version 2 turn from a streaming invalidation', async ({ page }) => {
    const running: CodexTranscriptTurn = {
      ...inProgressUserTurn({ turnId: 'turn-stream-1' }),
      revision: 'turn-stream-1-revision-a',
      segments: [
        ...inProgressUserTurn({ turnId: 'turn-stream-1' }).segments,
        {
          id: 'assistant-stream-1',
          phase: null,
          revision: 'assistant-stream-1-revision-a',
          text: 'first streamed text',
          type: 'assistantMessage',
        },
      ],
    };
    await installMockRemuxHost(page, {
      transcriptReadDelayMs: 40,
      transcriptV2: true,
      turns: [running],
    });
    await page.goto('/viewers/codex/?remuxResourceKind=thread&remuxResourceId=mock-thread-1');
    await expect(page.getByText('first streamed text')).toBeVisible();

    const updated: CodexTranscriptTurn = {
      ...running,
      revision: 'turn-stream-1-revision-b',
      segments: running.segments.map((segment) => segment.type === 'assistantMessage'
        ? {
            ...segment,
            revision: 'assistant-stream-1-revision-b',
            text: 'updated streamed text',
          }
        : segment),
    };
    await page.evaluate((updatedTurn) => {
      const mockWindow = window as typeof window & {
        __remuxDispatchMockHostMessage?: (message: unknown) => void;
        __remuxSetMockTranscriptTurns?: (turns: CodexTranscriptTurn[]) => void;
      };
      mockWindow.__remuxSetMockTranscriptTurns?.([updatedTurn]);
      mockWindow.__remuxDispatchMockHostMessage?.({
        message: {
          jsonrpc: '2.0',
          method: 'remux/codex/resources/invalidated',
          params: {
            invalidations: [{
              affectsLayout: true,
              affectsOrder: false,
              key: 'transcriptSync:mock-thread-1',
              reason: 'appServerEvent',
              threadId: 'mock-thread-1',
              turnId: 'turn-stream-1',
              type: 'transcript',
            }],
          },
        },
        type: 'remux/event',
      });
    }, updated);

    await expect(page.getByText('updated streamed text')).toBeVisible();
    await expect(page.getByText('first streamed text')).toHaveCount(0);

    const finalUpdate: CodexTranscriptTurn = {
      ...updated,
      revision: 'turn-stream-1-revision-c',
      segments: updated.segments.map((segment) => segment.type === 'assistantMessage'
        ? {
            ...segment,
            revision: 'assistant-stream-1-revision-c',
            text: 'final coalesced streamed text',
          }
        : segment),
    };
    await page.evaluate((updatedTurn) => {
      const mockWindow = window as typeof window & {
        __remuxDispatchMockHostMessage?: (message: unknown) => void;
        __remuxSetMockTranscriptTurns?: (turns: CodexTranscriptTurn[]) => void;
      };
      mockWindow.__remuxSetMockTranscriptTurns?.([updatedTurn]);
      mockWindow.__remuxDispatchMockHostMessage?.({
        message: {
          jsonrpc: '2.0',
          method: 'remux/codex/resources/invalidated',
          params: {
            invalidations: [{
              affectsLayout: true,
              affectsOrder: false,
              key: 'transcriptSync:mock-thread-1',
              reason: 'appServerEvent',
              threadId: 'mock-thread-1',
              turnId: 'turn-stream-1',
              type: 'transcript',
            }],
          },
        },
        type: 'remux/event',
      });
    }, finalUpdate);

    await expect(page.getByText('final coalesced streamed text')).toBeVisible();
    const latestWindow = await page.evaluate(() => {
      const requests = ((window as typeof window & { __remuxWebViewMessages?: HostRequest[] }).__remuxWebViewMessages ?? [])
        .filter((message) => message.method === 'remux/codex/transcript/resources/read');
      const params = requests.at(-1)?.params as { requests?: Array<{ type?: string; window?: unknown }> } | undefined;
      return params?.requests?.find((request) => request.type === 'transcriptSync')?.window;
    });
    expect(latestWindow).toEqual({
      endTurnId: 'turn-stream-1',
      kind: 'range',
      startTurnId: 'turn-stream-1',
    });
  });

  test('pages only after a user scroll and preserves the mounted row anchor', async ({ page }) => {
    const turns = Array.from({ length: 60 }, (_, index) => completedTurn({
      assistantId: `assistant-window-${index}`,
      assistantText: `assistant window response ${index}`,
      turnId: `turn-window-${String(index).padStart(2, '0')}`,
      userId: `user-window-${index}`,
      userText: `user window prompt ${index}`,
    }));
    await installMockRemuxHost(page, { transcriptV2: true, turns });
    await page.goto('/viewers/codex/?remuxResourceKind=thread&remuxResourceId=mock-thread-1');
    await expect(page.getByText('assistant window response 59')).toBeVisible();

    const syncCount = () => page.evaluate(() =>
      ((window as typeof window & { __remuxWebViewMessages?: HostRequest[] }).__remuxWebViewMessages ?? [])
        .filter((message) => {
          if (message.method !== 'remux/codex/transcript/resources/read') return false;
          const params = message.params as { requests?: Array<{ type?: string }> } | undefined;
          return params?.requests?.some((request) => request.type === 'transcriptSync') === true;
        }).length);
    await expect.poll(syncCount).toBe(1);

    const viewport = page.locator('.remux-transcript-viewport');
    await viewport.evaluate((node) => {
      node.scrollTop = 0;
      node.dispatchEvent(new Event('scrollend'));
    });
    await page.waitForTimeout(250);
    expect(await syncCount()).toBe(1);

    const anchor = page.locator('[data-transcript-row-id^="turn-window-36:"]').first();
    await expect(anchor).toBeVisible();
    const beforeTop = await anchor.evaluate((node) => node.getBoundingClientRect().top);
    await viewport.evaluate((node) => {
      node.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -12 }));
      node.dispatchEvent(new Event('scrollend'));
    });
    await expect.poll(syncCount).toBe(2);
    const lastSyncWindow = await page.evaluate(() => {
      const requests = ((window as typeof window & { __remuxWebViewMessages?: HostRequest[] }).__remuxWebViewMessages ?? [])
        .filter((message) => message.method === 'remux/codex/transcript/resources/read');
      const params = requests.at(-1)?.params as { requests?: Array<{ window?: unknown }> } | undefined;
      return params?.requests?.[0]?.window;
    });
    expect(lastSyncWindow).toMatchObject({
      before: 16,
      kind: 'around',
      turnId: 'turn-window-36',
    });
    const afterTop = await anchor.evaluate((node) => node.getBoundingClientRect().top);
    expect(Math.abs(afterTop - beforeTop)).toBeLessThanOrEqual(1);
  });

  test('contains pathological markdown width within the transcript viewport', async ({ page }) => {
    const longToken = 'unbroken-path-segment-'.repeat(80);
    const markdown = [
      `Normal text before ${longToken} after.`,
      '',
      '| Name | Value |',
      '| --- | --- |',
      `| path | ${longToken} |`,
      '',
      '```text',
      longToken,
      '```',
    ].join('\n');
    await installMockRemuxHost(page, {
      transcriptV2: true,
      turns: [completedTurn({ assistantText: markdown })],
    });
    await page.goto('/viewers/codex/?remuxResourceKind=thread&remuxResourceId=mock-thread-1');
    await expect(page.locator('.codex-md-code-block')).toBeVisible();

    const geometry = await page.evaluate(() => {
      const documentElement = document.documentElement;
      const viewport = document.querySelector<HTMLElement>('.remux-transcript-viewport');
      const markdown = document.querySelector<HTMLElement>('.codex-markdown');
      if (!viewport || !markdown) throw new Error('Transcript geometry is unavailable');
      const viewportBounds = viewport.getBoundingClientRect();
      const markdownBounds = markdown.getBoundingClientRect();
      return {
        documentClientWidth: documentElement.clientWidth,
        documentScrollWidth: documentElement.scrollWidth,
        markdownLeft: markdownBounds.left,
        markdownRight: markdownBounds.right,
        viewportLeft: viewportBounds.left,
        viewportRight: viewportBounds.right,
      };
    });
    expect(geometry.documentScrollWidth).toBeLessThanOrEqual(geometry.documentClientWidth + 1);
    expect(geometry.markdownLeft).toBeGreaterThanOrEqual(geometry.viewportLeft - 1);
    expect(geometry.markdownRight).toBeLessThanOrEqual(geometry.viewportRight + 1);
  });

  test('boots through the React Native WebView IPC bridge', async ({ page }, testInfo) => {
    await installMockRemuxHost(page);

    await page.goto('/viewers/codex/');

    await expect(page.getByText('No thread selected')).toBeVisible();
    if (testInfo.project.name === 'desktop') {
      await expect(page.getByRole('button', { name: /Mock thread/ })).toBeVisible();
    }
    await expect
      .poll(() => capturedHostMethods(page))
      .toContain('remux/ready');
    await expect
      .poll(() => capturedHostMethods(page))
      .toContain('remux/codex/thread/resources/read');
  });

  test('queries file resources for composer mentions', async ({ page }) => {
    await installMockRemuxHost(page);

    await page.goto('/viewers/codex/');

    const editor = page.locator('.remux-composer-contenteditable');
    await editor.click();
    await editor.pressSequentially('@pac');

    await expect(page.getByText('package.json').first()).toBeVisible();
    await expect
      .poll(() => capturedHostMethods(page))
      .toContain('remux/codex/files');
  });

  test('sends selected file mentions as structured message parts', async ({ page }) => {
    await installMockRemuxHost(page);

    await page.goto('/viewers/codex/?remuxResourceKind=thread&remuxResourceId=mock-thread-1');

    const editor = page.locator('.remux-composer-contenteditable');
    await editor.click();
    await editor.pressSequentially('Please review @pac');
    await expect(page.getByText('package.json').first()).toBeVisible();
    await page.keyboard.press('Enter');
    await editor.pressSequentially(' before sending');

    const sendButton = page.getByRole('button', { name: 'Send message' });
    await expect(sendButton).toBeEnabled();
    await sendButton.click();

    await expect
      .poll(() => capturedHostMethods(page))
      .toContain('remux/codex/thread/message/send');

    const requests = await capturedHostRequests(page);
    const sendRequest = requests.find((request) => request.method === 'remux/codex/thread/message/send');
    expect(sendRequest?.params).toMatchObject({
      parts: [
        { text: 'Please review ', type: 'text' },
        { name: 'package.json', path: 'package.json', type: 'mention' },
        { text: '  before sending', type: 'text' },
      ],
      threadId: 'mock-thread-1',
    });
  });

  test('renders GFM tables with DOM height matching the measured layout', async ({ page }) => {
    const tableMarkdown = [
      'Different projection shapes need different reading strategies:',
      '',
      '| Projection shape | Cache representation | Delivery read |',
      '| :--- | :---: | ---: |',
      '| Bars | Append-only array + live value + status | Read only unseen bar suffix and latest live bar |',
      '| Depth/DOM | Replaceable snapshot | Clone an `Arc<DepthSnapshot>` |',
      '',
      'Delivery continues after the table.',
    ].join('\n');
    await installMockRemuxHost(page, {
      turns: [completedTurn({ assistantText: tableMarkdown })],
    });

    await page.goto('/viewers/codex/?remuxResourceKind=thread&remuxResourceId=mock-thread-1');

    const assistantMarkdown = page.locator('[data-row-kind="assistantMessage"] .codex-markdown');
    const table = assistantMarkdown.getByRole('table');
    await expect(table).toBeVisible();
    await expect(table.getByRole('columnheader')).toHaveCount(3);
    await expect(table.getByRole('columnheader').nth(0)).toHaveText('Projection shape');
    await expect(table.getByRole('cell').nth(5)).toContainText('Arc<DepthSnapshot>');
    await expect.poll(async () =>
      (await table.locator('.codex-md-inline-code').allTextContents()).join('')
    ).toBe('Arc<DepthSnapshot>');
    await expect(table).not.toContainText('---');

    const geometry = await assistantMarkdown.evaluate((element) => {
      const root = element as HTMLElement;
      const scroll = root.querySelector<HTMLElement>('.codex-md-table-scroll');
      const tableNode = root.querySelector<HTMLElement>('.codex-md-table');
      if (!scroll || !tableNode) {
        throw new Error('Expected rendered table geometry');
      }
      const blockHeight = Array.from(root.children).reduce(
        (total, child) => total + (child as HTMLElement).getBoundingClientRect().height,
        0,
      );
      const rowHeight = Array.from(tableNode.querySelectorAll<HTMLElement>('.codex-md-table-row')).reduce(
        (total, row) => total + row.getBoundingClientRect().height,
        0,
      );

      return {
        blockHeight,
        modeledHeight: Number.parseFloat(root.style.height),
        rootHeight: root.getBoundingClientRect().height,
        rowHeight,
        scrollHeight: scroll.getBoundingClientRect().height,
        tableBorderWidth: Number.parseFloat(getComputedStyle(tableNode).borderTopWidth),
        tableHeight: tableNode.getBoundingClientRect().height,
      };
    });

    expect(Math.abs(geometry.rootHeight - geometry.modeledHeight)).toBeLessThan(0.5);
    expect(Math.abs(geometry.rootHeight - geometry.blockHeight)).toBeLessThan(0.5);
    expect(Math.abs(geometry.scrollHeight - geometry.tableHeight)).toBeLessThan(0.5);
    expect(Math.abs(
      geometry.tableHeight - geometry.rowHeight - geometry.tableBorderWidth * 2,
    )).toBeLessThan(0.5);
  });

  test('ellipsizes long file chips without drifting from the modeled markdown height', async ({ page }) => {
    const label = 'RPC Concurrency and Mobile Transport Resilience implementation specification and rollout notes';
    await installMockRemuxHost(page, {
      turns: [completedTurn({
        assistantText: `Before [${label}](/tmp/specs/rpc-concurrency-and-mobile-transport-resilience.md:128) after`,
      })],
    });

    await page.goto('/viewers/codex/?remuxResourceKind=thread&remuxResourceId=mock-thread-1');

    const markdown = page.locator('[data-row-kind="assistantMessage"] .codex-markdown');
    const chip = markdown.locator('.codex-md-file-link');
    await expect(chip).toBeVisible();
    await expect(chip).toHaveText(`${label} (line 128)`);
    await expect(chip).toHaveAttribute(
      'title',
      '/tmp/specs/rpc-concurrency-and-mobile-transport-resilience.md:128',
    );

    const geometry = await markdown.evaluate((element) => {
      const root = element as HTMLElement;
      const chipNode = root.querySelector<HTMLElement>('.codex-md-file-link');
      const labelNode = root.querySelector<HTMLElement>('.codex-md-file-link-name');
      if (!chipNode || !labelNode) {
        throw new Error('Expected rendered file chip geometry');
      }
      const blockHeight = Array.from(root.children).reduce(
        (total, child) => total + (child as HTMLElement).getBoundingClientRect().height,
        0,
      );

      return {
        blockHeight,
        chipWidth: chipNode.getBoundingClientRect().width,
        labelClientWidth: labelNode.clientWidth,
        labelOverflow: getComputedStyle(labelNode).textOverflow,
        labelScrollWidth: labelNode.scrollWidth,
        modeledHeight: Number.parseFloat(root.style.height),
        rootHeight: root.getBoundingClientRect().height,
      };
    });

    expect(geometry.chipWidth).toBeLessThanOrEqual(280.5);
    expect(geometry.labelScrollWidth).toBeGreaterThan(geometry.labelClientWidth);
    expect(geometry.labelOverflow).toBe('ellipsis');
    expect(Math.abs(geometry.rootHeight - geometry.modeledHeight)).toBeLessThan(0.5);
    expect(Math.abs(geometry.rootHeight - geometry.blockHeight)).toBeLessThan(0.5);
  });

  test('labels only explicitly projected steering messages inside work', async ({ page }) => {
    const turn: CodexTranscriptTurn = {
      completedAt: 1782000001000,
      durationMs: 1000,
      error: null,
      id: 'turn-steering',
      revision: 'turn-steering-revision',
      segments: [
        {
          content: [{ text: 'Start the task', text_elements: [], type: 'text' }],
          id: 'user-initial',
          isSteering: false,
          revision: 'user-initial-revision',
          type: 'userMessage',
        },
        {
          durationMs: 1000,
          hasDetails: true,
          id: 'work-steering',
          revision: 'work-steering-revision',
          state: 'completed',
          type: 'work',
        },
      ],
      startedAt: 1782000000000,
      status: 'completed',
    };
    await installMockRemuxHost(page, {
      turns: [turn],
      workDetails: {
        'work-steering': {
          entries: [{ id: 'user-steering', itemId: 'user-steering', type: 'userMessage' }],
          itemIds: ['user-steering'],
          revision: 'work-details-steering-revision',
          segmentId: 'work-steering',
        },
      },
      workItems: {
        'user-steering': {
          content: [{ text: 'Change the output format', text_elements: [], type: 'text' }],
          id: 'user-steering',
          isSteering: true,
          type: 'userMessage',
        },
      },
    });

    await page.goto('/viewers/codex/?remuxResourceKind=thread&remuxResourceId=mock-thread-1');

    await expect(page.getByText('Start the task')).toBeVisible();
    await expect(page.getByText('Steered conversation')).toHaveCount(0);
    await page.getByTestId('work-section-work-steering').click();
    await expect(page.getByText('Change the output format')).toBeVisible();
    await expect(page.getByText('Steered conversation')).toHaveCount(1);
  });

  test('advances an isolated running work duration from the server timing anchor', async ({ page }) => {
    const turn: CodexTranscriptTurn = {
      completedAt: null,
      durationMs: null,
      error: null,
      id: 'turn-running-duration',
      revision: 'turn-running-duration-revision',
      segments: [
        {
          content: [{ text: 'Run the task', text_elements: [], type: 'text' }],
          id: 'user-running-duration',
          revision: 'user-running-duration-revision',
          type: 'userMessage',
        },
        {
          durationMs: null,
          hasDetails: false,
          id: 'work-running-duration',
          revision: 'work-running-duration-revision',
          state: 'running',
          type: 'work',
        },
      ],
      startedAt: 1782000000,
      status: 'inProgress',
    };
    await installMockRemuxHost(page, {
      runtime: {
        activeTurnElapsedMs: 1000,
        activeTurnId: turn.id,
        status: 'running',
      },
      turns: [turn],
    });

    await page.goto('/viewers/codex/?remuxResourceKind=thread&remuxResourceId=mock-thread-1');

    const workHeader = page.getByTestId('work-section-work-running-duration');
    await expect(workHeader).toContainText('Working for 1s');
    await expect(workHeader).toContainText('Working for 2s', { timeout: 2500 });
  });

  test('keeps advancing provisional worked duration until the authoritative duration arrives', async ({ page }) => {
    const turn: CodexTranscriptTurn = {
      completedAt: null,
      durationMs: null,
      error: null,
      id: 'turn-provisional-worked-duration',
      revision: 'turn-provisional-worked-duration-revision',
      segments: [
        {
          content: [{ text: 'Run the task', text_elements: [], type: 'text' }],
          id: 'user-provisional-worked-duration',
          revision: 'user-provisional-worked-duration-revision',
          type: 'userMessage',
        },
        {
          durationMs: null,
          hasDetails: false,
          id: 'work-provisional-worked-duration',
          revision: 'work-provisional-worked-duration-revision',
          state: 'completed',
          type: 'work',
        },
        {
          id: 'assistant-provisional-worked-duration',
          phase: null,
          revision: 'assistant-provisional-worked-duration-revision',
          text: 'Streaming the answer',
          type: 'assistantMessage',
        },
      ],
      startedAt: 1782000000,
      status: 'inProgress',
    };
    await installMockRemuxHost(page, {
      runtime: {
        activeTurnElapsedMs: 1000,
        activeTurnId: turn.id,
        status: 'running',
      },
      turns: [turn],
    });

    await page.goto('/viewers/codex/?remuxResourceKind=thread&remuxResourceId=mock-thread-1');

    const workHeader = page.getByTestId('work-section-work-provisional-worked-duration');
    await expect(workHeader).toContainText('Worked for 1s');
    await expect(workHeader).toContainText('Worked for 2s', { timeout: 2500 });
  });

  test('renders text-backed mention spans as chips and rebuilds them on edit', async ({ page }) => {
    const mentionTurn: CodexTranscriptTurn = {
      completedAt: 1782000001000,
      durationMs: 1000,
      error: null,
      id: 'turn-mention',
      revision: 'turn-mention-revision',
      segments: [
        {
          content: [
            {
              text: 'Please review viewer/App.tsx before sending',
              text_elements: [
                { byteRange: { end: 28, start: 14 }, placeholder: '@App.tsx' },
              ],
              type: 'text',
            },
          ],
          id: 'user-message-mention',
          revision: 'user-message-mention-revision',
          type: 'userMessage',
        },
        {
          id: 'assistant-message-mention',
          phase: null,
          revision: 'assistant-message-mention-revision',
          text: 'mock assistant response',
          type: 'assistantMessage',
        },
      ],
      startedAt: 1782000000000,
      status: 'completed',
    };
    await installMockRemuxHost(page, { turns: [mentionTurn] });

    await page.goto('/viewers/codex/?remuxResourceKind=thread&remuxResourceId=mock-thread-1');

    const bubble = page.locator('.codex-user-bubble');
    const inlineChip = bubble.locator('.codex-md-file-link');
    await expect(inlineChip).toHaveCount(1);
    await expect(inlineChip).toHaveText('App.tsx');
    await expect(inlineChip).toHaveAttribute('title', 'viewer/App.tsx');
    await expect(page.locator('.codex-user-rail-card')).toHaveCount(0);
    await expect(bubble).toContainText('Please review');
    await expect(bubble).toContainText('before sending');

    await page.getByRole('button', { name: 'Edit message' }).click();
    const chip = page.locator('.remux-composer-mention-chip');
    await expect(chip).toHaveCount(1);
    await expect(chip).toHaveAttribute('data-path', 'viewer/App.tsx');
    await expect(page.locator('.remux-composer-contenteditable')).toContainText('Please review');
  });

  test('uses latest thread cwd and settings as new chat defaults', async ({ page }) => {
    const cwd = '/tmp/remux-runtime';
    const threadCwd = '/tmp/latest-thread-project';
    await installMockRemuxHost(page, { cwd, threadCwd });

    await page.goto('/viewers/codex/?remuxResourceKind=draft&remuxResourceId=codex%3Adraft%3Atest%3A1');

    await expect(page.getByTitle(threadCwd)).toBeVisible();
    await expect
      .poll(async () => {
        const requests = await capturedHostRequests(page);
        return requests.some((request) =>
          request.method === 'remux/codex/files' &&
          hasFileResourceRequest(request.params, {
            path: threadCwd,
            type: 'directoryListing',
          }));
      })
      .toBe(true);

    await page.getByRole('button', { name: 'Select directory' }).click();

    const editor = page.locator('.remux-composer-contenteditable');
    await editor.click();
    await editor.pressSequentially('start with inherited defaults');

    const sendButton = page.getByRole('button', { name: 'Send message' });
    await expect(sendButton).toBeEnabled();
    await sendButton.click();

    await expect
      .poll(() => capturedHostMethods(page))
      .toContain('remux/codex/thread/message/start');

    const requests = await capturedHostRequests(page);
    const startRequest = requests.find((request) => request.method === 'remux/codex/thread/message/start');
    expect(startRequest?.params).toMatchObject({
      composerConfig: {
        intelligence: 'medium',
        reviewMode: 'auto-review',
        speed: 'fast',
      },
      cwd: threadCwd,
      parts: [{ text: 'start with inherited defaults', type: 'text' }],
    });
  });

  test('sends idle existing-thread content directly without rendering the queue', async ({ page }) => {
    await installMockRemuxHost(page);

    await page.goto('/viewers/codex/?remuxResourceKind=thread&remuxResourceId=mock-thread-1');

    const editor = page.locator('.remux-composer-contenteditable');
    await editor.click();
    await editor.pressSequentially('hello from viewer');

    const sendButton = page.getByRole('button', { name: 'Send message' });
    await expect(sendButton).toBeEnabled();
    await sendButton.click();

    await expect
      .poll(() => capturedHostMethods(page))
      .toContain('remux/codex/thread/message/send');

    const requests = await capturedHostRequests(page);
    const sendRequest = requests.find((request) => request.method === 'remux/codex/thread/message/send');
    expect(sendRequest?.params).toMatchObject({
      parts: [{ text: 'hello from viewer', type: 'text' }],
      threadId: 'mock-thread-1',
    });
    expect(sendRequest?.params).not.toHaveProperty('cwd');
    expect(sendRequest?.params).not.toHaveProperty('model');
    expect(sendRequest?.params).not.toHaveProperty('approvalPolicy');
    await expect(page.getByText('Queued 1')).toHaveCount(0);
  });

  test('keeps stop available while composing and queues the next message during a turn', async ({ page }) => {
    await installMockRemuxHost(page, {
      runtime: {
        activeTurnElapsedMs: 2400,
        activeTurnId: 'active-turn-1',
        status: 'running',
      },
      turns: [completedTurn()],
    });

    await page.goto('/viewers/codex/?remuxResourceKind=thread&remuxResourceId=mock-thread-1');
    await expect(page.getByRole('button', { name: 'Stop turn' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Queue message' })).toHaveCount(0);

    const editor = page.locator('.remux-composer-contenteditable');
    await editor.click();
    await editor.pressSequentially('follow up after this');
    const queueButton = page.getByRole('button', { name: 'Queue message' });
    await expect(queueButton).toBeEnabled();
    await queueButton.click();

    await expect(page.getByText('Queued 1')).toBeVisible();
    await expect(page.getByText('follow up after this')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Stop turn' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Edit message' })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Fork from response' })).toBeDisabled();
    await page.getByRole('button', { name: /Queued 1/ }).click();
    await expect(page.getByRole('button', { name: 'Send now' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Delete queued entry' })).toBeVisible();
    await page.getByRole('button', { name: 'Stop turn' }).click();
    await expect(page.getByText('Queued 1')).toHaveCount(0);
  });

  test('allows compaction to be queued while a turn is running', async ({ page }) => {
    await installMockRemuxHost(page, {
      runtime: {
        activeTurnElapsedMs: 2400,
        activeTurnId: 'active-turn-1',
        status: 'running',
      },
    });

    await page.goto('/viewers/codex/?remuxResourceKind=thread&remuxResourceId=mock-thread-1');
    await page.getByRole('button', { name: 'Preferences' }).click();
    await page.getByRole('button', { name: 'Compact' }).click();

    await expect(page.getByText('Queued 1')).toBeVisible();
    await expect(page.getByText('Compact context')).toBeVisible();
    await page.getByRole('button', { name: /Queued 1/ }).click();
    await expect(page.getByRole('button', { name: 'Send now' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Delete queued entry' })).toBeVisible();
  });

  test('shows thread token usage in the composer inline status', async ({ page }) => {
    await installMockRemuxHost(page, {
      tokenUsage: mockTokenUsage({ inputTokens: 1000, modelContextWindow: 2000 }),
    });

    await page.goto('/viewers/codex/?remuxResourceKind=thread&remuxResourceId=mock-thread-1');

    const usageStatus = page.locator('.remux-composer-status-group-right');
    await expect(usageStatus).toContainText('50% context');
    await expect(usageStatus).not.toContainText('est.');
    await expect(usageStatus).toContainText('1k tokens');
  });

  test('renders enabled transcript edit and fork actions for completed messages', async ({ page }) => {
    await installMockRemuxHost(page, { turns: [completedTurn()] });

    await page.goto('/viewers/codex/?remuxResourceKind=thread&remuxResourceId=mock-thread-1');

    await expect(page.getByText('mock assistant response')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Edit message' })).toBeEnabled();
    await expect(page.getByRole('button', { name: 'Fork from response' })).toBeEnabled();

    await page.getByRole('button', { name: 'Edit message' }).click();
    await expect(page.locator('.remux-composer-contenteditable')).toContainText('mock user prompt');
  });

  test('renders copy action and disabled edit action for in-progress user messages', async ({ page }) => {
    await installMockRemuxHost(page, { turns: [inProgressUserTurn()] });

    await page.goto('/viewers/codex/?remuxResourceKind=thread&remuxResourceId=mock-thread-1');

    await expect(page.getByText('mock user prompt')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Copy message' })).toBeEnabled();
    await expect(page.getByRole('button', { name: 'Edit message' })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Fork from response' })).not.toBeVisible();
  });

  test('allows fork and narration but not edit while a turn is running', async ({ page }) => {
    await installMockRemuxHost(page, {
      runtime: {
        activeTurnElapsedMs: 2400,
        activeTurnId: 'active-turn-1',
        status: 'running',
      },
      turns: [completedTurn()],
    });

    await page.goto('/viewers/codex/?remuxResourceKind=thread&remuxResourceId=mock-thread-1');
    await expect(page.getByRole('button', { name: 'Stop turn' })).toBeVisible();

    // Editing rolls back the running thread; forking and narrating a
    // completed response do not touch it.
    await expect(page.getByRole('button', { name: 'Edit message' })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Fork from response' })).toBeEnabled();
    await expect(page.getByRole('button', { name: 'Narrate response' })).toBeEnabled();

    await page.getByRole('button', { name: 'Narrate response' }).click();
    const composer = page.locator('[data-remux-composer-root]');
    await expect(composer.getByRole('button', { name: 'Play narration' })).toBeVisible();
    await composer.getByRole('button', { name: 'Close narration' }).click();

    await page.getByRole('button', { name: 'Fork from response' }).click();
    const editor = page.locator('.remux-composer-contenteditable');
    await editor.click();
    await editor.pressSequentially('branch while the turn still runs');
    const sendButton = page.getByRole('button', { name: 'Send forked message' });
    await expect(sendButton).toBeEnabled();
    await sendButton.click();

    await expect
      .poll(() => capturedHostMethods(page))
      .toContain('remux/codex/thread/message/fork');
    const requests = await capturedHostRequests(page);
    const forkRequest = requests.find((request) => request.method === 'remux/codex/thread/message/fork');
    expect(forkRequest?.params).toMatchObject({
      assistantMessageId: 'assistant-message-1',
      threadId: 'mock-thread-1',
      turnId: 'turn-1',
    });
  });

  test('renders fork action for every completed assistant response', async ({ page }) => {
    await installMockRemuxHost(page, {
      turns: [
        completedTurn({
          assistantId: 'assistant-message-old',
          assistantText: 'old assistant response',
          turnId: 'turn-old',
          userId: 'user-message-old',
          userText: 'old user prompt',
        }),
        completedTurn({
          assistantId: 'assistant-message-latest',
          assistantText: 'latest assistant response',
          turnId: 'turn-latest',
          userId: 'user-message-latest',
          userText: 'latest user prompt',
        }),
      ],
    });

    await page.goto('/viewers/codex/?remuxResourceKind=thread&remuxResourceId=mock-thread-1');

    await expect(page.getByText('old assistant response')).toBeVisible();
    await expect(page.getByText('latest assistant response')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Fork from response' })).toHaveCount(2);
  });

  test('places Narrate after Fork and replaces composer actions with playback controls', async ({ page }) => {
    await installMockRemuxHost(page, {
      turns: [completedTurn({ assistantText: 'First narrated block.\n\nSecond narrated block.' })],
    });

    await page.goto('/viewers/codex/?remuxResourceKind=thread&remuxResourceId=mock-thread-1');

    const assistantActions = page.locator('.codex-assistant-actions button');
    await expect(assistantActions).toHaveCount(3);
    await expect(assistantActions.nth(0)).toHaveAttribute('aria-label', 'Copy response');
    await expect(assistantActions.nth(1)).toHaveAttribute('aria-label', 'Fork from response');
    await expect(assistantActions.nth(2)).toHaveAttribute('aria-label', 'Narrate response');
    const markdown = page.locator('[data-row-kind="assistantMessage"] .codex-markdown');
    const heightBeforeNarration = await markdown.evaluate((element) => element.getBoundingClientRect().height);

    await assistantActions.nth(2).click();
    await expect.poll(() => capturedHostMethods(page)).toContain('remux/codex/narration/start');

    const composer = page.locator('[data-remux-composer-root]');
    await expect(composer.getByRole('button', { name: 'Disable narration auto-scroll' })).toBeVisible();
    await expect(composer.getByRole('button', { name: 'Preferences' })).toHaveCount(0);
    await expect(composer.getByRole('button', { name: 'Previous narrated block' })).toBeDisabled();
    await expect(composer.getByRole('button', { name: 'Next narrated block' })).toBeEnabled();
    await expect(composer.getByRole('button', { name: 'Play narration' })).toBeVisible();
    await expect(composer.getByRole('button', { name: 'Narration speed 1×' })).toBeVisible();
    await expect(composer.getByRole('button', { name: 'Close narration' })).toBeVisible();
    await expect(composer.getByRole('button', { name: 'Attach' })).toHaveCount(0);
    await expect(composer.getByRole('button', { name: 'Send message' })).toHaveCount(0);
    await expect(markdown.locator('[data-narration-block-id="md:0"]')).not.toHaveClass(/codex-md-structural-target-narrating/);
    await expect(markdown.locator('[data-narration-block-id="md:0"] .codex-narration-context-rect')).toBeVisible();
    expect(await markdown.evaluate((element) => element.getBoundingClientRect().height)).toBe(heightBeforeNarration);

    await page.locator('.remux-transcript-viewport').dispatchEvent('wheel');
    await expect(composer.getByRole('button', { name: 'Enable narration auto-scroll' })).toBeVisible();
    await composer.getByRole('button', { name: 'Enable narration auto-scroll' }).click();
    await expect(composer.getByRole('button', { name: 'Disable narration auto-scroll' })).toBeVisible();

    await composer.getByRole('button', { name: 'Next narrated block' }).click();
    await expect(composer.getByRole('button', { name: 'Previous narrated block' })).toBeEnabled();
    await composer.getByRole('button', { name: 'Previous narrated block' }).click();

    await composer.getByRole('button', { name: 'Play narration' }).click();
    await expect(composer.getByRole('button', { name: 'Pause narration' })).toBeVisible();
    await expect(markdown.locator('.codex-narration-word-rect')).toBeVisible();
    await expect(markdown.locator('.codex-md-narrated-word')).toHaveCount(0);
    expect(await markdown.evaluate((element) => element.getBoundingClientRect().height)).toBe(heightBeforeNarration);
    await composer.getByRole('button', { name: 'Pause narration' }).click();
    await expect(markdown.locator('.codex-narration-word-rect')).toBeVisible();

    await composer.getByRole('button', { name: 'Narration speed 1×' }).click();
    await expect(page.getByRole('menuitemradio')).toHaveCount(5);
    await page.getByRole('menuitemradio', { name: '1.5×' }).click();
    await expect(composer.getByRole('button', { name: 'Narration speed 1.5×' })).toBeVisible();

    await composer.getByRole('button', { name: 'Close narration' }).click();
    await expect(markdown.locator('.codex-narration-paint-layer:not([hidden])')).toHaveCount(0);
    await expect(markdown.locator('.codex-narration-paint-layer').locator('div')).toHaveCount(0);
    await expect(markdown.locator('.codex-md-structural-target-narrating')).toHaveCount(0);
    await expect(composer.getByRole('button', { name: 'Preferences' })).toBeVisible();
    await expect(composer.getByRole('button', { name: 'Attach' })).toBeVisible();
    await expect(composer.getByRole('button', { name: 'Send message' })).toBeVisible();
  });

  test('shows narration preparation in the slim composer context row', async ({ page }) => {
    await installMockRemuxHost(page, {
      narrationStatus: 'planning',
      turns: [completedTurn()],
    });

    await page.goto('/viewers/codex/?remuxResourceKind=thread&remuxResourceId=mock-thread-1');
    await page.getByRole('button', { name: 'Narrate response' }).click();

    const bar = page.locator('.remux-narration-bar');
    await expect(bar).toContainText('Preparing narration · Writing script');
    await expect(bar.getByRole('button', { name: 'Cancel narration preparation' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Attach' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Send message' })).toBeVisible();

    await bar.getByRole('button', { name: 'Cancel narration preparation' }).click();
    await expect(bar).toHaveCount(0);
    await expect.poll(() => capturedHostMethods(page)).toContain('remux/codex/narration/cancel');
  });

  test('paints word ranges through nested Markdown leaves without changing layout', async ({ page }) => {
    await installMockRemuxHost(page, {
      turns: [completedTurn({
        assistantText: [
          '***Nested*** emphasis.',
          '[Linked](https://example.com) text.',
          '`inlineCode` value.',
        ].join('\n\n'),
      })],
    });

    await page.goto('/viewers/codex/?remuxResourceKind=thread&remuxResourceId=mock-thread-1');
    const markdown = page.locator('[data-row-kind="assistantMessage"] .codex-markdown');
    const height = await markdown.evaluate((element) => element.getBoundingClientRect().height);
    await page.getByRole('button', { name: 'Narrate response' }).click();
    const composer = page.locator('[data-remux-composer-root]');

    const expectedWords = ['Nested', 'Linked', 'inlineCode'];
    for (const [index, expected] of expectedWords.entries()) {
      await composer.getByRole('button', { name: 'Play narration' }).click();
      const activeFrame = markdown.locator(`[data-narration-block-id="md:${index}"]`);
      await expect(activeFrame.locator('.codex-narration-word-rect')).toBeVisible();
      await expect(activeFrame.locator('.codex-narration-context-rect')).toBeVisible();
      const wordGeometry = await activeFrame.evaluate((frame, expectedWord) => {
        const walker = document.createTreeWalker(frame, NodeFilter.SHOW_TEXT);
        let textNode = walker.nextNode();
        while (textNode && !textNode.textContent?.includes(expectedWord)) {
          textNode = walker.nextNode();
        }
        const wordStart = textNode?.textContent?.indexOf(expectedWord) ?? -1;
        const overlay = frame.querySelector<HTMLElement>('.codex-narration-word-rect');
        if (!textNode || wordStart < 0 || !overlay) return null;
        const expectedRange = document.createRange();
        expectedRange.setStart(textNode, wordStart);
        expectedRange.setEnd(textNode, wordStart + expectedWord.length);
        const expectedRect = expectedRange.getBoundingClientRect();
        const overlayRect = overlay.getBoundingClientRect();
        return {
          leftDelta: Math.abs(overlayRect.left - expectedRect.left),
          widthDelta: Math.abs(overlayRect.width - expectedRect.width),
        };
      }, expected);
      expect(wordGeometry).not.toBeNull();
      expect(wordGeometry!.leftDelta).toBeLessThan(0.5);
      expect(wordGeometry!.widthDelta).toBeLessThan(0.5);
      await expect(markdown.locator('.codex-narration-paint-layer:not([hidden])')).toHaveCount(1);
      for (let previous = 0; previous < index; previous += 1) {
        const previousLayer = markdown.locator(`[data-narration-block-id="md:${previous}"] .codex-narration-paint-layer`);
        await expect(previousLayer).toHaveAttribute('hidden', '');
        await expect(previousLayer.locator('div')).toHaveCount(0);
      }
      await composer.getByRole('button', { name: 'Pause narration' }).click();
      if (expected !== expectedWords.at(-1)) {
        await composer.getByRole('button', { name: 'Next narrated block' }).click();
      }
    }

    expect(await markdown.evaluate((element) => element.getBoundingClientRect().height)).toBe(height);
    await expect(markdown.locator('.codex-md-narrated-word')).toHaveCount(0);
    await expect(markdown.locator('.codex-md-file-link-narrating')).toHaveCount(0);
  });

  test('paints file-link text through the block overlay without activating the chip', async ({ page }) => {
    await installMockRemuxHost(page, {
      turns: [completedTurn({ assistantText: '[app.ts](src/app.ts) file.' })],
    });

    await page.goto('/viewers/codex/?remuxResourceKind=thread&remuxResourceId=mock-thread-1');
    const markdown = page.locator('[data-row-kind="assistantMessage"] .codex-markdown');
    const initialHeight = await markdown.evaluate((element) => element.getBoundingClientRect().height);
    await page.getByRole('button', { name: 'Narrate response' }).click();
    await page.locator('[data-remux-composer-root]').getByRole('button', { name: 'Play narration' }).click();

    const word = markdown.locator('.codex-narration-word-rect');
    const chipText = markdown.locator('.codex-md-file-link-name');
    await expect(word).toBeVisible();
    await expect(markdown.locator('.codex-md-file-link-narrating')).toHaveCount(0);
    expect(await word.evaluate((element, textSelector) => {
      const text = document.querySelector<HTMLElement>(textSelector)!;
      const wordRect = element.getBoundingClientRect();
      const textRect = text.getBoundingClientRect();
      return Math.min(wordRect.right, textRect.right) > Math.max(wordRect.left, textRect.left)
        && Math.min(wordRect.bottom, textRect.bottom) > Math.max(wordRect.top, textRect.top);
    }, '.codex-md-file-link-name')).toBe(true);
    expect(await markdown.evaluate((element) => element.getBoundingClientRect().height)).toBe(initialHeight);
  });

  test('positions explicitly selected narration blocks in the reading band', async ({ page }) => {
    const paragraph = (label: string) => `${label} ${'reading position content '.repeat(56)}`;
    await installMockRemuxHost(page, {
      turns: [completedTurn({
        assistantText: [
          paragraph('First.'),
          paragraph('Second.'),
          paragraph('Third.'),
          paragraph('Fourth.'),
          paragraph('Fifth.'),
          paragraph('Sixth.'),
        ].join('\n\n'),
      })],
    });

    await page.goto('/viewers/codex/?remuxResourceKind=thread&remuxResourceId=mock-thread-1');
    await page.getByRole('button', { name: 'Narrate response' }).click();
    const composer = page.locator('[data-remux-composer-root]');
    await composer.getByRole('button', { name: 'Next narrated block' }).click();
    await composer.getByRole('button', { name: 'Next narrated block' }).click();
    const target = page.locator('[data-narration-block-id="md:2"]');
    await expect(target).toBeVisible();

    const readingPosition = () => page.evaluate(() => {
      const viewport = document.querySelector<HTMLElement>('.remux-transcript-viewport');
      const composerRoot = document.querySelector<HTMLElement>('[data-remux-composer-root]');
      const block = document.querySelector<HTMLElement>('[data-narration-block-id="md:2"]');
      if (!viewport || !composerRoot || !block) return -1;
      const viewportBounds = viewport.getBoundingClientRect();
      const usableBottom = Math.min(viewportBounds.bottom, composerRoot.getBoundingClientRect().top);
      return (block.getBoundingClientRect().top - viewportBounds.top) / (usableBottom - viewportBounds.top);
    });
    await expect.poll(readingPosition).toBeLessThan(0.38);
    expect(await readingPosition()).toBeGreaterThan(0.22);
  });

  test('keeps playing Previous block navigation monotonic until explicit focus settles', async ({ page }) => {
    const paragraph = (label: string) => `${label} ${'navigation trajectory content '.repeat(72)}`;
    await installMockRemuxHost(page, {
      turns: [completedTurn({
        assistantText: [
          paragraph('First.'),
          paragraph('Second.'),
          paragraph('Third.'),
          paragraph('Fourth.'),
        ].join('\n\n'),
      })],
    });

    await page.goto('/viewers/codex/?remuxResourceKind=thread&remuxResourceId=mock-thread-1');
    await page.getByRole('button', { name: 'Narrate response' }).click();
    const composer = page.locator('[data-remux-composer-root]');
    const markdown = page.locator('[data-row-kind="assistantMessage"] .codex-markdown');
    await composer.getByRole('button', { name: 'Next narrated block' }).click();
    await expect(markdown.locator('[data-narration-block-id="md:1"] .codex-narration-word-rect')).toBeVisible();
    await composer.getByRole('button', { name: 'Next narrated block' }).click();
    await expect(markdown.locator('[data-narration-block-id="md:2"] .codex-narration-word-rect')).toBeVisible();
    await composer.getByRole('button', { name: 'Play narration' }).click();
    await expect(composer.getByRole('button', { name: 'Pause narration' })).toBeVisible();

    await page.evaluate(() => {
      const viewport = document.querySelector<HTMLElement>('.remux-transcript-viewport')!;
      const state = globalThis as typeof globalThis & { __narrationScrollSamples?: number[] };
      state.__narrationScrollSamples = [viewport.scrollTop];
      const startedAt = performance.now();
      const sample = () => {
        state.__narrationScrollSamples?.push(viewport.scrollTop);
        if (performance.now() - startedAt < 360) requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    });
    await composer.getByRole('button', { name: 'Previous narrated block' }).click();
    const destination = markdown.locator('[data-narration-block-id="md:1"]');
    await expect(destination.locator('.codex-narration-word-rect')).toBeVisible();
    await page.waitForTimeout(400);

    const samples = await page.evaluate(() => {
      const state = globalThis as typeof globalThis & { __narrationScrollSamples?: number[] };
      const captured = state.__narrationScrollSamples ?? [];
      delete state.__narrationScrollSamples;
      return captured;
    });
    expect(samples.length).toBeGreaterThan(3);
    expect(samples.at(-1)!).toBeLessThan(samples[0] - 10);
    const largestDownwardCorrection = samples.slice(1).reduce(
      (largest, value, index) => Math.max(largest, value - samples[index]),
      0,
    );
    expect(largestDownwardCorrection).toBeLessThanOrEqual(1.5);
    await expect(composer.getByRole('button', { name: 'Pause narration' })).toBeVisible();
  });

  test('keeps table narration paint at the table frame without changing layout', async ({ page }) => {
    await installMockRemuxHost(page, {
      turns: [completedTurn({
        assistantText: ['| Plan | Price |', '| --- | ---: |', '| Starter | $5 |'].join('\n'),
      })],
    });

    await page.goto('/viewers/codex/?remuxResourceKind=thread&remuxResourceId=mock-thread-1');
    const markdown = page.locator('[data-row-kind="assistantMessage"] .codex-markdown');
    const initialHeight = await markdown.evaluate((element) => element.getBoundingClientRect().height);
    await page.getByRole('button', { name: 'Narrate response' }).click();
    const startRequest = (await capturedHostRequests(page)).find((request) => request.method === 'remux/codex/narration/start');
    const sourceTargets = (startRequest?.params as { document?: { targets?: Array<{ kind?: string }> } })?.document?.targets ?? [];
    expect(sourceTargets.some((target) => target.kind === 'tableCell')).toBe(true);
    await expect(markdown.locator('.codex-md-table')).toHaveClass(/codex-md-structural-target-narrating/);
    await expect(markdown.locator('.codex-md-table-scroll')).not.toHaveClass(/codex-md-structural-target-narrating/);
    await page.locator('[data-remux-composer-root]').getByRole('button', { name: 'Play narration' }).click();
    await expect(page.locator('[data-remux-composer-root]').getByRole('button', { name: 'Pause narration' })).toBeVisible();
    // Cell-level cues keep painting at the element level: the table frame
    // stays lit and no per-cell highlight appears.
    await expect(markdown.locator('.codex-md-table')).toHaveClass(/codex-md-structural-target-narrating/);
    await expect(markdown.locator('.codex-md-table-cell-narrating')).toHaveCount(0);
    expect(await markdown.evaluate((element) => element.getBoundingClientRect().height)).toBe(initialHeight);
  });

  test('anchors whole-code narration paint to the code border', async ({ page }) => {
    await installMockRemuxHost(page, {
      turns: [completedTurn({
        assistantText: ['```ts', 'const answer = 42;', '```'].join('\n'),
      })],
    });

    await page.goto('/viewers/codex/?remuxResourceKind=thread&remuxResourceId=mock-thread-1');
    const markdown = page.locator('[data-row-kind="assistantMessage"] .codex-markdown');
    const initialHeight = await markdown.evaluate((element) => element.getBoundingClientRect().height);
    await page.getByRole('button', { name: 'Narrate response' }).click();

    await expect(markdown.locator('.codex-md-code-block')).toHaveClass(/codex-md-structural-target-narrating/);
    await expect(markdown.locator('[data-narration-block-id="md:0"]')).not.toHaveClass(/codex-md-structural-target-narrating/);
    await page.locator('[data-remux-composer-root]').getByRole('button', { name: 'Play narration' }).click();
    await expect(page.locator('[data-remux-composer-root]').getByRole('button', { name: 'Pause narration' })).toBeVisible();
    // Line-level cues keep painting at the element level: the code frame
    // stays lit and no per-line highlight appears.
    await expect(markdown.locator('.codex-md-code-block')).toHaveClass(/codex-md-structural-target-narrating/);
    await expect(markdown.locator('.codex-md-code-line-narrating')).toHaveCount(0);
    expect(await markdown.evaluate((element) => element.getBoundingClientRect().height)).toBe(initialHeight);
  });

  test('ends prose context highlights at the text instead of the row edge', async ({ page }) => {
    await installMockRemuxHost(page, {
      turns: [completedTurn({
        assistantText: `${'Wrapped context line words '.repeat(18).trim()}\n\nTiny.`,
      })],
    });

    await page.goto('/viewers/codex/?remuxResourceKind=thread&remuxResourceId=mock-thread-1');
    await page.getByRole('button', { name: 'Narrate response' }).click();
    const markdown = page.locator('[data-row-kind="assistantMessage"] .codex-markdown');
    const firstBlock = markdown.locator('[data-narration-block-id="md:0"]');
    await expect(firstBlock.locator('.codex-narration-context-rect').first()).toBeVisible();

    const contextGeometry = (blockId: string) => page.evaluate((id) => {
      // Scope to the rendered transcript row: layout measurement can mount
      // detached copies of the markdown with the same block ids.
      const frame = document.querySelector<HTMLElement>(
        `[data-row-kind="assistantMessage"] [data-narration-block-id="${id}"]`,
      )!;
      const surface = frame.querySelector<HTMLElement>('[data-narration-surface="prose"]')!;
      const surfaceBounds = surface.getBoundingClientRect();
      const rects = [...frame.querySelectorAll<HTMLElement>('.codex-narration-context-rect')]
        .map((rect) => rect.getBoundingClientRect())
        .sort((left, right) => left.top - right.top);
      return {
        maxRight: Math.max(...rects.map((rect) => rect.right)),
        rectCount: rects.length,
        surfaceRight: surfaceBounds.right,
        surfaceWidth: surfaceBounds.width,
        widths: rects.map((rect) => rect.width),
      };
    }, blockId);

    // A wrapped paragraph paints one rect per visual line instead of a
    // single full-width slab over the element box.
    const wrapped = await contextGeometry('md:0');
    expect(wrapped.rectCount).toBeGreaterThan(1);
    expect(wrapped.maxRight).toBeLessThanOrEqual(wrapped.surfaceRight + 1);

    // Seek to the short paragraph: its single-line highlight ends at the
    // last word, far from the row edge.
    await markdown.locator('[data-narration-block-id="md:1"]').click();
    await expect(markdown.locator('[data-narration-block-id="md:1"] .codex-narration-context-rect')).toBeVisible();
    const tiny = await contextGeometry('md:1');
    expect(tiny.rectCount).toBe(1);
    expect(tiny.widths[0]).toBeLessThan(tiny.surfaceWidth * 0.4);
  });

  test('automatically follows narration blocks through the virtualized viewport', async ({ page }) => {
    const paragraph = (label: string) => `${label} ${'automatic narration reading content '.repeat(56)}`;
    await installMockRemuxHost(page, {
      turns: [completedTurn({
        assistantText: [
          paragraph('First.'),
          paragraph('Second.'),
          paragraph('Third.'),
          paragraph('Fourth.'),
          paragraph('Fifth.'),
        ].join('\n\n'),
      })],
    });

    await page.goto('/viewers/codex/?remuxResourceKind=thread&remuxResourceId=mock-thread-1');
    await page.getByRole('button', { name: 'Narrate response' }).click();
    await page.locator('[data-remux-composer-root]').getByRole('button', { name: 'Play narration' }).click();
    const markdown = page.locator('[data-row-kind="assistantMessage"] .codex-markdown');
    const second = markdown.locator('[data-narration-block-id="md:1"]');
    await expect(second.locator('.codex-narration-word-rect')).toBeVisible({ timeout: 3_000 });
    const firstLayer = markdown.locator('[data-narration-block-id="md:0"] .codex-narration-paint-layer');
    await expect(firstLayer).toHaveAttribute('hidden', '');
    await expect(firstLayer.locator('div')).toHaveCount(0);
    const readingPosition = () => page.evaluate(() => {
      const viewport = document.querySelector<HTMLElement>('.remux-transcript-viewport')!;
      const composerRoot = document.querySelector<HTMLElement>('[data-remux-composer-root]')!;
      const block = document.querySelector<HTMLElement>('[data-narration-block-id="md:1"]')!;
      const viewportBounds = viewport.getBoundingClientRect();
      const usableBottom = Math.min(viewportBounds.bottom, composerRoot.getBoundingClientRect().top);
      return (block.getBoundingClientRect().top - viewportBounds.top) / (usableBottom - viewportBounds.top);
    });
    await expect.poll(readingPosition).toBeLessThan(0.38);
    expect(await readingPosition()).toBeGreaterThan(0.22);
  });

  test('taps a narrated block to seek playback to its start', async ({ page }) => {
    await installMockRemuxHost(page, {
      turns: [completedTurn({
        assistantText: 'First narrated block.\n\nSecond narrated block.\n\nThird narrated block.',
      })],
    });

    await page.goto('/viewers/codex/?remuxResourceKind=thread&remuxResourceId=mock-thread-1');
    await page.getByRole('button', { name: 'Narrate response' }).click();
    const composer = page.locator('[data-remux-composer-root]');
    await expect(composer.getByRole('button', { name: 'Play narration' })).toBeVisible();

    const markdown = page.locator('[data-row-kind="assistantMessage"] .codex-markdown');
    await expect(markdown.locator('[data-narration-block-id="md:0"] .codex-narration-context-rect')).toBeVisible();

    // Tapping a later block moves the narration focus there without playback.
    await markdown.locator('[data-narration-block-id="md:2"]').click();
    await expect(markdown.locator('[data-narration-block-id="md:2"] .codex-narration-context-rect')).toBeVisible();
    const firstLayer = markdown.locator('[data-narration-block-id="md:0"] .codex-narration-paint-layer');
    await expect(firstLayer).toHaveAttribute('hidden', '');

    // Tapping while playing seeks and keeps playing from the tapped block.
    await composer.getByRole('button', { name: 'Play narration' }).click();
    await expect(composer.getByRole('button', { name: 'Pause narration' })).toBeVisible();
    await markdown.locator('[data-narration-block-id="md:1"]').click();
    await expect(markdown.locator('[data-narration-block-id="md:1"] .codex-narration-word-rect')).toBeVisible();
    await expect(composer.getByRole('button', { name: 'Pause narration' })).toBeVisible();

    // Selected text suppresses tap-to-seek so copying prose does not scrub.
    await markdown.locator('[data-narration-block-id="md:0"]').evaluate((element) => {
      const selection = window.getSelection()!;
      const range = document.createRange();
      range.selectNodeContents(element);
      selection.removeAllRanges();
      selection.addRange(range);
    });
    await markdown.locator('[data-narration-block-id="md:0"]').click({ position: { x: 8, y: 8 } });
    await expect(markdown.locator('[data-narration-block-id="md:1"] .codex-narration-word-rect')).toBeVisible();
  });

  test('sends forked composer content through the fork thread command', async ({ page }) => {
    await installMockRemuxHost(page, { turns: [completedTurn()] });

    await page.goto('/viewers/codex/?remuxResourceKind=thread&remuxResourceId=mock-thread-1');

    await page.getByRole('button', { name: 'Fork from response' }).click();
    const editor = page.locator('.remux-composer-contenteditable');
    await editor.click();
    await editor.pressSequentially('branch from here');

    const sendButton = page.getByRole('button', { name: 'Send forked message' });
    await expect(sendButton).toBeEnabled();
    await sendButton.click();

    await expect
      .poll(() => capturedHostMethods(page))
      .toContain('remux/codex/thread/message/fork');

    const requests = await capturedHostRequests(page);
    const forkRequest = requests.find((request) => request.method === 'remux/codex/thread/message/fork');
    expect(forkRequest?.params).toMatchObject({
      assistantMessageId: 'assistant-message-1',
      parts: [{ text: 'branch from here', type: 'text' }],
      threadId: 'mock-thread-1',
      turnId: 'turn-1',
    });
  });

  test('shows edit command failures in the composer status', async ({ page }) => {
    await installMockRemuxHost(page, {
      commandErrors: {
        'remux/codex/thread/message/edit': 'edit target user message was not found in the latest turn',
      },
      turns: [completedTurn()],
    });

    await page.goto('/viewers/codex/?remuxResourceKind=thread&remuxResourceId=mock-thread-1');

    await page.getByRole('button', { name: 'Edit message' }).click();
    const sendButton = page.getByRole('button', { name: 'Save edited message' });
    await expect(sendButton).toBeEnabled();
    await sendButton.click();

    await expect(page.locator('.remux-composer-message-status-row')).toContainText(
      'edit target user message was not found in the latest turn',
    );
    await expect(sendButton).toBeEnabled();
  });

  test('inserts native picked image attachments as ready resources', async ({ page }) => {
    await installMockRemuxHost(page, {
      attachments: [
        {
          dataUrl: 'data:image/png;base64,iVBORw0KGgo=',
          mimeType: 'image/png',
          name: 'picked.png',
          sizeBytes: 8,
        },
      ],
    });

    await page.goto('/viewers/codex/');

    await page.getByLabel('Attach').click();
    await page.getByText('Photo Library').click();

    await expect(page.locator('.remux-composer-attachment-card').getByText('picked.png')).toBeVisible();
    await expect(page.getByText('image/png')).toBeVisible();
    await expect(page.getByText('Reading image')).not.toBeVisible();
    await expect
      .poll(() => capturedHostMethods(page))
      .toContain('host/attachments/pick');
  });
});

function completedTurn({
  assistantId = 'assistant-message-1',
  assistantText = 'mock assistant response',
  turnId = 'turn-1',
  userId = 'user-message-1',
  userText = 'mock user prompt',
}: {
  assistantId?: string;
  assistantText?: string;
  turnId?: string;
  userId?: string;
  userText?: string;
} = {}): CodexTranscriptTurn {
  return {
    completedAt: 1782000001000,
    durationMs: 1000,
    error: null,
    id: turnId,
    revision: `${turnId}-revision`,
    segments: [
      {
        content: [{ text: userText, text_elements: [], type: 'text' }],
        id: userId,
        revision: `${userId}-revision`,
        type: 'userMessage',
      },
      {
        id: assistantId,
        phase: null,
        revision: `${assistantId}-revision`,
        text: assistantText,
        type: 'assistantMessage',
      },
    ],
    startedAt: 1782000000000,
    status: 'completed',
  };
}

function inProgressUserTurn({
  turnId = 'turn-1',
  userId = 'user-message-1',
  userText = 'mock user prompt',
}: {
  turnId?: string;
  userId?: string;
  userText?: string;
} = {}): CodexTranscriptTurn {
  return {
    completedAt: null,
    durationMs: null,
    error: null,
    id: turnId,
    revision: `${turnId}-running-revision`,
    segments: [
      {
        content: [{ text: userText, text_elements: [], type: 'text' }],
        id: userId,
        revision: `${userId}-revision`,
        type: 'userMessage',
      },
    ],
    startedAt: 1782000000000,
    status: 'inProgress',
  };
}

function mockTokenUsage({
  inputTokens,
  modelContextWindow,
}: {
  inputTokens: number;
  modelContextWindow: number;
}): ThreadTokenUsage {
  return {
    last: {
      cachedInputTokens: 100,
      inputTokens,
      outputTokens: 25,
      reasoningOutputTokens: 5,
      totalTokens: inputTokens + 30,
    },
    modelContextWindow,
    total: {
      cachedInputTokens: 100,
      inputTokens,
      outputTokens: 25,
      reasoningOutputTokens: 5,
      totalTokens: inputTokens + 30,
    },
  };
}
