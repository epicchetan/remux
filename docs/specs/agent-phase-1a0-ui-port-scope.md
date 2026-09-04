Status: Archived
Last verified: 2026-08-07
Canonical code: Phase 1A.0a–1A.0d are implemented and owner-accepted in `extensions/agent/`; checkpoint `8e96512f06ea354bd54f84f5e783161b786e1696`
Superseded by: `agent-native-provider-runtime-v1.md`. The accepted viewer-port
evidence remains; the Pi-era implementation sequence is historical.

# Agent Phase 1A.0 UI port foundation scope

This is the implementation contract for the first post-Phase-0 checkpoint.
It refines
[`agent-ui-parity-and-phased-delivery.md`](agent-ui-parity-and-phased-delivery.md)
into an exact source, protocol, test, and acceptance boundary.

The owner must approve this document before implementation starts. Approval
authorizes only Phase 1A.0. It does not authorize the durable journal, history,
epoch compilation, new coding tools, or any later interaction feature.

## Checkpoint outcome

Phase 1A.0 replaces the preview UI with the proven Codex transcript/composer
foundation while retaining the accepted Phase 0 runtime:

- one ephemeral in-memory conversation at a time;
- Pi 0.84.0 and the owner's `openai-codex` subscription;
- device-code sign-in/sign-out and entitled model discovery;
- model and reasoning selection before a conversation starts;
- plain-text messages, streaming, interruption, and reconnect;
- `workspace.read` as the only model tool; and
- no conversation recovery after an Agent extension restart.

The backend gains an **in-memory turn projector**, not durable storage. It
converts Phase 0 runtime events into the same bounded, server-authoritative
turn-frame shape the journal will feed later. The viewer stops consuming the
flat `TranscriptItem[]` preview format.

After the checkpoint, the normal surface has the mature Codex transcript,
Markdown, work disclosure, scrolling, composer, keyboard, lifecycle, and
responsive behavior available for the Phase 0 feature set. It does not show
controls for capabilities the Agent server does not yet implement.

## Frozen inputs

- Codex viewer source baseline:
  `47703785ea70d43e24ac575baa6693017cc948c0`.
- Agent integration baseline: the owner-accepted Phase 0 worktree described by
  the parent and durable-core specs.
- Pi version: `0.84.0`.
- Transcript projection name: `agent-turn-render-v1`.
- Agent transcript protocol version: `1`.
- Existing `extensions/codex/` remains unchanged and runnable as the visual and
  behavioral comparison target.

If Codex viewer changes after the frozen commit, the implementation report
lists each selected or rejected later fix. There is no blind directory sync.

## In scope

1. Add an Agent-owned turn/work protocol and Phase 0 in-memory projector.
2. Port the stable transcript resource, layout, virtualization, scroll, and
   streaming-refresh algorithms.
3. Port Markdown, code, table, local-file-link, copy, work-row, disclosure, and
   duration rendering.
4. Port the text-only core of the Lexical composer, its action shell, model and
   reasoning picker, send/interrupt flow, and new-chat workspace presentation.
5. Port host status, route attachment, reconnect/resume, stale-generation
   fencing, mobile keyboard lift, safe-area, and responsive layout behavior.
6. Preserve the existing Agent auth flow in the new shell.
7. Copy and adapt the applicable Codex unit/Playwright evidence.
8. Remove narration and every other deliberately excluded or not-yet-backed
   UI branch from Agent production code.

## Out of scope

- SQLite, journal events, artifacts, migrations, replay, or restart recovery;
- conversation list/history, sidebar history, titles, previews, or switching;
- epoch snapshots, shadow compilation, context inspector, rollover, pull, or
  pin;
- workspace search/patch, shell, runtime tools, or processes;
- steer/follow-up queue, edit, fork, mentions, or attachments;
- narration, manual Compact, review mode, speed/service tier, quota/reset UI,
  approval/elicitation, collaboration/subagents, and web/research UI;
- importing Phase 0 or Codex history;
- App Server RPCs, generated Codex types, or a compatibility adapter; and
- changing or extracting the existing Codex viewer.

An in-memory transcript window is not durable history. It exists only while
the current Phase 0 extension process and conversation exist.

## Agent protocol contract

### Method boundary

The checkpoint keeps the existing Agent methods for auth, models,
conversation creation, message send, interruption, and generic resource reads.
It adds one transcript read method:

```ts
const AGENT_METHODS = {
  resourcesRead: 'remux/agent/resources/read',
  transcriptResourcesRead: 'remux/agent/transcript/resources/read',
  resourcesInvalidated: 'remux/agent/resources/invalidated',
  authLoginStart: 'remux/agent/auth/login/start',
  authLoginCancel: 'remux/agent/auth/login/cancel',
  authLogout: 'remux/agent/auth/logout',
  modelsRead: 'remux/agent/models/read',
  conversationStart: 'remux/agent/conversation/start',
  messageSend: 'remux/agent/conversation/message/send',
  turnInterrupt: 'remux/agent/conversation/turn/interrupt',
} as const;
```

