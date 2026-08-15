import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const codingAgentRoot = fileURLToPath(new URL(
  '../node_modules/@earendil-works/pi-coding-agent/',
  import.meta.url,
));
const piAiRoot = fileURLToPath(new URL(
  '../node_modules/@earendil-works/pi-ai/',
  import.meta.url,
));
const nestedPiAiRoot = `${codingAgentRoot}node_modules/@earendil-works/pi-ai/`;
const piAiRoots = [piAiRoot, nestedPiAiRoot];
const expectedVersion = '0.84.0';

for (const [name, root] of [
  ['@earendil-works/pi-coding-agent', codingAgentRoot],
  ['@earendil-works/pi-ai', piAiRoot],
  ['@earendil-works/pi-coding-agent/@earendil-works/pi-ai', nestedPiAiRoot],
]) {
  const packageJson = JSON.parse(await readFile(`${root}package.json`, 'utf8'));
  if (packageJson.version !== expectedVersion) {
    throw new Error(`Refusing to patch ${name} ${packageJson.version}; expected ${expectedVersion}.`);
  }
}

const baseReplacements = [
  {
    root: codingAgentRoot,
    path: 'dist/core/agent-session.js',
    before: `    async _handlePostAgentRun() {`,
    after: `    /** Continue from an already-materialized user or tool-result boundary. */
    async continue() {
        this._isAgentRunActive = true;
        try {
            await this.agent.continue();
            while (await this._handlePostAgentRun()) {
                await this.agent.continue();
            }
        }
        finally {
            this._systemPromptOverride = undefined;
            this._flushPendingBashMessages();
            await this._emitAgentSettled();
        }
    }
    async _handlePostAgentRun() {`,
  },
  {
    root: codingAgentRoot,
    path: 'dist/core/agent-session.d.ts',
    before: `    private _handlePostAgentRun;`,
    after: `    /** Continue from an already-materialized user or tool-result boundary. */
    continue(): Promise<void>;
    private _handlePostAgentRun;`,
  },
  {
    root: codingAgentRoot,
    path: 'dist/core/sdk.js',
    before: [
      `    const extensionRunnerRef = {};
    agent = new Agent({`,
      `    const extensionRunnerRef = {};
    const providerSessionId = options.providerSessionId;
    const providerWebSocketFaultAfterEvents = options.providerWebSocketFaultAfterEvents;
    agent = new Agent({`,
    ],
    after: `    const extensionRunnerRef = {};
    const providerSessionId = options.providerSessionId;
    const providerWebSocketFaultAfterEvents = options.providerWebSocketFaultAfterEvents;
    options.registerProviderTransportControls?.({
        close: closeOpenAICodexWebSocketSessions,
        getStats: getOpenAICodexWebSocketDebugStats,
        resetStats: resetOpenAICodexWebSocketDebugStats,
    });
    agent = new Agent({`,
  },
  {
    root: codingAgentRoot,
    path: 'dist/core/sdk.js',
    before: `import { clampThinkingLevel, streamSimple } from "@earendil-works/pi-ai/compat";`,
    after: `import { clampThinkingLevel, streamSimple } from "@earendil-works/pi-ai/compat";
import { closeOpenAICodexWebSocketSessions, getOpenAICodexWebSocketDebugStats, resetOpenAICodexWebSocketDebugStats } from "@earendil-works/pi-ai/api/openai-codex-responses";`,
  },
  {
    root: codingAgentRoot,
    path: 'dist/core/sdk.js',
    before: `                ...options,
                timeoutMs,`,
    after: `                ...options,
                websocketSessionId: providerSessionId?.() ?? options?.sessionId,
                debugWebSocketDropAfterEvents: providerWebSocketFaultAfterEvents?.(),
                timeoutMs,`,
  },
  {
    root: codingAgentRoot,
    path: 'dist/core/sdk.js',
    before: `        onPayload: async (payload, _model) => {
            const runner = extensionRunnerRef.current;
            if (!runner?.hasHandlers("before_provider_request")) {
                return payload;
            }
            return runner.emitBeforeProviderRequest(payload);
        },`,
    after: `        onPayload: async (payload, _model) => {
            const runner = extensionRunnerRef.current;
            const nextPayload = runner?.hasHandlers("before_provider_request")
                ? await runner.emitBeforeProviderRequest(payload)
                : payload;
            await options.providerPreflight?.(nextPayload, _model);
            return nextPayload;
        },`,
  },
  {
    root: codingAgentRoot,
    path: 'dist/core/sdk.d.ts',
    before: [
      `    /** Session start event metadata for extension runtime startup. */
    sessionStartEvent?: SessionStartEvent;`,
      `    /**
     * Host-owned fail-closed gate called with the final payload after extension transforms.
     * A rejection aborts provider dispatch.
     */
    providerPreflight?: (payload: unknown, model: Model<any>) => void | Promise<void>;
    /**
     * Host-selected cache/session identity for each provider request.
     * Remux uses this to preserve independent continuation lanes per execution scope.
     */
    providerSessionId?: () => string;
    /** Test-only fault hook evaluated once per provider request. */
    providerWebSocketFaultAfterEvents?: () => number | undefined;
    /** Session start event metadata for extension runtime startup. */
    sessionStartEvent?: SessionStartEvent;`,
    ],
    after: `    /**
     * Host-owned fail-closed gate called with the final payload after extension transforms.
     * A rejection aborts provider dispatch.
     */
    providerPreflight?: (payload: unknown, model: Model<any>) => void | Promise<void>;
    /**
     * Host-selected cache/session identity for each provider request.
     * Remux uses this to preserve independent continuation lanes per execution scope.
     */
    providerSessionId?: () => string;
    /** Test-only fault hook evaluated once per provider request. */
    providerWebSocketFaultAfterEvents?: () => number | undefined;
    /** Supplies controls from the exact pi-ai module instance used by this session. */
    registerProviderTransportControls?: (controls: {
        close(sessionId?: string): void;
        getStats(sessionId: string): {
            requests: number;
            connectionsCreated: number;
            connectionsReused: number;
            fullContextRequests: number;
            deltaRequests: number;
            websocketFailures: number;
            sseFallbacks: number;
        } | undefined;
        resetStats(sessionId?: string): void;
    }) => void;
    /** Session start event metadata for extension runtime startup. */
    sessionStartEvent?: SessionStartEvent;`,
  },
  {
    root: piAiRoot,
    path: 'dist/api/openai-codex-responses.js',
    before: `            const cacheSessionId = options?.cacheRetention === "none" ? undefined : options?.sessionId;
            const codexSessionId = clampOpenAIPromptCacheKey(cacheSessionId);`,
    after: `            const cacheSessionId = options?.cacheRetention === "none"
                ? undefined
                : (options?.websocketSessionId ?? options?.sessionId);
            const codexSessionId = clampOpenAIPromptCacheKey(options?.sessionId);`,
  },
  {
    root: piAiRoot,
    path: 'dist/api/openai-codex-responses.d.ts',
    before: `export interface OpenAICodexResponsesOptions extends StreamOptions {
    reasoningEffort?:`,
    after: `export interface OpenAICodexResponsesOptions extends StreamOptions {
    /** Local cached-WebSocket identity, independent from the provider prompt-cache key. */
    websocketSessionId?: string;
    /** Test-only: close the WebSocket after this many mapped response events. */
    debugWebSocketDropAfterEvents?: number;
    reasoningEffort?:`,
  },
  {
    root: piAiRoot,
    path: 'dist/api/openai-codex-responses.js',
    before: 'const SESSION_WEBSOCKET_CACHE_TTL_MS = 5 * 60 * 1000;',
    after: 'const SESSION_WEBSOCKET_CACHE_TTL_MS = 45 * 60 * 1000;',
  },
  {
    root: piAiRoot,
    path: 'dist/api/openai-codex-responses.js',
    before: [
      `async function* startWebSocketOutputOnFirstEvent(events, onStart) {
    let started = false;
    for await (const event of events) {
        if (!started) {
            started = true;
            onStart();
        }
        yield event;
    }
}`,
      `async function* startWebSocketOutputOnFirstEvent(events, onStart, socket, dropAfterEvents) {
    let started = false;
    let eventCount = 0;
    for await (const event of events) {
        if (!started) {
            started = true;
            onStart();
        }
        yield event;
        eventCount++;
        if (dropAfterEvents !== undefined && eventCount >= dropAfterEvents) {
            dropAfterEvents = undefined;
            closeWebSocketSilently(socket, 1011, "debug_injected_drop");
        }
    }
}`,
      `async function* startWebSocketOutputOnFirstEvent(events, onStart, socket, dropAfterEvents) {
    let started = false;
    let eventCount = 0;
    for await (const event of events) {
        if (!started) {
            started = true;
            onStart();
        }
        yield event;
        eventCount++;
        if (dropAfterEvents !== undefined && eventCount >= dropAfterEvents) {
            dropAfterEvents = undefined;
            if (typeof socket.terminate === "function") {
                socket.terminate();
            }
            else {
                closeWebSocketSilently(socket, 1011, "debug_injected_drop");
            }
        }
    }
}`,
    ],
    after: `async function* startWebSocketOutputOnFirstEvent(events, onStart, socket, dropAfterEvents) {
    let started = false;
    let eventCount = 0;
    for await (const event of events) {
        if (!started) {
            started = true;
            onStart();
        }
        yield event;
        eventCount++;
        if (dropAfterEvents !== undefined && eventCount >= dropAfterEvents) {
            dropAfterEvents = undefined;
            throw new Error("WebSocket error: debug injected response-started drop");
        }
    }
}`,
  },
  {
    root: piAiRoot,
    path: 'dist/api/openai-codex-responses.js',
    before: 'startWebSocketOutputOnFirstEvent(mapCodexEvents(parseWebSocket(socket, options?.signal, idleTimeoutMs)), onStart)',
    after: 'startWebSocketOutputOnFirstEvent(mapCodexEvents(parseWebSocket(socket, options?.signal, idleTimeoutMs)), onStart, socket, options?.debugWebSocketDropAfterEvents)',
  },
  {
    root: piAiRoot,
    path: 'dist/api/openai-codex-responses.js',
    before: `    return stream(model, context, {
        ...base,
        reasoningEffort,
    });`,
    after: `    return stream(model, context, {
        ...base,
        websocketSessionId: options?.websocketSessionId,
        debugWebSocketDropAfterEvents: options?.debugWebSocketDropAfterEvents,
        reasoningEffort,
    });`,
  },
];

const replacements = baseReplacements.flatMap((replacement) =>
  replacement.root === piAiRoot
    ? piAiRoots.map((root) => ({ ...replacement, root }))
    : [replacement]);

const patchedFiles = new Map();
for (const replacement of replacements) {
  const path = `${replacement.root}${replacement.path}`;
  const contents = patchedFiles.get(path) ?? await readFile(path, 'utf8');
  if (contents.includes(replacement.after)) continue;
  const candidates = Array.isArray(replacement.before) ? replacement.before : [replacement.before];
  const matches = candidates
    .map((before) => ({ before, occurrences: contents.split(before).length - 1 }))
    .filter(({ occurrences }) => occurrences > 0)
    .sort((left, right) => right.before.length - left.before.length);
  const match = matches[0];
  if (!match || match.occurrences !== 1) {
    throw new Error(
      `Refusing to patch ${replacement.path}: expected one known Pi ${expectedVersion} seam, found ${match?.occurrences ?? 0}.`,
    );
  }
  patchedFiles.set(path, contents.replace(match.before, replacement.after));
}

for (const [path, contents] of patchedFiles) {
  await writeFile(path, contents);
}
