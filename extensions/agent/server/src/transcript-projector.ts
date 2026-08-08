import { createHash, randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';

import {
  AGENT_TRANSCRIPT_PROJECTION_VERSION,
  AGENT_TRANSCRIPT_PROTOCOL_VERSION,
  DEFAULT_TRANSCRIPT_TAIL_TURNS,
  DEFAULT_WORK_GROUP_ROWS,
  MAX_TRANSCRIPT_KNOWN_TURNS,
  MAX_TRANSCRIPT_REQUESTS,
  MAX_TRANSCRIPT_RESPONSE_BYTES,
  MAX_TRANSCRIPT_WINDOW_TURNS,
  MAX_TURN_FRAME_BYTES,
  MAX_VISIBLE_TEXT_BYTES,
  MAX_WORK_ENTRY_DETAIL_BYTES,
  MAX_WORK_GROUP_ROWS,
  WORK_GROUP_ROW_LIMITS,
  workEntryDetailResourceKey,
  workGroupResourceKey,
  type AgentAssistantMessageSegment,
  type AgentResourceInvalidation,
  type AgentTextContentReference,
  type AgentTranscriptResourceRequest,
  type AgentTranscriptResourceResult,
  type AgentTranscriptResourcesReadParams,
  type AgentTranscriptResourcesReadResult,
  type AgentTranscriptSyncRequest,
  type AgentTranscriptSyncResource,
  type AgentTurnError,
  type AgentTurnRenderFrame,
  type AgentTurnRenderResult,
  type AgentTurnStatus,
  type AgentUserMessageSegment,
  type AgentWorkActivityRow,
  type AgentWorkEntryDetailRequest,
  type AgentWorkEntryDetailResource,
  type AgentWorkGroupRequest,
  type AgentWorkGroupResource,
  type AgentWorkGroupTimelineEntry,
  type AgentWorkRenderSegment,
  type AgentWorkTextTimelineEntry,
} from '../../shared/transcript.ts';

type ProjectorOptions = {
  conversationId: string;
  invalidate: (invalidations: AgentResourceInvalidation[]) => void;
  createId?: () => string;
  now?: () => number;
  monotonicNow?: () => number;
  limits?: {
    maxResponseBytes?: number;
    maxTurnFrameBytes?: number;
  };
};

type MutableTurn = {
  id: string;
  durableIdentity: boolean;
  assistantItemId: string | null;
  status: AgentTurnStatus;
  startedAt: number;
  startedMonotonicAt: number;
  completedAt: number | null;
  durationMs: number | null;
  error: AgentTurnError | null;
  interruptionReason: 'restart' | 'user' | null;
  renderRevision: string;
  layoutRevision: string;
  user: AgentUserMessageSegment;
  work: MutableWork | null;
  assistant: AgentAssistantMessageSegment | null;
  groups: Map<string, MutableGroup>;
  toolRowsByCallId: Map<string, MutableToolRow>;
};

type MutableWork = AgentWorkRenderSegment;

type MutableGroup = {
  id: string;
  type: 'activity';
  title: string;
  revision: string;
  layoutRevision: string;
  rows: AgentWorkActivityRow[];
  detailsByRowId: Map<string, MutableActivityDetail>;
};

type MutableToolRow = {
  group: MutableGroup;
  row: AgentWorkActivityRow;
  detail: MutableActivityDetail;
  startedMonotonicAt: number;
};

type MutableActivityDetail = {
  revision: string;
  layoutRevision: string;
  detail: string | null;
  output: string | null;
  originalBytes: number;
  detailContent?: AgentTextContentReference;
  outputContent?: AgentTextContentReference;
};

type WindowSelection = {
  startIndex: number;
  endIndexExclusive: number;
  turns: MutableTurn[];
};

type ProjectionMutation = {
  sequence?: number;
  basisSequence?: number;
  createdAt?: number;
  itemId?: string | null;
  content?: AgentTextContentReference;
};

export class TranscriptProtocolError extends Error {
  readonly code: number;

  constructor(code: number, message: string) {
    super(message);
    this.name = 'TranscriptProtocolError';
    this.code = code;
  }
}

export class EphemeralTranscriptProjector {
  readonly conversationId: string;
  private readonly createId: () => string;
  private readonly invalidate: (invalidations: AgentResourceInvalidation[]) => void;
  private readonly wallNow: () => number;
  private readonly monotonicNow: () => number;
  private readonly maxResponseBytes: number;
  private readonly maxTurnFrameBytes: number;
  private readonly turns: MutableTurn[] = [];
  private readonly turnsById = new Map<string, MutableTurn>();
  private basisSequence = 0;
  private conversationRevision = 'conversation:0';
  private activeTurnId: string | null = null;

  constructor(options: ProjectorOptions) {
    this.conversationId = options.conversationId;
    this.invalidate = options.invalidate;
    this.createId = options.createId ?? randomUUID;
    this.wallNow = options.now ?? Date.now;
    this.monotonicNow = options.monotonicNow
      ?? options.now
      ?? (() => performance.now());
    this.maxResponseBytes = options.limits?.maxResponseBytes ?? MAX_TRANSCRIPT_RESPONSE_BYTES;
    this.maxTurnFrameBytes = options.limits?.maxTurnFrameBytes ?? MAX_TURN_FRAME_BYTES;
  }

  beginTurn(input: {
    turnId: string;
    clientMessageId: string;
    text: string;
    sequence?: number;
    basisSequence?: number;
    createdAt?: number;
    userItemId?: string;
    content?: AgentTextContentReference;
  }) {
    if (this.activeTurnId) {
      throw new TranscriptProtocolError(-32013, 'A projected turn is already running.');
    }
    if (this.turnsById.has(input.turnId)) {
      throw new TranscriptProtocolError(-32602, 'turnId was already used.');
    }

    const startedAt = input.createdAt ?? this.wallNow();
    const startedMonotonicAt = this.monotonicNow();
    const revision = this.advanceRevision(input.sequence, `turn:${input.turnId}:user`);
    const turn: MutableTurn = {
      id: input.turnId,
      durableIdentity: input.userItemId !== undefined,
      assistantItemId: null,
      status: 'inProgress',
      startedAt,
      startedMonotonicAt,
      completedAt: null,
      durationMs: null,
      error: null,
      interruptionReason: null,
      renderRevision: revision,
      layoutRevision: revision,
      user: {
        id: input.userItemId ?? this.createId(),
        type: 'userMessage',
        clientMessageId: input.clientMessageId,
        revision,
        text: input.text,
        ...(input.content ? { content: input.content } : {}),
      },
      work: null,
      assistant: null,
      groups: new Map(),
      toolRowsByCallId: new Map(),
    };

    this.turns.push(turn);
    this.turnsById.set(turn.id, turn);
    this.activeTurnId = turn.id;
    if (input.basisSequence !== undefined) this.fenceBasis(input.basisSequence);
    this.publishTurnMutation(turn, 'sendAccepted', true, true);
  }

  assistantStarted(turnId: string) {
    return this.activeTurn(turnId) !== null;
  }

  appendAssistantText(
    turnId: string,
    delta: string,
    mutation: ProjectionMutation = {},
  ) {
    const turn = this.activeTurn(turnId);
    if (!turn || !delta) return false;

    const itemId = this.acceptAssistantItemId(turn, mutation.itemId);
    const revision = this.advanceRevision(
      mutation.sequence,
      `turn:${turnId}:assistant-text`,
    );
    turn.assistant ??= {
      id: itemId ?? this.createId(),
      type: 'assistantMessage',
      revision,
      text: '',
    };
    turn.assistant.text += delta;
    turn.assistant.revision = revision;
    if (mutation.content) turn.assistant.content = mutation.content;
    if (mutation.basisSequence !== undefined) this.fenceBasis(mutation.basisSequence);
    this.touchTurn(turn, revision, true);
    this.publishTurnMutation(turn, 'runtimeEvent', false, true);
    return true;
  }

  appendReasoning(
    turnId: string,
    delta: string,
    mutation: ProjectionMutation = {},
  ) {
    const turn = this.activeTurn(turnId);
    if (!turn || !delta) return false;

    const itemId = this.acceptAssistantItemId(turn, mutation.itemId);
    const revision = this.advanceRevision(
      mutation.sequence,
      `turn:${turnId}:assistant-reasoning`,
    );
    const work = this.ensureWork(turn, revision);
    const previous = work.timeline.at(-1);
    if (previous?.type === 'text') {
      previous.text += delta;
      previous.revision = revision;
      if (mutation.content) previous.content = mutation.content;
    } else {
      const runOrdinal = work.timeline.filter((entry) => entry.type === 'text').length;
      work.timeline.push({
        id: itemId
          ? projectionUuid(`${itemId}:reasoning:${runOrdinal}`)
          : this.createId(),
        type: 'text',
        revision,
        text: delta,
        ...(mutation.content ? { content: mutation.content } : {}),
      } satisfies AgentWorkTextTimelineEntry);
    }
    if (mutation.basisSequence !== undefined) this.fenceBasis(mutation.basisSequence);
    this.touchWork(turn, work, revision, true);
    this.publishTurnMutation(turn, 'runtimeEvent', false, true);
    return true;
  }

  startTool(turnId: string, input: {
    callId: string;
    name: string;
    args: unknown;
    detailText?: string;
    detailContent?: AgentTextContentReference;
    sequence?: number;
    basisSequence?: number;
    createdAt?: number;
    itemId?: string | null;
  }) {
    const turn = this.activeTurn(turnId);
    if (!turn || turn.toolRowsByCallId.has(input.callId)) return false;

    const revision = this.advanceRevision(input.sequence, `turn:${turnId}:tool-start:${input.callId}`);
    const work = this.ensureWork(turn, revision);
    const group = this.ensureActivityGroup(turn, work, revision);
    const path = toolPath(input.args);
    const detailText = input.detailText === undefined
      ? boundedSerializedValue(input.args)
      : {
          text: input.detailText,
          originalBytes: input.detailContent?.byteLength ?? byteLength(input.detailText),
        };
    const row: AgentWorkActivityRow = {
      id: input.itemId ?? this.createId(),
      type: 'activity',
      revision,
      kind: 'read',
      status: 'running',
      text: input.name === 'workspace.read'
        ? `Read ${path ?? 'workspace file'}`
        : sanitizeText(input.name).slice(0, 256),
      path,
      durationMs: null,
      hasDetail: true,
    };
    const detail: MutableActivityDetail = {
      revision,
      layoutRevision: revision,
      detail: detailText.text,
      output: null,
      originalBytes: detailText.originalBytes,
      ...(input.detailContent ? { detailContent: input.detailContent } : {}),
    };
    group.rows.push(row);
    group.detailsByRowId.set(row.id, detail);
    group.revision = revision;
    group.layoutRevision = revision;
    turn.toolRowsByCallId.set(input.callId, {
      group,
      row,
      detail,
      startedMonotonicAt: this.monotonicNow(),
    });
    if (input.basisSequence !== undefined) this.fenceBasis(input.basisSequence);
    this.refreshGroupTimeline(work, group, revision);
    this.touchWork(turn, work, revision, true);
    this.publishTurnMutation(turn, 'runtimeEvent', false, true, group, row.id);
    return true;
  }

  updateTool(turnId: string, input: {
    callId: string;
    result: unknown;
  }) {
    const turn = this.activeTurn(turnId);
    const tool = turn?.toolRowsByCallId.get(input.callId);
    if (!turn || !tool) return false;

    const revision = this.advanceRevision(undefined, `turn:${turnId}:tool-update:${input.callId}`);
    const output = boundedSerializedValue(input.result);
    tool.detail.output = output.text;
    tool.detail.originalBytes =
      (tool.detail.detailContent?.byteLength ?? byteLength(tool.detail.detail)) +
      output.originalBytes;
    tool.detail.revision = revision;
    tool.detail.layoutRevision = revision;
    tool.row.revision = revision;
    tool.group.revision = revision;
    tool.group.layoutRevision = revision;
    const work = turn.work;
    if (work) {
      this.refreshGroupTimeline(work, tool.group, revision);
      this.touchWork(turn, work, revision, true);
    } else {
      this.touchTurn(turn, revision, true);
    }
    this.publishTurnMutation(turn, 'runtimeEvent', false, true, tool.group, tool.row.id);
    return true;
  }

  endTool(turnId: string, input: {
    callId: string;
    result: unknown;
    isError: boolean;
    outputText?: string;
    outputContent?: AgentTextContentReference;
    sequence?: number;
    basisSequence?: number;
    createdAt?: number;
    itemId?: string | null;
  }) {
    const turn = this.activeTurn(turnId);
    const tool = turn?.toolRowsByCallId.get(input.callId);
    if (!turn || !tool) return false;

    if (input.itemId && input.itemId !== tool.row.id) {
      throw new TranscriptProtocolError(-32603, 'Durable tool identity changed during projection.');
    }
    const revision = this.advanceRevision(input.sequence, `turn:${turnId}:tool-end:${input.callId}`);
    const output = input.outputText === undefined
      ? boundedSerializedValue(input.result)
      : {
          text: input.outputText,
          originalBytes: input.outputContent?.byteLength ?? byteLength(input.outputText),
        };
    tool.row.status = input.isError ? 'failed' : 'completed';
    tool.row.durationMs = Math.max(0, this.monotonicNow() - tool.startedMonotonicAt);
    tool.row.revision = revision;
    tool.detail.output = output.text;
    tool.detail.originalBytes =
      (tool.detail.detailContent?.byteLength ?? byteLength(tool.detail.detail)) +
      output.originalBytes;
    if (input.outputContent) tool.detail.outputContent = input.outputContent;
    tool.detail.revision = revision;
    tool.detail.layoutRevision = revision;
    tool.group.revision = revision;
    tool.group.layoutRevision = revision;
    const work = turn.work;
    if (work) {
      this.refreshGroupTimeline(work, tool.group, revision);
      this.touchWork(turn, work, revision, true);
    } else {
      this.touchTurn(turn, revision, true);
    }
    if (input.basisSequence !== undefined) this.fenceBasis(input.basisSequence);
    this.publishTurnMutation(turn, 'runtimeEvent', false, true, tool.group, tool.row.id);
    return true;
  }

  finishTurn(turnId: string, input: {
    status: 'completed' | 'failed' | 'interrupted' | 'interrupted_by_restart';
    error?: AgentTurnError | null;
    sequence?: number;
    basisSequence?: number;
    createdAt?: number;
    durationMs?: number;
  }) {
    const turn = this.activeTurn(turnId);
    if (!turn) return false;

    const completedAt = input.createdAt ?? this.wallNow();
    const revision = this.advanceRevision(input.sequence, `turn:${turnId}:terminal:${input.status}`);
    const terminalStatus = input.status === 'interrupted_by_restart' ? 'interrupted' : input.status;
    turn.status = terminalStatus;
    turn.interruptionReason = input.status === 'interrupted_by_restart'
      ? 'restart'
      : input.status === 'interrupted'
        ? 'user'
        : null;
    turn.completedAt = completedAt;
    turn.durationMs = input.durationMs ?? Math.max(0, this.monotonicNow() - turn.startedMonotonicAt);
    turn.error = input.status === 'failed' ? input.error ?? {
      code: 'runtime_error',
      message: 'The turn failed.',
    } : null;
    this.activeTurnId = null;
    if (input.basisSequence !== undefined) this.fenceBasis(input.basisSequence);

    const invalidations: AgentResourceInvalidation[] = [];
    if (turn.work) {
      turn.work.state = terminalStatus;
      turn.work.durationMs = turn.durationMs;
      turn.work.revision = revision;
      turn.work.layoutRevision = revision;
      for (const group of turn.groups.values()) {
        for (const row of group.rows) {
          if (row.status === 'running') {
            row.status = terminalStatus;
            row.durationMs = turn.durationMs;
            row.revision = revision;
            const detail = group.detailsByRowId.get(row.id);
            if (detail) {
              detail.revision = revision;
              detail.layoutRevision = revision;
            }
          }
        }
        group.revision = revision;
        group.layoutRevision = revision;
        this.refreshGroupTimeline(turn.work, group, revision);
        invalidations.push(this.groupInvalidation(turn, group, 'terminal'));
        for (const row of group.rows) {
          invalidations.push(this.detailInvalidation(turn, group, row.id, 'terminal'));
        }
      }
    }
    this.touchTurn(turn, revision, true);
    invalidations.unshift(this.transcriptInvalidation(turn, 'terminal', false, true));
    this.invalidate(invalidations);
    return true;
  }

  activeElapsedMs() {
    const turn = this.activeTurnId ? this.turnsById.get(this.activeTurnId) : null;
    return turn ? Math.max(0, this.monotonicNow() - turn.startedMonotonicAt) : null;
  }

  fenceBasis(basisSequence: number) {
    if (!Number.isSafeInteger(basisSequence) || basisSequence < 0) {
      throw new TranscriptProtocolError(-32603, 'Transcript basis must be a non-negative safe integer.');
    }
    if (basisSequence < this.basisSequence) {
      throw new TranscriptProtocolError(-32603, 'Transcript basis cannot move backward.');
    }
    this.basisSequence = basisSequence;
    this.conversationRevision = `conversation:${basisSequence}`;
  }

  hasClientMessageId(clientMessageId: string) {
    return this.turns.some((turn) => turn.user.clientMessageId === clientMessageId);
  }

  read(
    params: AgentTranscriptResourcesReadParams,
    serverGeneration: string,
  ): AgentTranscriptResourcesReadResult {
    if (params.conversationId !== this.conversationId) {
      throw new TranscriptProtocolError(-32015, 'Conversation not found.');
    }

    const resources = params.requests.map((request, requestIndex) =>
      this.readRequest(request, requestIndex));
    const response: AgentTranscriptResourcesReadResult = {
      conversationId: this.conversationId,
      serverGeneration,
      resources,
    };
    if (serializedByteLength(response) > this.maxResponseBytes) {
      throw new TranscriptProtocolError(-32018, 'Transcript response exceeds the 8 MiB limit.');
    }
    return response;
  }

  private readRequest(
    request: AgentTranscriptResourceRequest,
    requestIndex: number,
  ): AgentTranscriptResourceResult {
    switch (request.type) {
      case 'transcriptSync':
        return this.readTranscriptSync(request, requestIndex);
      case 'workGroup':
        return this.readWorkGroup(request, requestIndex);
      case 'workEntryDetail':
        return this.readWorkEntryDetail(request, requestIndex);
    }
  }

  private readTranscriptSync(
    request: AgentTranscriptSyncRequest,
    requestIndex: number,
  ): AgentTranscriptResourceResult {
    const selection = this.selectWindow(request.window);
    const knownTurns = new Map(
      (request.knownTurns ?? []).map((known) => [known.turnId, known.renderRevision]),
    );
    const turnResults: AgentTurnRenderResult[] = selection.turns.map((turn) => {
      if (knownTurns.get(turn.id) === turn.renderRevision) {
        return {
          status: 'notModified',
          turnId: turn.id,
          renderRevision: turn.renderRevision,
        };
      }
      try {
        const frame = this.renderFrame(turn);
        if (serializedByteLength(frame) > this.maxTurnFrameBytes) {
          return {
            status: 'error',
            turnId: turn.id,
            renderRevision: turn.renderRevision,
            code: 'frameTooLarge',
            message: 'Turn frame exceeds the 1 MiB limit.',
            frame: this.errorFrame(turn, 'Turn content is too large to render in one frame.'),
          };
        }
        return {
          status: 'ok',
          turnId: turn.id,
          renderRevision: turn.renderRevision,
          frame,
        };
      } catch {
        return {
          status: 'error',
          turnId: turn.id,
          renderRevision: turn.renderRevision,
          code: 'projectionFailed',
          message: 'Turn projection failed.',
          frame: this.errorFrame(turn, 'Turn projection failed. Retry the transcript read.'),
        };
      }
    });
    const turnOrder = selection.turns.map((turn) => turn.id);
    const value: AgentTranscriptSyncResource = {
      protocolVersion: AGENT_TRANSCRIPT_PROTOCOL_VERSION,
      projectionVersion: AGENT_TRANSCRIPT_PROJECTION_VERSION,
      conversationId: this.conversationId,
      conversationRevision: this.conversationRevision,
      basisSequence: this.basisSequence,
      activeTurnId: this.activeTurnId,
      turnOrder,
      turns: turnResults,
      removedTurnIds: [],
      window: {
        startIndex: selection.startIndex,
        endIndexExclusive: selection.endIndexExclusive,
        hasEarlier: selection.startIndex > 0,
        hasLater: selection.endIndexExclusive < this.turns.length,
        turnIds: turnOrder,
      },
    };
    return {
      requestIndex,
      key: `transcript:${this.conversationId}`,
      status: 'ok',
      revision: this.conversationRevision,
      value,
    };
  }

  private readWorkGroup(
    request: AgentWorkGroupRequest,
    requestIndex: number,
  ): AgentTranscriptResourceResult {
    const key = workGroupResourceKey(
      this.conversationId,
      request.turnId,
      request.segmentId,
      request.groupId,
    );
    const turn = this.turnsById.get(request.turnId);
    const group = turn?.groups.get(request.groupId);
    if (!turn || !turn.work || turn.work.id !== request.segmentId || !group) {
      return { requestIndex, key, status: 'missing' };
    }
    if (request.knownRevision === group.revision) {
      return { requestIndex, key, status: 'notModified', revision: group.revision };
    }

    const cursor = request.cursor ? decodeWorkGroupCursor(request.cursor) : null;
    if (cursor && cursor.groupRevision !== group.revision) {
      return {
        requestIndex,
        key,
        status: 'error',
        code: 'staleCursor',
        reason: 'The work group changed before the next page was read.',
        revision: group.revision,
      };
    }
    const start = cursor?.offset ?? 0;
    const limit = request.limit ?? DEFAULT_WORK_GROUP_ROWS;
    const end = Math.min(group.rows.length, start + limit);
    const value: AgentWorkGroupResource = {
      conversationId: this.conversationId,
      turnId: turn.id,
      segmentId: turn.work.id,
      groupId: group.id,
      type: group.type,
      title: group.title,
      revision: group.revision,
      layoutRevision: group.layoutRevision,
      rows: structuredClone(group.rows.slice(start, end)),
      nextCursor: end < group.rows.length
        ? encodeWorkGroupCursor(group.revision, end)
        : null,
    };
    return { requestIndex, key, status: 'ok', revision: group.revision, value };
  }

  private readWorkEntryDetail(
    request: AgentWorkEntryDetailRequest,
    requestIndex: number,
  ): AgentTranscriptResourceResult {
    const key = workEntryDetailResourceKey(
      this.conversationId,
      request.turnId,
      request.segmentId,
      request.groupId,
      request.rowId,
    );
    const turn = this.turnsById.get(request.turnId);
    const group = turn?.groups.get(request.groupId);
    const detail = group?.detailsByRowId.get(request.rowId);
    if (!turn || !turn.work || turn.work.id !== request.segmentId || !group || !detail) {
      return { requestIndex, key, status: 'missing' };
    }
    if (request.knownRevision === detail.revision) {
      return { requestIndex, key, status: 'notModified', revision: detail.revision };
    }

    const bounded = boundedActivityDetail(detail);
    const value: AgentWorkEntryDetailResource = {
      conversationId: this.conversationId,
      turnId: turn.id,
      segmentId: turn.work.id,
      groupId: group.id,
      rowId: request.rowId,
      revision: detail.revision,
      layoutRevision: detail.layoutRevision,
      detail: {
        type: 'activity',
        detail: bounded.detail,
        output: bounded.output,
      },
      truncation: bounded.truncation,
      ...(bounded.content ? { content: bounded.content } : {}),
    };
    return { requestIndex, key, status: 'ok', revision: detail.revision, value };
  }

  private selectWindow(window: AgentTranscriptSyncRequest['window']): WindowSelection {
    if (window.kind === 'tail') {
      const count = window.count ?? DEFAULT_TRANSCRIPT_TAIL_TURNS;
      const startIndex = Math.max(0, this.turns.length - count);
      return {
        startIndex,
        endIndexExclusive: this.turns.length,
        turns: this.turns.slice(startIndex),
      };
    }

    if (window.kind === 'around') {
      const anchorIndex = this.turns.findIndex((turn) => turn.id === window.turnId);
      if (anchorIndex < 0) {
        throw new TranscriptProtocolError(-32602, 'Transcript window anchor was not found.');
      }
      const startIndex = Math.max(0, anchorIndex - window.before);
      const endIndexExclusive = Math.min(this.turns.length, anchorIndex + window.after + 1);
      return {
        startIndex,
        endIndexExclusive,
        turns: this.turns.slice(startIndex, endIndexExclusive),
      };
    }

    const startIndex = this.turns.findIndex((turn) => turn.id === window.startTurnId);
    const endIndex = this.turns.findIndex((turn) => turn.id === window.endTurnId);
    if (startIndex < 0 || endIndex < 0 || endIndex < startIndex) {
      throw new TranscriptProtocolError(-32602, 'Transcript range anchors are invalid.');
    }
    if (endIndex - startIndex + 1 > MAX_TRANSCRIPT_WINDOW_TURNS) {
      throw new TranscriptProtocolError(
        -32602,
        `Transcript range exceeds the ${MAX_TRANSCRIPT_WINDOW_TURNS} turn limit.`,
      );
    }
    return {
      startIndex,
      endIndexExclusive: endIndex + 1,
      turns: this.turns.slice(startIndex, endIndex + 1),
    };
  }

  private renderFrame(turn: MutableTurn): AgentTurnRenderFrame {
    const frame = structuredClone({
      id: turn.id,
      status: turn.status,
      startedAt: turn.startedAt,
      completedAt: turn.completedAt,
      durationMs: turn.durationMs,
      error: turn.error,
      interruptionReason: turn.interruptionReason,
      renderRevision: turn.renderRevision,
      layoutRevision: turn.layoutRevision,
      segments: [
        turn.user,
        ...(turn.work ? [turn.work] : []),
        ...(turn.assistant && turn.assistant.text ? [turn.assistant] : []),
      ],
    } satisfies AgentTurnRenderFrame);
    let remainingBytes = MAX_TURN_FRAME_BYTES - 128 * 1024;
    for (const segment of frame.segments) {
      if (segment.type === 'userMessage' || segment.type === 'assistantMessage') {
        const bounded = boundVisibleText(
          segment.text,
          Math.min(MAX_VISIBLE_TEXT_BYTES, remainingBytes),
          segment.content,
          segment.type === 'userMessage' || turn.status !== 'inProgress',
        );
        segment.text = bounded.text;
        if (bounded.content) segment.content = bounded.content;
        remainingBytes = Math.max(0, remainingBytes - bounded.returnedBytes);
      } else {
        for (const entry of segment.timeline) {
          if (entry.type !== 'text') continue;
          const bounded = boundVisibleText(
            entry.text,
            Math.min(MAX_VISIBLE_TEXT_BYTES, remainingBytes),
            entry.content,
            turn.status !== 'inProgress',
          );
          entry.text = bounded.text;
          if (bounded.content) entry.content = bounded.content;
          remainingBytes = Math.max(0, remainingBytes - bounded.returnedBytes);
        }
      }
    }
    return frame;
  }

  private errorFrame(turn: MutableTurn, message: string): AgentTurnRenderFrame {
    return {
      id: turn.id,
      status: turn.status,
      startedAt: turn.startedAt,
      completedAt: turn.completedAt,
      durationMs: turn.durationMs,
      error: { code: 'runtime_error', message },
      interruptionReason: turn.interruptionReason,
      renderRevision: turn.renderRevision,
      layoutRevision: turn.layoutRevision,
      segments: [],
    };
  }

  private ensureWork(turn: MutableTurn, revision: string) {
    turn.work ??= {
      id: turn.durableIdentity
        ? projectionUuid(`${AGENT_TRANSCRIPT_PROJECTION_VERSION}:work:${turn.id}`)
        : this.createId(),
      type: 'work',
      state: 'running',
      revision,
      layoutRevision: revision,
      durationMs: null,
      timeline: [],
    };
    return turn.work;
  }

  private ensureActivityGroup(
    turn: MutableTurn,
    work: MutableWork,
    revision: string,
  ) {
    const existing = [...turn.groups.values()].find((group) => group.type === 'activity');
    if (existing) return existing;

    const group: MutableGroup = {
      id: turn.durableIdentity
        ? projectionUuid(`${AGENT_TRANSCRIPT_PROJECTION_VERSION}:group:${turn.id}:activity:0`)
        : this.createId(),
      type: 'activity',
      title: 'Workspace reads',
      revision,
      layoutRevision: revision,
      rows: [],
      detailsByRowId: new Map(),
    };
    turn.groups.set(group.id, group);
    work.timeline.push(groupTimelineEntry(group, revision));
    return group;
  }

  private refreshGroupTimeline(
    work: MutableWork,
    group: MutableGroup,
    revision: string,
  ) {
    const index = work.timeline.findIndex((entry) => entry.type === 'group' && entry.id === group.id);
    const entry = groupTimelineEntry(group, revision);
    if (index >= 0) {
      work.timeline[index] = entry;
    } else {
      work.timeline.push(entry);
    }
  }

  private touchWork(
    turn: MutableTurn,
    work: MutableWork,
    revision: string,
    affectsLayout: boolean,
  ) {
    work.revision = revision;
    if (affectsLayout) work.layoutRevision = revision;
    this.touchTurn(turn, revision, affectsLayout);
  }

  private touchTurn(turn: MutableTurn, revision: string, affectsLayout: boolean) {
    turn.renderRevision = revision;
    if (affectsLayout) turn.layoutRevision = revision;
  }

  private activeTurn(turnId: string) {
    if (this.activeTurnId !== turnId) return null;
    const turn = this.turnsById.get(turnId);
    return turn?.status === 'inProgress' ? turn : null;
  }

  private advanceRevision(sequence: number | undefined, discriminator: string) {
    if (sequence === undefined) {
      this.fenceBasis(this.basisSequence + 1);
      return `revision:${this.basisSequence}`;
    }
    if (!Number.isSafeInteger(sequence) || sequence < 1) {
      throw new TranscriptProtocolError(-32603, 'Transcript mutation sequence is invalid.');
    }
    this.fenceBasis(Math.max(this.basisSequence, sequence));
    return `revision:${createHash('sha256')
      .update(AGENT_TRANSCRIPT_PROJECTION_VERSION)
      .update('\0')
      .update(this.conversationId)
      .update('\0')
      .update(String(sequence))
      .update('\0')
      .update(discriminator)
      .digest('hex')}`;
  }

  private acceptAssistantItemId(turn: MutableTurn, itemId: string | null | undefined) {
    if (!itemId) return turn.assistantItemId;
    if (turn.assistantItemId && turn.assistantItemId !== itemId) {
      throw new TranscriptProtocolError(-32603, 'Durable assistant identity changed during projection.');
    }
    turn.assistantItemId = itemId;
    return itemId;
  }

  private publishTurnMutation(
    turn: MutableTurn,
    reason: 'sendAccepted' | 'runtimeEvent' | 'terminal',
    affectsOrder: boolean,
    affectsLayout: boolean,
    group?: MutableGroup,
    rowId?: string,
  ) {
    const invalidations: AgentResourceInvalidation[] = [
      this.transcriptInvalidation(turn, reason, affectsOrder, affectsLayout),
    ];
    if (group) {
      invalidations.push(this.groupInvalidation(turn, group, reason === 'terminal' ? 'terminal' : 'runtimeEvent'));
      if (rowId) {
        invalidations.push(this.detailInvalidation(
          turn,
          group,
          rowId,
          reason === 'terminal' ? 'terminal' : 'runtimeEvent',
        ));
      }
    }
    this.invalidate(invalidations);
  }

  private transcriptInvalidation(
    turn: MutableTurn,
    reason: 'sendAccepted' | 'runtimeEvent' | 'terminal',
    affectsOrder: boolean,
    affectsLayout: boolean,
  ): AgentResourceInvalidation {
    return {
      type: 'transcript',
      key: `transcript:${this.conversationId}`,
      conversationId: this.conversationId,
      turnId: turn.id,
      reason,
      affectsOrder,
      affectsLayout,
      basisSequence: this.basisSequence,
    };
  }

  private groupInvalidation(
    turn: MutableTurn,
    group: MutableGroup,
    reason: 'runtimeEvent' | 'terminal',
  ): AgentResourceInvalidation {
    return {
      type: 'workGroup',
      key: workGroupResourceKey(this.conversationId, turn.id, turn.work!.id, group.id),
      conversationId: this.conversationId,
      turnId: turn.id,
      segmentId: turn.work!.id,
      groupId: group.id,
      reason,
      affectsLayout: true,
      basisSequence: this.basisSequence,
    };
  }

  private detailInvalidation(
    turn: MutableTurn,
    group: MutableGroup,
    rowId: string,
    reason: 'runtimeEvent' | 'terminal',
  ): AgentResourceInvalidation {
    return {
      type: 'workEntryDetail',
      key: workEntryDetailResourceKey(
        this.conversationId,
        turn.id,
        turn.work!.id,
        group.id,
        rowId,
      ),
      conversationId: this.conversationId,
      turnId: turn.id,
      segmentId: turn.work!.id,
      groupId: group.id,
      rowId,
      reason,
      affectsLayout: true,
      basisSequence: this.basisSequence,
    };
  }
}

export function parseTranscriptResourcesReadParams(
  params: unknown,
): AgentTranscriptResourcesReadParams {
  const value = objectValue(params);
  const conversationId = requiredUuidV4(value.conversationId, 'conversationId');
  if (!Array.isArray(value.requests)) {
    throw invalidParams('requests must be an array.');
  }
  if (value.requests.length > MAX_TRANSCRIPT_REQUESTS) {
    throw invalidParams(`requests exceeds the ${MAX_TRANSCRIPT_REQUESTS} item limit.`);
  }
  const requests = value.requests.map(parseTranscriptRequest);
  if (requests.filter((request) => request.type === 'transcriptSync').length > 1) {
    throw invalidParams('A transcript resource batch may contain at most one transcriptSync request.');
  }
  return {
    conversationId,
    requests,
  };
}

function parseTranscriptRequest(value: unknown): AgentTranscriptResourceRequest {
  const request = objectValue(value);
  const type = requiredString(request.type, 'request.type');
  if (type === 'transcriptSync') return parseTranscriptSyncRequest(request);
  if (type === 'workGroup') return parseWorkGroupRequest(request);
  if (type === 'workEntryDetail') return parseWorkEntryDetailRequest(request);
  throw invalidParams('Unknown transcript request type.');
}

function parseTranscriptSyncRequest(
  request: Record<string, unknown>,
): AgentTranscriptSyncRequest {
  requireProtocolVersion(request.protocolVersion);
  if (request.projectionVersion !== AGENT_TRANSCRIPT_PROJECTION_VERSION) {
    throw invalidParams('Unknown transcript projection version.');
  }
  const knownTurns = request.knownTurns === undefined
    ? undefined
    : parseKnownTurns(request.knownTurns);
  const knownConversationRevision = optionalString(
    request.knownConversationRevision,
    'knownConversationRevision',
  );
  return {
    type: 'transcriptSync',
    protocolVersion: AGENT_TRANSCRIPT_PROTOCOL_VERSION,
    projectionVersion: AGENT_TRANSCRIPT_PROJECTION_VERSION,
    ...(knownConversationRevision ? { knownConversationRevision } : {}),
    ...(knownTurns ? { knownTurns } : {}),
    window: parseWindow(request.window),
  };
}

function parseKnownTurns(value: unknown) {
  if (!Array.isArray(value)) throw invalidParams('knownTurns must be an array.');
  if (value.length > MAX_TRANSCRIPT_KNOWN_TURNS) {
    throw invalidParams(`knownTurns exceeds the ${MAX_TRANSCRIPT_KNOWN_TURNS} item limit.`);
  }
  const seen = new Set<string>();
  return value.map((entry) => {
    const known = objectValue(entry);
    const turnId = requiredUuidV4(known.turnId, 'knownTurns.turnId');
    if (seen.has(turnId)) throw invalidParams('knownTurns contains a duplicate turnId.');
    seen.add(turnId);
    return {
      turnId,
      renderRevision: requiredString(known.renderRevision, 'knownTurns.renderRevision'),
    };
  });
}

function parseWindow(value: unknown): AgentTranscriptSyncRequest['window'] {
  const window = objectValue(value);
  const kind = requiredString(window.kind, 'window.kind');
  if (kind === 'tail') {
    const count = window.count === undefined
      ? undefined
      : boundedInteger(window.count, 'window.count', 1, MAX_TRANSCRIPT_WINDOW_TURNS);
    return { kind: 'tail', ...(count === undefined ? {} : { count }) };
  }
  if (kind === 'around') {
    const before = boundedInteger(window.before, 'window.before', 0, MAX_TRANSCRIPT_WINDOW_TURNS - 1);
    const after = boundedInteger(window.after, 'window.after', 0, MAX_TRANSCRIPT_WINDOW_TURNS - 1);
    if (before + after + 1 > MAX_TRANSCRIPT_WINDOW_TURNS) {
      throw invalidParams(`around window exceeds the ${MAX_TRANSCRIPT_WINDOW_TURNS} turn limit.`);
    }
    return {
      kind: 'around',
      turnId: requiredUuidV4(window.turnId, 'window.turnId'),
      before,
      after,
    };
  }
  if (kind === 'range') {
    return {
      kind: 'range',
      startTurnId: requiredUuidV4(window.startTurnId, 'window.startTurnId'),
      endTurnId: requiredUuidV4(window.endTurnId, 'window.endTurnId'),
    };
  }
  throw invalidParams('Unknown transcript window kind.');
}

function parseWorkGroupRequest(request: Record<string, unknown>): AgentWorkGroupRequest {
  requireProtocolVersion(request.protocolVersion);
  const limit = request.limit === undefined
    ? undefined
    : boundedInteger(request.limit, 'limit', 1, MAX_WORK_GROUP_ROWS);
  if (limit !== undefined && !(WORK_GROUP_ROW_LIMITS as readonly number[]).includes(limit)) {
    throw invalidParams(`limit must be one of ${WORK_GROUP_ROW_LIMITS.join(', ')}.`);
  }
  const cursor = optionalString(request.cursor, 'cursor');
  if (cursor && (cursor.length > 2_048 || !/^[A-Za-z0-9_-]+$/u.test(cursor))) {
    throw invalidParams('cursor must be an opaque Agent work-group cursor.');
  }
  const knownRevision = optionalString(request.knownRevision, 'knownRevision');
  if (cursor && knownRevision) {
    throw invalidParams('knownRevision cannot be combined with a continuation cursor.');
  }
  return {
    type: 'workGroup',
    protocolVersion: AGENT_TRANSCRIPT_PROTOCOL_VERSION,
    turnId: requiredUuidV4(request.turnId, 'turnId'),
    segmentId: requiredUuidV4(request.segmentId, 'segmentId'),
    groupId: requiredUuidV4(request.groupId, 'groupId'),
    ...(cursor ? { cursor } : {}),
    ...(limit === undefined ? {} : { limit }),
    ...(knownRevision ? { knownRevision } : {}),
  };
}

function encodeWorkGroupCursor(groupRevision: string, offset: number) {
  return Buffer.from(JSON.stringify({
    groupRevision,
    offset,
    projectionVersion: AGENT_TRANSCRIPT_PROJECTION_VERSION,
    version: 1,
  }), 'utf8').toString('base64url');
}

function decodeWorkGroupCursor(cursor: string) {
  let value: unknown;
  try {
    const bytes = Buffer.from(cursor, 'base64url');
    if (bytes.toString('base64url') !== cursor) throw new Error('non-canonical cursor');
    value = JSON.parse(bytes.toString('utf8')) as unknown;
  } catch {
    throw invalidParams('cursor is not a valid Agent work-group cursor.');
  }
  const record = objectValue(value);
  if (
    record.version !== 1 ||
    record.projectionVersion !== AGENT_TRANSCRIPT_PROJECTION_VERSION
  ) {
    throw invalidParams('cursor uses an unsupported work-group projection version.');
  }
  return {
    groupRevision: requiredString(record.groupRevision, 'cursor.groupRevision'),
    offset: boundedInteger(record.offset, 'cursor.offset', 0, Number.MAX_SAFE_INTEGER),
  };
}

function parseWorkEntryDetailRequest(
  request: Record<string, unknown>,
): AgentWorkEntryDetailRequest {
  requireProtocolVersion(request.protocolVersion);
  const knownRevision = optionalString(request.knownRevision, 'knownRevision');
  return {
    type: 'workEntryDetail',
    protocolVersion: AGENT_TRANSCRIPT_PROTOCOL_VERSION,
    turnId: requiredUuidV4(request.turnId, 'turnId'),
    segmentId: requiredUuidV4(request.segmentId, 'segmentId'),
    groupId: requiredUuidV4(request.groupId, 'groupId'),
    rowId: requiredUuidV4(request.rowId, 'rowId'),
    ...(knownRevision ? { knownRevision } : {}),
  };
}

function requireProtocolVersion(value: unknown) {
  if (value !== AGENT_TRANSCRIPT_PROTOCOL_VERSION) {
    throw invalidParams('Unknown Agent transcript protocol version.');
  }
}

function groupTimelineEntry(
  group: MutableGroup,
  revision: string,
): AgentWorkGroupTimelineEntry {
  return {
    id: group.id,
    type: 'group',
    revision,
    groupType: group.type,
    title: group.title,
    status: groupStatus(group.rows),
    rowCount: group.rows.length,
    hasMoreRows: false,
  };
}

function groupStatus(rows: AgentWorkActivityRow[]): AgentWorkGroupTimelineEntry['status'] {
  if (rows.some((row) => row.status === 'running')) return 'running';
  if (rows.some((row) => row.status === 'interrupted')) return 'interrupted';
  if (rows.some((row) => row.status === 'failed')) return 'failed';
  return 'completed';
}

function boundedActivityDetail(detail: MutableActivityDetail) {
  let returnedDetail = detail.detail;
  let returnedOutput = detail.output;
  let remainingBytes = MAX_WORK_ENTRY_DETAIL_BYTES;
  if (returnedDetail) {
    returnedDetail = truncateUtf8(returnedDetail, remainingBytes);
    remainingBytes = Math.max(0, remainingBytes - byteLength(returnedDetail));
  }
  if (returnedOutput) {
    returnedOutput = truncateUtf8(returnedOutput, remainingBytes);
  }
  const returnedBytes = byteLength(returnedDetail) + byteLength(returnedOutput);
  return {
    detail: returnedDetail,
    output: returnedOutput,
    truncation: {
      originalBytes: detail.originalBytes,
      returnedBytes,
      truncated: detail.originalBytes > returnedBytes,
    },
    ...(
      detail.detailContent || detail.outputContent
        ? {
            content: {
              ...(detail.detailContent ? { detail: detail.detailContent } : {}),
              ...(detail.outputContent ? { output: detail.outputContent } : {}),
            },
          }
        : {}
    ),
  };
}

function boundedSerializedValue(value: unknown) {
  let text: string;
  try {
    const serialized = typeof value === 'string' ? value : JSON.stringify(value);
    text = serialized === undefined ? String(value) : serialized;
  } catch {
    text = String(value);
  }
  text = sanitizeText(text);
  const originalBytes = byteLength(text);
  return {
    text: truncateUtf8(text, MAX_WORK_ENTRY_DETAIL_BYTES * 4),
    originalBytes,
  };
}

function toolPath(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const path = (value as { path?: unknown }).path;
  return typeof path === 'string' ? sanitizeText(path).slice(0, 4_096) : null;
}

function sanitizeText(text: string) {
  return text
    .replace(
      /("(?:authorization|proxy-authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret|cookie|set-cookie)"\s*:\s*)"(?:\\.|[^"\\])*"/giu,
      '$1"[redacted]"',
    )
    .replace(/Bearer\s+\S+/giu, 'Bearer [redacted]')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/gu, '[redacted]')
    .replace(/\beyJ[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+){2}\b/gu, '[redacted]');
}