`resources/read` remains responsible for `auth`, `models`, and
`conversation:<id>`. `transcript:<id>` becomes an invalidation identity, not a
generic value containing the whole transcript. Transcript windows and work
details are read only through `transcript/resources/read`.

There is no capabilities-negotiation endpoint in 1A.0. Both sides are in the
same extension bundle and send the pinned protocol/projection constants on
every sync. A mismatched version fails explicitly.

The existing `ConversationValue` remains the authoritative runtime/config
resource and gains one timing anchor:

```ts
export type ConversationValue = {
  id: string;
  cwd: string;
  modelId: string;
  reasoning: ReasoningLevel;
  status: 'idle' | 'running' | 'interrupting' | 'error';
  activeTurnId: string | null;
  activeTurnElapsedMs: number | null;
  contextProbe: ContextProbe;
  error: string | null;
};
```

`resources/read` materializes `activeTurnElapsedMs` from the server's internal
monotonic start anchor at read time. The viewer advances from that elapsed
anchor with `performance.now()`, avoiding server/phone wall-clock assumptions
and one invalidation per second. It is cleared only with the terminal turn
update. Model/reasoning choices are editable on the ephemeral new-chat draft;
after conversation creation the viewer displays the authoritative values and
requires starting another new chat to change them.

### Turn frames

These names and discriminants are fixed for the checkpoint:

```ts
export const AGENT_TRANSCRIPT_PROTOCOL_VERSION = 1 as const;
export const AGENT_TRANSCRIPT_PROJECTION_VERSION = 'agent-turn-render-v1' as const;

export type AgentTurnStatus =
  | 'queued'
  | 'inProgress'
  | 'completed'
  | 'failed'
  | 'interrupted';

export type AgentTurnError = {
  code: 'provider_error' | 'runtime_error';
  message: string;
};

export type AgentUserMessageSegment = {
  id: string;
  type: 'userMessage';
  clientMessageId: string | null;
  revision: string;
  text: string;
};

export type AgentAssistantMessageSegment = {
  id: string;
  type: 'assistantMessage';
  revision: string;
  text: string;
};

export type AgentWorkRenderSegment = {
  id: string;
  type: 'work';
  state: 'running' | 'completed' | 'failed' | 'interrupted';
  revision: string;
  layoutRevision: string;
  durationMs: number | null;
  timeline: AgentWorkTimelineEntry[];
};

export type AgentWorkTimelineEntry =
  | {
      id: string;
      type: 'text';
      revision: string;
      text: string;
    }
  | {
      id: string;
      type: 'group';
      revision: string;
      groupType: 'activity' | 'files' | 'text' | 'tools';
      title: string;
      status: 'running' | 'completed' | 'failed' | 'interrupted';
      rowCount: number;
      hasMoreRows: boolean;
    };

export type AgentTurnSegment =
  | AgentUserMessageSegment
  | AgentWorkRenderSegment
  | AgentAssistantMessageSegment;

export type AgentTurnRenderFrame = {
  id: string;
  status: AgentTurnStatus;
  startedAt: number | null;
  completedAt: number | null;
  durationMs: number | null;
  error: AgentTurnError | null;
  renderRevision: string;
  layoutRevision: string;
  segments: AgentTurnSegment[];
};
```

Timestamps are Unix epoch milliseconds. Revisions are opaque strings. During
1A.0 they are derived from monotonic in-memory counters, not content hashes;
the viewer may compare them only for equality.

Pi reasoning-summary deltas become `text` entries inside the work segment.
They are not assistant-final text and are not narration. `workspace.read`
calls become rows in an `activity` group. Raw Pi message objects, provider
call IDs, and provider payloads never enter these types.

There is no `compaction` segment. Epoch boundaries will later be inspector
metadata, not transcript messages.

### Transcript sync

```ts
export type AgentTranscriptSyncRequest = {
  type: 'transcriptSync';
  protocolVersion: typeof AGENT_TRANSCRIPT_PROTOCOL_VERSION;
  projectionVersion: typeof AGENT_TRANSCRIPT_PROJECTION_VERSION;
  knownConversationRevision?: string;
  knownTurns?: Array<{ turnId: string; renderRevision: string }>;
  window:
    | { kind: 'tail'; count?: number }
    | { kind: 'around'; turnId: string; before: number; after: number }
    | { kind: 'range'; startTurnId: string; endTurnId: string };
};

export type AgentTranscriptSyncResource = {
  protocolVersion: typeof AGENT_TRANSCRIPT_PROTOCOL_VERSION;
  projectionVersion: typeof AGENT_TRANSCRIPT_PROJECTION_VERSION;
  conversationId: string;
  conversationRevision: string;
  basisSequence: number;
  activeTurnId: string | null;
  turnOrder: string[];
  turns: AgentTurnRenderResult[];
  removedTurnIds: string[];
  window: {
    startIndex: number;
    endIndexExclusive: number;
    hasEarlier: boolean;
    hasLater: boolean;
    turnIds: string[];
  };
};

export type AgentTurnRenderResult =
  | {
      status: 'ok';
      turnId: string;
      renderRevision: string;
      frame: AgentTurnRenderFrame;
    }
  | {
      status: 'notModified';
      turnId: string;
      renderRevision: string;
    }
  | {
      status: 'error';
      turnId: string;
      code: 'frameTooLarge' | 'projectionFailed';
      message: string;
    };
```

