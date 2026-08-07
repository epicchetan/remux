import { randomUUID } from 'node:crypto';
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
  MAX_WORK_ENTRY_DETAIL_BYTES,
  MAX_WORK_GROUP_ROWS,
  WORK_GROUP_ROW_LIMITS,
  workEntryDetailResourceKey,
  workGroupResourceKey,
  type AgentAssistantMessageSegment,
  type AgentResourceInvalidation,
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
  status: AgentTurnStatus;
  startedAt: number;
  startedMonotonicAt: number;
  completedAt: number | null;
  durationMs: number | null;
  error: AgentTurnError | null;
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
};

type WindowSelection = {
  startIndex: number;
  endIndexExclusive: number;
  turns: MutableTurn[];
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
  }) {
    if (this.activeTurnId) {
      throw new TranscriptProtocolError(-32013, 'A projected turn is already running.');
    }
    if (this.turnsById.has(input.turnId)) {
      throw new TranscriptProtocolError(-32602, 'turnId was already used.');
    }

    const startedAt = this.wallNow();
    const startedMonotonicAt = this.monotonicNow();
    const revision = this.advanceRevision();
    const turn: MutableTurn = {
      id: input.turnId,
      status: 'inProgress',
      startedAt,
      startedMonotonicAt,
      completedAt: null,
      durationMs: null,
      error: null,
      renderRevision: revision,
      layoutRevision: revision,
      user: {
        id: this.createId(),
        type: 'userMessage',
        clientMessageId: input.clientMessageId,
        revision,
        text: input.text,
      },
      work: null,
      assistant: null,
      groups: new Map(),
      toolRowsByCallId: new Map(),
    };

    this.turns.push(turn);
    this.turnsById.set(turn.id, turn);
    this.activeTurnId = turn.id;
    this.publishTurnMutation(turn, 'sendAccepted', true, true);
  }

  assistantStarted(turnId: string) {
    return this.activeTurn(turnId) !== null;
  }

  appendAssistantText(turnId: string, delta: string) {
    const turn = this.activeTurn(turnId);
    if (!turn || !delta) return false;

    const revision = this.advanceRevision();
    turn.assistant ??= {
      id: this.createId(),
      type: 'assistantMessage',
      revision,
      text: '',
    };
    turn.assistant.text += delta;
    turn.assistant.revision = revision;
    this.touchTurn(turn, revision, true);
    this.publishTurnMutation(turn, 'runtimeEvent', false, true);
    return true;
  }

  appendReasoning(turnId: string, delta: string) {
    const turn = this.activeTurn(turnId);
    if (!turn || !delta) return false;

    const revision = this.advanceRevision();
    const work = this.ensureWork(turn, revision);
    const previous = work.timeline.at(-1);
    if (previous?.type === 'text') {
      previous.text += delta;
      previous.revision = revision;
    } else {
      work.timeline.push({
        id: this.createId(),
        type: 'text',
        revision,
        text: delta,
      } satisfies AgentWorkTextTimelineEntry);
    }
    this.touchWork(turn, work, revision, true);
    this.publishTurnMutation(turn, 'runtimeEvent', false, true);
    return true;
  }

  startTool(turnId: string, input: {
    callId: string;
    name: string;
    args: unknown;
  }) {
    const turn = this.activeTurn(turnId);
    if (!turn || turn.toolRowsByCallId.has(input.callId)) return false;

    const revision = this.advanceRevision();
    const work = this.ensureWork(turn, revision);
    const group = this.ensureActivityGroup(turn, work, revision);
    const path = toolPath(input.args);
    const detailText = boundedSerializedValue(input.args);
    const row: AgentWorkActivityRow = {
      id: this.createId(),
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
    };
    group.rows.push(row);
    group.detailsByRowId.set(row.id, detail);
    turn.toolRowsByCallId.set(input.callId, {
      group,
      row,
      detail,
      startedMonotonicAt: this.monotonicNow(),
    });
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

    const revision = this.advanceRevision();
    const output = boundedSerializedValue(input.result);
    tool.detail.output = output.text;
    tool.detail.originalBytes = byteLength(tool.detail.detail) + output.originalBytes;
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
  }) {
    const turn = this.activeTurn(turnId);
    const tool = turn?.toolRowsByCallId.get(input.callId);
    if (!turn || !tool) return false;

    const revision = this.advanceRevision();
    const output = boundedSerializedValue(input.result);
    tool.row.status = input.isError ? 'failed' : 'completed';
    tool.row.durationMs = Math.max(0, this.monotonicNow() - tool.startedMonotonicAt);
    tool.row.revision = revision;
    tool.detail.output = output.text;
    tool.detail.originalBytes = byteLength(tool.detail.detail) + output.originalBytes;
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
    this.publishTurnMutation(turn, 'runtimeEvent', false, true, tool.group, tool.row.id);
    return true;
  }

  finishTurn(turnId: string, input: {
    status: 'completed' | 'failed' | 'interrupted';
    error?: AgentTurnError | null;
  }) {
    const turn = this.activeTurn(turnId);
    if (!turn) return false;

    const completedAt = this.wallNow();
    const revision = this.advanceRevision();
    turn.status = input.status;
    turn.completedAt = completedAt;
    turn.durationMs = Math.max(0, this.monotonicNow() - turn.startedMonotonicAt);
    turn.error = input.status === 'failed' ? input.error ?? {
      code: 'runtime_error',
      message: 'The turn failed.',
    } : null;
    this.activeTurnId = null;

    const invalidations: AgentResourceInvalidation[] = [];
    if (turn.work) {
      turn.work.state = input.status === 'completed' ? 'completed' : input.status;
      turn.work.durationMs = turn.durationMs;
      turn.work.revision = revision;
      turn.work.layoutRevision = revision;
      for (const group of turn.groups.values()) {
        for (const row of group.rows) {
          if (row.status === 'running') {
            row.status = input.status === 'completed' ? 'completed' : input.status;
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
            code: 'frameTooLarge',
            message: 'Turn frame exceeds the 1 MiB limit.',
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
          code: 'projectionFailed',
          message: 'Turn projection failed.',
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

    const start = request.cursor ? Number.parseInt(request.cursor, 10) : 0;
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
      nextCursor: end < group.rows.length ? String(end) : null,
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
    return structuredClone({
      id: turn.id,
      status: turn.status,
      startedAt: turn.startedAt,
      completedAt: turn.completedAt,
      durationMs: turn.durationMs,
      error: turn.error,
      renderRevision: turn.renderRevision,
      layoutRevision: turn.layoutRevision,
      segments: [
        turn.user,
        ...(turn.work ? [turn.work] : []),
        ...(turn.assistant && turn.assistant.text ? [turn.assistant] : []),
      ],
    } satisfies AgentTurnRenderFrame);
  }

  private ensureWork(turn: MutableTurn, revision: string) {
    turn.work ??= {
      id: this.createId(),
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
      id: this.createId(),
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

  private advanceRevision() {
    this.basisSequence += 1;
    const revision = `revision:${this.basisSequence}`;
    this.conversationRevision = `conversation:${this.basisSequence}`;
    return revision;
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
    };
  }
}

export function parseTranscriptResourcesReadParams(
  params: unknown,
): AgentTranscriptResourcesReadParams {
  const value = objectValue(params);
  const conversationId = requiredString(value.conversationId, 'conversationId');
  if (!Array.isArray(value.requests)) {
    throw invalidParams('requests must be an array.');
  }
  if (value.requests.length > MAX_TRANSCRIPT_REQUESTS) {
    throw invalidParams(`requests exceeds the ${MAX_TRANSCRIPT_REQUESTS} item limit.`);
  }
  return {
    conversationId,
    requests: value.requests.map(parseTranscriptRequest),
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
    const turnId = requiredString(known.turnId, 'knownTurns.turnId');
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
      turnId: requiredString(window.turnId, 'window.turnId'),
      before,
      after,
    };
  }
  if (kind === 'range') {
    return {
      kind: 'range',
      startTurnId: requiredString(window.startTurnId, 'window.startTurnId'),
      endTurnId: requiredString(window.endTurnId, 'window.endTurnId'),
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
  if (cursor && !/^\d+$/u.test(cursor)) throw invalidParams('cursor must be a non-negative row offset.');
  const knownRevision = optionalString(request.knownRevision, 'knownRevision');
  return {
    type: 'workGroup',
    protocolVersion: AGENT_TRANSCRIPT_PROTOCOL_VERSION,
    turnId: requiredString(request.turnId, 'turnId'),
    segmentId: requiredString(request.segmentId, 'segmentId'),
    groupId: requiredString(request.groupId, 'groupId'),
    ...(cursor ? { cursor } : {}),
    ...(limit === undefined ? {} : { limit }),
    ...(knownRevision ? { knownRevision } : {}),
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
    turnId: requiredString(request.turnId, 'turnId'),
    segmentId: requiredString(request.segmentId, 'segmentId'),
    groupId: requiredString(request.groupId, 'groupId'),
    rowId: requiredString(request.rowId, 'rowId'),
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

function truncateUtf8(value: string, maxBytes: number) {
  if (maxBytes <= 0) return '';
  const bytes = Buffer.from(value);
  if (bytes.length <= maxBytes) return value;
  return bytes.subarray(0, maxBytes).toString('utf8').replace(/\uFFFD$/u, '');
}

function byteLength(value: string | null) {
  return value ? Buffer.byteLength(value) : 0;
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