function boundVisibleText(
  value: string,
  maxBytes: number,
  existing: AgentTextContentReference | undefined,
  artifactAvailable: boolean,
) {
  const text = truncateUtf8(value, maxBytes);
  const returnedBytes = byteLength(text);
  const byteLengthValue = existing?.byteLength ?? byteLength(value);
  if (byteLengthValue <= returnedBytes && !existing) {
    return { text, returnedBytes, content: undefined };
  }
  const sha256 = existing?.sha256 ?? createHash('sha256').update(value, 'utf8').digest('hex');
  const artifactHash = existing?.artifactHash ?? (artifactAvailable ? sha256 : null);
  const content: AgentTextContentReference = {
    sha256,
    byteLength: byteLengthValue,
    returnedBytes,
    truncated: true,
    artifactHash,
    nextRange: artifactHash && returnedBytes < byteLengthValue
      ? {
          kind: 'utf8',
          offset: returnedBytes,
          byteLength: MAX_VISIBLE_TEXT_BYTES,
        }
      : null,
  };
  return { text, returnedBytes, content };
}

function truncateUtf8(value: string, maxBytes: number) {
  if (maxBytes <= 0) return '';
  const bytes = Buffer.from(value);
  if (bytes.length <= maxBytes) return value;
  return bytes.subarray(0, maxBytes).toString('utf8').replace(/\uFFFD$/u, '');
}

function byteLength(value: string | null) {
  return value ? Buffer.byteLength(value) : 0;
}

function projectionUuid(seed: string) {
  const bytes = createHash('sha256').update(seed).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function serializedByteLength(value: unknown) {
  return Buffer.byteLength(JSON.stringify(value));
}

function objectValue(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw invalidParams('Expected an object.');
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, name: string) {
  if (typeof value !== 'string' || value.length === 0) {
    throw invalidParams(`${name} must be a non-empty string.`);
  }
  return value;
}

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

function requiredUuidV4(value: unknown, name: string) {
  const id = requiredString(value, name);
  if (!UUID_V4.test(id)) throw invalidParams(`${name} must be a lowercase UUID v4.`);
  return id;
}

function optionalString(value: unknown, name: string) {
  if (value === undefined) return undefined;
  return requiredString(value, name);
}

function boundedInteger(
  value: unknown,
  name: string,
  minimum: number,
  maximum: number,
) {
  if (!Number.isInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    throw invalidParams(`${name} must be an integer from ${minimum} to ${maximum}.`);
  }
  return Number(value);
}

function invalidParams(message: string) {
  return new TranscriptProtocolError(-32602, message);
}