`turnOrder` contains the IDs in the returned known window, ordered oldest to
newest; it is not an unbounded all-conversation index. `window.turnIds` is the
authoritative mounted range and normally equals `turnOrder` in 1A.0. The two
fields remain separate because later syncs may return `notModified` known turns
alongside window reconciliation.

Turns are append-only in Phase 0, so `removedTurnIds` is always empty. A turn
falling outside a requested window is not a removal; the window coordinates
control mounting. The field remains in the projection contract for later
journal-derived reconciliation.

The in-memory projector supports `tail`, `around`, and `range` so the copied
viewer algorithms can be exercised without inventing a second preview API.
This does not survive restart. Phase 1A.2 replaces the in-memory source with
journal projections and revalidates all window semantics.

Limits are fixed:

- default tail: 24 turns;
- default prepend: 16 turns;
- maximum returned window: 40 turns;
- maximum `knownTurns`: 80;
- maximum transcript response: 8 MiB; and
- maximum one render frame: 1 MiB.

Invalid limits, unknown window anchors, duplicate known-turn IDs, version
mismatches, and oversized output return typed RPC errors. They do not silently
fall back to the flat preview transcript.

### Work groups and details

The request union also contains:

```ts
export type AgentWorkGroupRequest = {
  type: 'workGroup';
  protocolVersion: 1;
  turnId: string;
  segmentId: string;
  groupId: string;
  cursor?: string;
  limit?: number;
  knownRevision?: string;
};

export type AgentWorkEntryDetailRequest = {
  type: 'workEntryDetail';
  protocolVersion: 1;
  turnId: string;
  segmentId: string;
  groupId: string;
  rowId: string;
  knownRevision?: string;
};
```

Group resources contain bounded row summaries. The production Phase 0
projector emits `activity` rows only:

```ts
export type AgentWorkActivityRow = {
  id: string;
  type: 'activity';
  revision: string;
  kind: 'read';
  status: 'running' | 'completed' | 'failed' | 'interrupted';
  text: string;
  path: string | null;
  durationMs: number | null;
  hasDetail: boolean;
};

export type AgentWorkFileChangeRow = {
  id: string;
  type: 'fileChange';
  revision: string;
  kind: 'added' | 'deleted' | 'edited' | 'moved';
  status: 'completed' | 'failed';
  path: string;
  additions: number;
  deletions: number;
  hasDetail: boolean;
};

export type AgentWorkToolRow = {
  id: string;
  type: 'tool';
  revision: string;
  category: 'generic';
  status: 'running' | 'completed' | 'failed' | 'interrupted';
  label: string;
  detailPreview: string | null;
  hasDetail: boolean;
};

export type AgentWorkTextRow = {
  id: string;
  type: 'text';
  revision: string;
  text: string;
  hasDetail: false;
};

export type AgentWorkRowSummary =
  | AgentWorkActivityRow
  | AgentWorkFileChangeRow
  | AgentWorkToolRow
  | AgentWorkTextRow;

export type AgentWorkGroupResource = {
  conversationId: string;
  turnId: string;
  segmentId: string;
  groupId: string;
  type: 'activity' | 'files' | 'text' | 'tools';
  title: string;
  revision: string;
  layoutRevision: string;
  rows: AgentWorkRowSummary[];
  nextCursor: string | null;
};
```

The viewer's pure presentation types may also render fixture-only file,
generic-tool, and text rows so copied renderers remain covered. The live
projector cannot emit those types until their later server checkpoints.

A detail resource uses the same envelope for sanitized activity arguments and
results, fixture-only file diffs, and fixture-only generic tool details:

```ts
export type AgentWorkEntryDetailResource = {
  conversationId: string;
  turnId: string;
  segmentId: string;
  groupId: string;
  rowId: string;
  revision: string;
  layoutRevision: string;
  detail:
    | {
        type: 'activity';
        detail: string | null;
        output: string | null;
      }
    | {
        type: 'fileChange';
        diff: string;
      }
    | {
        type: 'tool';
        detail: string | null;
        result: string | null;
      };
  truncation: {
    originalBytes: number;
    returnedBytes: number;
    truncated: boolean;
  };
};
```

Group limits are an allowlist of 50, 100, and 200 rows, capped at 256. One
detail response is capped at 64 KiB. Phase 0 `workspace.read` is already capped
below that, so a successful live read remains fully inspectable. The browser
does not receive arbitrary local paths to read on its own.

### Read envelope

```ts
export type AgentTranscriptResourcesReadParams = {
  conversationId: string;
  requests: Array<
    | AgentTranscriptSyncRequest
    | AgentWorkGroupRequest
    | AgentWorkEntryDetailRequest
  >;
};

export type AgentTranscriptResourceResult = {
  requestIndex: number;
  key: string;
  status: 'ok' | 'notModified' | 'missing' | 'error';
  revision?: string;
  reason?: string;
  value?: unknown;
};

export type AgentTranscriptResourcesReadResult = {
  conversationId: string;
  serverGeneration: string;
  resources: AgentTranscriptResourceResult[];
};
```

