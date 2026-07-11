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
  runtime?: {
    activeTurnElapsedMs: number | null;
    activeTurnId: string | null;
    status: 'failed' | 'ready' | 'running' | 'stopping';
  };
  threadCwd?: string;
  tokenUsage?: ThreadTokenUsage | null;
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
  const runtime = options.runtime ?? {
    activeTurnElapsedMs: null,
    activeTurnId: null,
    status: 'ready' as const,
  };
  const threadCwd = options.threadCwd ?? cwd;
  const tokenUsage = options.tokenUsage ?? null;
  const turns = options.turns ?? [];
  const workDetails = options.workDetails ?? {};
  const workItems = options.workItems ?? {};

  await page.addInitScript(
    ({ attachments, commandErrors, cwd, files, narrationStatus, runtime, threadCwd, tokenUsage, turns, workDetails, workItems }) => {
      const capturedMessages: HostRequest[] = [];
      const narrationResources = new Map<string, Record<string, unknown>>();
      let queueRevision = 0;
      const queuedEntries: Array<Record<string, unknown>> = [];

      function dispatchHostMessage(message: unknown) {
        const event = new MessageEvent('message', {
          data: JSON.stringify(message),
        });
        window.dispatchEvent(event);
        document.dispatchEvent(event);
      }

      function postResult(request: HostRequest, result: unknown) {
        dispatchHostMessage({
          id: request.id,
          result,
          type: 'remux/response',
        });
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
            if (runtime.status === 'running') {
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
            return {
              invalidations: [
                {
                  key: 'threadOperationQueue:mock-thread-1',
                  reason: 'commandAccepted',
                  threadId: 'mock-thread-1',
                  type: 'threadOperationQueue',
                },
              ],
              delivery: runtime.status === 'running' ? 'queued' : 'sent',
              status: 'accepted',
              threadId: 'mock-thread-1',
              turnId: runtime.status === 'running' ? undefined : 'mock-turn-1',
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
                start: semanticTarget ? index : index + 0.1,
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
      threadCwd,
      tokenUsage,
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
    await expect(markdown.locator('[data-narration-block-id="md:0"]')).toHaveClass(/codex-md-block-narrating/);
    expect(await markdown.evaluate((element) => element.getBoundingClientRect().height)).toBe(heightBeforeNarration);

    await page.locator('.remux-transcript-viewport').dispatchEvent('wheel');
    await expect(composer.getByRole('button', { name: 'Enable narration auto-scroll' })).toBeVisible();
    await composer.getByRole('button', { name: 'Enable narration auto-scroll' }).click();
    await expect(composer.getByRole('button', { name: 'Disable narration auto-scroll' })).toBeVisible();

    await composer.getByRole('button', { name: 'Next narrated block' }).click();
    await expect(markdown.locator('[data-narration-block-id="md:1"]')).toHaveClass(/codex-md-block-narrating/);
    await expect(composer.getByRole('button', { name: 'Previous narrated block' })).toBeEnabled();
    await composer.getByRole('button', { name: 'Previous narrated block' }).click();
    await expect(markdown.locator('[data-narration-block-id="md:0"]')).toHaveClass(/codex-md-block-narrating/);

    await composer.getByRole('button', { name: 'Play narration' }).click();
    await expect(composer.getByRole('button', { name: 'Pause narration' })).toBeVisible();
    await expect(markdown.locator('.codex-md-narrated-word')).toBeVisible();
    expect(await markdown.evaluate((element) => element.getBoundingClientRect().height)).toBe(heightBeforeNarration);
    await composer.getByRole('button', { name: 'Pause narration' }).click();

    await composer.getByRole('button', { name: 'Narration speed 1×' }).click();
    await expect(page.getByRole('menuitemradio')).toHaveCount(5);
    await page.getByRole('menuitemradio', { name: '1.5×' }).click();
    await expect(composer.getByRole('button', { name: 'Narration speed 1.5×' })).toBeVisible();

    await composer.getByRole('button', { name: 'Close narration' }).click();
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
    await expect(target).toHaveClass(/codex-md-block-narrating/);

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

  test('resolves semantic narration cues to table cells without changing layout', async ({ page }) => {
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
    await page.locator('[data-remux-composer-root]').getByRole('button', { name: 'Play narration' }).click();
    await expect(markdown.locator('.codex-md-table-cell.codex-md-target-narrating')).toBeVisible();
    expect(await markdown.evaluate((element) => element.getBoundingClientRect().height)).toBe(initialHeight);
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
    const second = page.locator('[data-narration-block-id="md:1"]');
    await expect(second).toHaveClass(/codex-md-block-narrating/, { timeout: 3_000 });
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