Every response carries the current `serverGeneration`. A generation change
clears known revisions and Phase 0 conversation state before another read.

### Invalidations

The invalidation notification becomes descriptive rather than a bare list of
keys:

```ts
export type AgentResourceInvalidation =
  | {
      type: 'resource';
      key: 'auth' | 'models' | `conversation:${string}`;
      reason: 'created' | 'updated' | 'deleted';
    }
  | {
      type: 'transcript';
      key: `transcript:${string}`;
      conversationId: string;
      turnId?: string;
      reason: 'sendAccepted' | 'runtimeEvent' | 'terminal';
      affectsOrder: boolean;
      affectsLayout: boolean;
    }
  | {
      type: 'workGroup';
      key: string;
      conversationId: string;
      turnId: string;
      segmentId: string;
      groupId: string;
      reason: 'runtimeEvent' | 'terminal';
      affectsLayout: boolean;
    }
  | {
      type: 'workEntryDetail';
      key: string;
      conversationId: string;
      turnId: string;
      segmentId: string;
      groupId: string;
      rowId: string;
      reason: 'runtimeEvent' | 'terminal';
      affectsLayout: boolean;
    };

export type ResourcesInvalidatedParams = {
  invalidations: AgentResourceInvalidation[];
  serverGeneration: string;
};
```

Send acceptance and turn-order changes refresh immediately. Streaming-only
render changes use the copied 125 ms leading/catch-up scheduler. Invalidations
received while inactive are marked dirty and verified once active. Work detail
invalidation never forces an unrelated whole-transcript layout reset.

## Projection rules

The new `EphemeralTranscriptProjector` is the single Phase 0 owner of turn
presentation:

1. `message/send` validates the request, creates one turn and user segment,
   records the client message ID, increments `basisSequence`, publishes the
   order-affecting invalidation, and only then starts `runtime.prompt()`.
2. Runtime callbacks are associated with the active turn by the server closure;
   provider IDs are not UI IDs.
3. Reasoning-summary deltas append/update a work text entry.
4. Tool start creates one Agent-owned activity row keyed internally by Pi
   `callId`; updates and completion mutate that row without exposing `callId`.
5. Assistant text creates or updates the current assistant segment.
6. Interrupt moves conversation status to `interrupting`, but only the runtime
   terminal callback publishes the final `interrupted` frame.
7. Provider/runtime failure sets `turn.error` and one `failed` terminal frame;
   no extra viewer-invented error transcript item is appended.
8. A completed/interrupted/failed turn is immutable. Late callbacks are ignored
   and tested.
9. Every visible mutation increments `basisSequence`, the affected segment and
   render revisions, and `layoutRevision` whenever height/order may change.
10. Work arguments/results are sanitized and bounded before entering projector
    state. Credentials and raw provider payloads remain prohibited.

The projector is intentionally disposable. Phase 1A.1 replaces its storage
with journal materialization while preserving the protocol and renderer.

## Exact production file scope

All paths below are repository-relative.

### Existing Agent files modified

| File | Authorized change |
| --- | --- |
| `extensions/agent/package.json` | Add UI dependencies and split server/unit/viewer scripts |
| `package-lock.json` | Lock only the added Agent dependencies |
| `extensions/agent/shared/protocol.ts` | Retain auth/model/command types; remove flat transcript value; add invalidation envelope imports |
| `extensions/agent/server/src/agent-server.ts` | Drive the projector and transcript read method; preserve auth/Pi/tool behavior |
| `extensions/agent/server/src/resources.ts` | Publish typed resource invalidations; generic resources no longer store the transcript |
| `extensions/agent/server/src/fixture-engine.ts` | Add deterministic streaming, long Markdown, multi-read, interruption, and failure scenarios |
| `extensions/agent/viewer/src/App.tsx` | Replace preview layout with Agent shell assembled from ported components |
| `extensions/agent/viewer/src/main.tsx` | Import the ported style layers; keep `mountViewer`/viewer-kit initialization |
| `extensions/agent/viewer/src/styles.css` | Move retained Agent auth-only styling, then delete after the new root style files own it |
| `extensions/agent/viewer/vite.config.ts` | Add Tailwind plugin and Agent-local aliases only |
| `extensions/agent/playwright.config.ts` | Match both Agent viewer spec files and retain desktop/mobile projects |
| `extensions/agent/tests/server.test.ts` | Convert transcript assertions to turn frames and add projector/window/detail cases |
| `extensions/agent/tests/viewer.spec.ts` | Move common mock host setup to a fixture helper and retain auth/new-chat/reconnect/error cases |

`viewer/index.html`, `remux-extension.json`, Pi runtime/auth code,
`workspace-read.ts`, JSON-RPC framing, and the server build configuration are
not changed unless implementation reveals a compile-only import adjustment.
Any such deviation is reported before expanding behavior.

### New Agent-owned server/shared files

| Destination | Purpose |
| --- | --- |
| `extensions/agent/shared/transcript.ts` | The exact turn, sync, group, detail, limits, and invalidation types above |
| `extensions/agent/server/src/transcript-projector.ts` | In-memory turns, revisions, window selection, render projection, work resources, and terminal fencing |

No file under `extensions/codex/shared/` is copied or imported.

### Viewer shell and IPC ports

| Codex source at the frozen commit | Agent destination/treatment |
| --- | --- |
| `extensions/codex/viewer/App.tsx` | `extensions/agent/viewer/src/App.tsx`; port geometry/lifecycle shell, replace all thread/history/narration branches |
| `extensions/codex/viewer/ipc/hostStore.ts` | `extensions/agent/viewer/src/ipc/hostStore.ts`; rename types only |
| `extensions/codex/viewer/ipc/types.ts` | `extensions/agent/viewer/src/ipc/types.ts`; provider-neutral aliases |
| `extensions/codex/viewer/ipc/resourceInvalidations.ts` | `extensions/agent/viewer/src/ipc/resourceInvalidations.ts`; Agent parser/deduper and only active stores |
| `extensions/codex/viewer/ipc/transcript.ts` | `extensions/agent/viewer/src/ipc/transcript.ts`; Agent method/types, no capabilities or Codex fallback |
| `extensions/codex/viewer/resumeSync.ts` | `extensions/agent/viewer/src/resumeSync.ts`; sync auth/models/current conversation/transcript only |
| `extensions/codex/viewer/threads/runtimeStore.ts` | `extensions/agent/viewer/src/conversation/runtimeStore.ts`; read Agent status/turn/timing from the conversation resource |
| `extensions/codex/viewer/threads/newChat/DirectoryPicker.tsx` | `extensions/agent/viewer/src/conversation/DirectoryPicker.tsx`; current Agent bounded directory RPC |
| `extensions/codex/viewer/threads/threadFormat.ts` | `extensions/agent/viewer/src/conversation/format.ts`; path/title helpers needed by the shell |
| `extensions/codex/viewer/ui/KeyboardPicker.tsx` | `extensions/agent/viewer/src/ui/KeyboardPicker.tsx`; shared keyboard/focus/list presentation for the directory picker |

New `extensions/agent/viewer/src/ipc/resources.ts` extracts the current generic
resource read, revision, and `serverGeneration` handling from the preview
`App.tsx`. New `extensions/agent/viewer/src/conversation/store.ts` owns only the
current ephemeral draft/conversation/workspace; it is not a history store.

The Codex sidebar, history store, operation-queue store, composer-state store,
sidebar store, and full threads store are not copied in 1A.0.

### Transcript ports

The following Codex files are copied to the same relative path under
`extensions/agent/viewer/src/transcript/` and adapted to Agent names/types:

```text
index.ts
debug.ts
disclosureKeys.ts
externalStore.ts
store.ts
resourceStore.ts
layoutStore.ts
streamingRefreshPolicy.ts
streamingRefreshScheduler.ts
viewportStore.ts
virtualizer.tsx
virtualizerRange.ts
virtualizerScroll.ts
layout/constants.ts
layout/measureCache.ts
layout/measureCollapsed.ts
layout/reconcileMeasured.ts
layout/types.ts
model/userMessageContent.ts
components/assistantMessage.tsx
components/userMessage.tsx
components/diff/DiffBlock.tsx
components/file/FileReferenceChip.tsx
components/file/fileTypeIcons.tsx
components/markdown/CodeBlock.tsx
components/markdown/MarkdownBlock.tsx
components/markdown/codeHighlight.ts
components/markdown/markdownModel.ts
components/work/WorkSection.tsx
components/work/WorkingDuration.tsx
components/work/workDuration.ts
```

Required adaptations are bounded:

- delete Codex protocol Version 1 and capabilities fallback from
  `resourceStore.ts`; Agent has one versioned sync path;
- use `conversationId` instead of `threadId` and Agent invalidations;
- replace Codex transcript/work types with `shared/transcript.ts`;
- make user-message content plain text plus `clientMessageId` only;
- remove compaction branches and types;
- remove edit/fork/narrate actions from message components, retaining copy;
- remove operation-queue and narration-follow viewport state;
- remove narration block/text-leaf registration from Markdown;
- preserve Markdown block IDs solely for render/layout identity;
- keep work group/detail lazy loading and generic fixture render variants; and
- retain layout constants/selectors unless an excluded row made one invalid.

`components/compaction.tsx`, `model/userMessageMarkdown.ts`, and
`components/work/mediaTypes.ts` are not copied. Codex structured input spans,
media reads, web rows, approvals, and compaction are not part of the Agent
protocol.

### Composer ports

| Codex source | Agent treatment |
| --- | --- |
| `composer/content.tsx` | Copy; remove edit, narration, queue context strip |
| `composer/actions/ActionButtons.tsx` | Copy; retain overview, transcript navigation, config, send, interrupt; remove history/attachment/narration/queue modes |
| `composer/actions/ActionKey.tsx` | Copy behavior |
| `composer/actions/InlineStatus.tsx` | Adapt to current model/reasoning only; no usage/quota |
| `composer/actions/StatusMessageRow.tsx` | Adapt to Agent runtime/submission errors |
| `composer/actions/turnAction.ts` | Replace Codex commands with Agent create/send/interrupt and authoritative invalidation flow |
| `composer/config/ConfigButton.tsx` | Retain model, reasoning, reload; delete Compact, review, and speed branches |
| `composer/config/modelSelection.ts` | Adapt to `ModelInfo` and `defaultModelId` |
| `composer/config/types.ts` | Define only model/reasoning presentation types |
| `composer/editor/ComposerEditor.tsx` | Copy Lexical plain-text, history, focus, multiline-enter, and readonly behavior; remove custom nodes/plugins |
| `composer/editor/LexicalInput.tsx` | Copy focus/controller/snapshot behavior; remove attachment reads and rail |
| `composer/model/composerModel.ts` | Reduce to text document/snapshot/content key while retaining stable IDs |
| `composer/model/sendProjection.ts` | Produce trimmed Agent text only |
| `composer/newChat/NewChatBar.tsx` | Adapt to current ephemeral draft/workspace |
| `composer/store.ts` | Agent-owned text/config/submission state; no edit/fork/mention/attachment/review/speed state |

These files land at the same paths under
`extensions/agent/viewer/src/composer/`. `editor/commands.ts`,
`editor/nodes.tsx`, and every `attachments/`, `edit/`, `mentions/`, and
`queue/` file are not copied in 1A.0.

### Styles and build

| Codex source | Agent destination/treatment |
| --- | --- |
| `extensions/codex/viewer/app.css` | `extensions/agent/viewer/app.css`; copy Tailwind/viewer-kit imports and change `@source` root |
| `extensions/codex/viewer/styles.css` | `extensions/agent/viewer/styles.css`; copy relevant blocks, preserve working selectors, delete excluded feature blocks |
| `extensions/codex/viewer/vite.config.ts` | Adapt Tailwind plugin only in Agent's existing Vite config; no `@remux/codex` aliases |

Agent adds these direct dependencies at the versions already locked for Codex:

```text
@chenglou/pretext
@iconify/icons-vscode-icons
@lexical/react
lexical
lucide-react
mdast-util-from-markdown
mdast-util-gfm-table
micromark-extension-gfm-table
shiki
tailwindcss
tw-animate-css
zustand
```

`@remux/narration-client` and `@remux/codex` must not become Agent
dependencies. React, viewer-kit, Pi, and TypeBox remain as currently declared.

### Source explicitly not copied

```text
extensions/codex/viewer/narration/**
extensions/codex/viewer/transcript/components/compaction.tsx
extensions/codex/viewer/composer/attachments/**
extensions/codex/viewer/composer/edit/**
extensions/codex/viewer/composer/mentions/**
extensions/codex/viewer/composer/queue/**
extensions/codex/viewer/threads/Sidebar.tsx
extensions/codex/viewer/threads/historyStore.ts
extensions/codex/viewer/threads/operationQueueStore.ts
extensions/codex/viewer/threads/composerStateStore.ts
extensions/codex/viewer/threads/sidebarStore.ts
extensions/codex/viewer/threads/store.ts
extensions/codex/viewer/ipc/composerConfig.ts
extensions/codex/viewer/ipc/fileResources.ts
extensions/codex/viewer/ipc/files.ts
extensions/codex/viewer/ipc/media.ts
extensions/codex/viewer/ipc/operationQueue.ts
extensions/codex/viewer/ipc/threadCommands.ts
extensions/codex/viewer/ipc/threadResources.ts
extensions/codex/shared/**
```

Future included features return from their frozen Codex source only when the
matching Agent server semantics are scoped. Excluded product features never
return.

## Narration and product-exclusion removal checklist

The checkpoint fails if any item below remains in Agent production code or
the rendered surface:

### Narration

- no narration package dependency or import;
- no narration directory, store, client, playback action, bar, or paint
  controller;
- no Markdown block/text-leaf narration hooks;
- no narration viewport mode, selected-block lookup, or follow state;
- no narration CSS variables/selectors; and
- no Narrate action, preparation state, audio element, or media route.

### Other deliberate exclusions

- no `compaction` transcript variant or Compact action;
- no review or speed/service-tier state or controls;
- no quota/reset/credit/token-usage surface;
- no approval or elicitation row/control;
- no collaboration/subagent row/control;
- no specialized web/research row/control;
- no generated Codex/App Server type import; and
- no App Server method string or `@remux/codex` import.

### Later included features absent, not disabled

- no history/sidebar button;
- no attachment button, rail, native picker, data URL, or composer node;
- no mention trigger, picker, search, or composer node;
- no queue tray or “Queue message” label;
- no edit/fork actions, bars, targets, or submission modes; and
- no process controls.

Temporary `codex-*` CSS class names may remain where they preserve the stable
layout. They are explicitly allowed styling identifiers. Product-facing
“Codex” text, package imports, method names, and protocol types are not.

## Test and fixture contract

### Existing Agent evidence retained

- JSON-RPC parse/serialization ordering;
- auth redaction and matching login cancellation;
- resource revisions and `serverGeneration` changes;
- bounded `workspace_read` and path/symlink rejection;
- one server-authoritative terminal state;
- interrupt and conversation reuse;
- distinct client/conversation/turn/item identities;
- device-code UI and bounded directory selection; and
- route-addressed reconnect within one server generation.

Flat transcript assertions are rewritten against turn frames; they are not
kept as compatibility tests.

### Codex unit evidence copied

The following source test files are copied into Agent `*.test.ts` suites:

| Codex test source | Agent destination and selection |
| --- | --- |
| `extensions/codex/tests/streaming-refresh-scheduler.spec.ts` | `extensions/agent/tests/unit/streaming-refresh-scheduler.test.ts`; all cases |
| `extensions/codex/tests/transcript-debug.spec.ts` | `extensions/agent/tests/unit/transcript-debug.test.ts`; all cases, Agent log label |
| `extensions/codex/tests/work-duration.spec.ts` | `extensions/agent/tests/unit/work-duration.test.ts`; all cases |
| `extensions/codex/tests/markdown-model.spec.ts` | `extensions/agent/tests/unit/markdown-model.test.ts`; Markdown/list/link/code/table/layout cases; remove narration and mention-only assertions |
| `extensions/codex/tests/transcript-layout.spec.ts` | `extensions/agent/tests/unit/transcript-layout.test.ts`; measurement/cache/work-disclosure/range/native-scroll/sent-anchor/initial-position cases; remove narration, queue, attachment, mention, edit/fork action-row cases |
| `extensions/codex/tests/composer-model.spec.ts` | `extensions/agent/tests/unit/composer-model.test.ts`; text merge, whitespace, content key, and sendability only |
| `extensions/codex/tests/composer-send-projection.spec.ts` | `extensions/agent/tests/unit/composer-send-projection.test.ts`; text-only projection and empty rejection |

`composer-mention-*`, `user-message-markdown`, narration-real, attachment,
queue, edit, and fork tests are not copied in this checkpoint.

### New server protocol/projector tests

Add to `extensions/agent/tests/server.test.ts`:

1. one send creates one authoritative turn with user/work/assistant ordering;
2. reasoning and `workspace.read` events project into work without provider
   IDs;
3. known render revisions return `notModified` turn results;
4. tail/around/range selection respects 24/16/40/80 bounds;
5. unknown anchors and invalid versions fail explicitly;
6. group and detail reads are bounded and revision-aware;
7. send/order invalidation is immediate and streaming invalidations are
   descriptive;
8. interrupt yields one terminal frame and ignores late runtime callbacks;
9. provider failure yields one failed frame/error and no extra error message;
10. a new server generation cannot serve the prior ephemeral conversation;
11. transcript responses and frames enforce byte caps; and
12. auth/provider payload data cannot appear in render resources.

### Playwright fixture layout

- `extensions/agent/tests/viewer-fixture.ts` owns one reusable Agent mock host,
  resource revision model, transcript window builder, invalidation dispatcher,
  lifecycle controls, and generation reset.
- `extensions/agent/tests/viewer.spec.ts` retains Agent auth, new chat/model,
  interrupt, reconnect, restart-unavailable, and error scenarios.
- `extensions/agent/tests/viewer-parity.spec.ts` contains the copied/adapted
  Codex transcript/composer cases.
- `extensions/agent/playwright.config.ts` matches `viewer*.spec.ts` and runs
  both desktop and Pixel 5 projects.

Required Playwright scenarios:

| Scenario | Automated assertion |
| --- | --- |
| New chat defaults | Entitled default model and supported reasoning appear before opening preferences or sending |
| First send | Exactly one user segment and active turn; no optimistic duplicate |
| Streaming Markdown | Paragraph/list/table/code/file link grow without pathological width or unstable remount |
| Reasoning + read | Work opens while running, shows read row/detail, then collapses according to copied policy |
| Sent anchor | User message stays anchored while work height changes and assistant text appears |
| Manual scroll | A user scroll during streaming is not stolen; bottom following resumes only by policy |
| Long transcript | 60+ in-memory turns window/virtualize with bounded mounted rows and earlier/later navigation |
| Streaming refresh race | Older in-flight read cannot overwrite a newer send/tail sync |
| Background/resume | Invalidations defer while inactive and authoritative state verifies on activation |
| Interrupt | Stop remains usable; one interrupted frame; composer becomes reusable |
| Provider error | One failed turn/error row; no duplicate terminal mutation |
| Route reconnect | Same-generation route reconstructs transcript and model/reasoning |
| Generation change | Old conversation clears and shows explicit Phase 0 unavailable state |
| Mobile composer | Safe-area, focus, multiline input, keyboard lift, and transcript viewport remain stable |
| Exclusion surface | No Narrate, Compact, review, speed, history, attachment, mention, queue, edit, or fork control exists |

### Static boundary test

Add `extensions/agent/tests/unit/ui-boundary.test.ts` to inspect Agent
production imports and `package.json`. It fails on:

- `@remux/codex` or `extensions/codex` imports;
- `@remux/narration-client` or `viewer/narration` imports;
- generated Codex protocol imports;
- App Server RPC method prefixes;
- excluded dependency names; or
- source files under the explicitly forbidden destination directories.

The audit allows historical `codex-*` CSS selectors only.

## Side-by-side owner acceptance

Automated tests are necessary but do not close 1A.0. The implementation ends
with Codex and Agent running side-by-side from the same repository commit.

### Prepared prompts/fixtures

1. **Markdown corpus:** headings, nested lists, blockquote, GFM table, long
   unbroken token, local file link, inline/fenced code, and a long code line.
2. **Read flow:** request `README.md`, show reasoning summary, running read,
   read detail, final answer, duration, and disclosure transition.
3. **Streaming/scroll:** 60 prior fixture turns, slow answer deltas, manual
   upward scroll, work expansion, and explicit return to bottom.
4. **Interrupt/error:** one slow interruptible turn and one provider-error
   turn, followed by a successful reuse of the composer.
5. **Reconnect/lifecycle:** viewer close/open, socket reconnect, phone
   background/foreground, and extension restart.

### Owner review matrix

Review both desktop and the physical Remux phone path for:

- overall shell density and Agent auth placement;
- correct model/reasoning state on a fresh chat;
- transcript typography and Markdown fidelity;
- streaming stability and work disclosure behavior;
- sent-message anchoring and manual-scroll ownership;
- previous/next turn navigation;
- composer focus, multiline input, keyboard lift, and safe area;
- interrupt/error recovery and reconnect behavior;
- light/dark theme and responsive layout; and
- absence of every excluded/not-yet-backed control.

Visual differences are acceptable only when caused by Agent-specific auth or
the smaller Phase 0 capability set. Algorithmic scrolling, layout, rendering,
and composer-feel regressions block acceptance.

## Verification commands

The implementation report must include results for:

```sh
npm --workspace @remux/agent run build
npm --workspace @remux/agent run test:server
npm --workspace @remux/agent run test:unit
npm --workspace @remux/agent run test:viewer
npm run typecheck
npm run test:codex
git diff --check
```

The Codex suite is a regression check because the source baseline must remain
unchanged. Live OAuth/model use remains an owner-run acceptance step and must
not be placed in deterministic CI.

## Implementation sequence inside the checkpoint

Implementation remains one owner-approved checkpoint but is delivered in four
inspectable internal steps:

### 1A.0a — protocol and projector

Implementation status: complete on 2026-08-07.

- add `shared/transcript.ts` and `transcript-projector.ts`;
- migrate server tests from flat items to frames;
- add window/work/detail/revision/terminal tests; and
- keep this as a server-tested internal boundary until the viewer migration in
  1A.0b; 1A.0a is not a separately shippable extension build.

### 1A.0b — transcript and renderer

Implementation status: complete on 2026-08-07.

- port IPC/resource/layout/viewport/virtualizer modules;
- port Markdown, message, work, file, diff, and duration presentation;
- land copied unit fixtures; and
- switch the viewer fully to transcript sync resources.

### 1A.0c — composer and shell

Implementation status: complete for owner review on 2026-08-07.

- port the text-only Lexical composer and action shell;
- integrate auth, model/reasoning, new chat, send/interrupt, lifecycle, and
  mobile geometry; and
- remove the old preview CSS/layout.

### 1A.0d — hardening and acceptance

Implementation status: complete and owner-accepted on 2026-08-07 after the
live desktop/physical-phone comparison. Later checkpoints retain their own
scope and authorization boundaries.

- finish Playwright parity scenarios and static boundary audit;
- run Agent and unchanged Codex suites;
- run live desktop/phone side-by-side review; and
- record deviations, source commit, test results, and owner decision.

The implementation evidence and closed owner gate are recorded in
[`agent-phase-1a0-implementation-report.md`](agent-phase-1a0-implementation-report.md).

The owner may pause for Q&A after any internal step. Failure does not authorize
starting 1A.1 or pulling later capabilities forward.

## Exit gate

Phase 1A.0 is complete only when:

1. the Agent viewer consumes only Agent-owned bounded turn/work resources;
2. the flat `TranscriptItem[]` format is gone and no compatibility adapter was
   added;
3. required transcript/composer behavior matches the Codex baseline for the
   available Phase 0 feature set;
4. all copied/adapted and new tests pass on desktop/mobile projects;
5. Codex remains unchanged and its suite passes;
6. no narration, App Server, generated Codex protocol, or excluded/not-yet-
   backed production path remains;
7. live OAuth/read/stream/interrupt/reconnect/restart still passes;
8. the owner completes desktop/physical-phone comparison and explicitly
   accepts the checkpoint; and
9. an implementation report records every deviation from this scope.

Only then may a separate Phase 1A.1 scope note propose the durable journal and
conversation-history activation.
