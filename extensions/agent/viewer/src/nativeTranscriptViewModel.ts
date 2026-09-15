import type {
  NativeAssistantPass,
  NativeTurnNotice,
  NativeAgentTurnFrame,
  NativeFileChangeView,
  NativeOrderedTurnBlock,
  NativeOperationView,
  NativeTranscriptWindow,
} from '../../shared/native-agent-protocol.ts';
import type {
  AgentExecutionScopeRequest,
  AgentExecutionScopeResource,
  AgentInferenceBlock,
  AgentInferenceTrace,
  AgentOperationDetailRequest,
  AgentOperationDetailResource,
  AgentToolCallSummary,
  AgentTranscriptSyncRequest,
  AgentTranscriptSyncResource,
  AgentTurnRenderFrame,
  AgentTurnSegment,
  AgentUserMessagePart,
} from '../../shared/transcript.ts';
import {
  AGENT_TRANSCRIPT_PROJECTION_VERSION,
  AGENT_TRANSCRIPT_PROTOCOL_VERSION,
} from '../../shared/transcript.ts';

export function projectNativeTranscript(
  transcript: NativeTranscriptWindow,
  request: AgentTranscriptSyncRequest,
  basisSequence: number,
): AgentTranscriptSyncResource {
  const known = new Map(request.knownTurns?.map((turn) => [turn.turnId, turn.renderRevision]) ?? []);
  const turns = transcript.turns.map((turn) => known.get(turn.turnId) === turn.renderRevision
    ? {
        status: 'notModified' as const,
        turnId: turn.turnId,
        renderRevision: turn.renderRevision,
      }
    : {
        status: 'ok' as const,
        turnId: turn.turnId,
        renderRevision: turn.renderRevision,
        frame: projectNativeTurn(turn),
      });
  return {
    protocolVersion: AGENT_TRANSCRIPT_PROTOCOL_VERSION,
    projectionVersion: AGENT_TRANSCRIPT_PROJECTION_VERSION,
    conversationId: transcript.conversationId,
    conversationRevision: `${basisSequence}:${transcript.turnOrder.join(':')}`,
    basisSequence,
    activeTurnId: transcript.activeTurnId,
    turnOrder: [...transcript.turnOrder],
    turns,
    removedTurnIds: (request.knownTurns ?? []).flatMap(({ turnId }) =>
      transcript.turnOrder.includes(turnId) ? [] : [turnId]),
    window: {
      ...transcript.window,
      turnIds: transcript.turns.map(({ turnId }) => turnId),
    },
  };
}

export function projectNativeTurn(turn: NativeAgentTurnFrame): AgentTurnRenderFrame {
  if (hasAdditionalInputs(turn)) return projectTurnWithInputs(turn);
  const segments: AgentTurnSegment[] = [];
  const inferences = projectTurnInferences(turn);
  const text = turn.userContent.flatMap((part) => part.type === 'text' ? [part.text] : []).join('');
  segments.push(...(turn.boundaryCompactions?.beforeUser ?? []).map(projectCompactionSegment));
  const notice = turn.inputItems?.find(input => input.clientMessageId === turn.clientMessageId);
  if (turn.origin && turn.origin !== 'user') segments.push(projectNotice(notice ?? {
    type: 'notice', clientMessageId: turn.clientMessageId, afterBlockId: null, origin: turn.origin,
    text: `Continued after ${turn.trigger?.kind === 'federation' ? 'federated child' : 'subagent'} finished`,
  }, turn.renderRevision));
  else segments.push({
    id: `user:${turn.turnId}`,
    type: 'userMessage',
    clientMessageId: turn.clientMessageId,
    revision: turn.renderRevision,
    text,
    parts: turn.userContent.map(projectUserPart),
  });
  if (inferences.length > 0 || turn.state === 'running' || turn.state === 'recovering') {
    segments.push({
      id: `work:${turn.executionId}`,
      type: 'work',
      scopeId: turn.executionId,
      state: workState(turn),
      revision: turn.renderRevision,
      layoutRevision: turn.layoutRevision,
      durationMs: duration(turn),
      inferenceCount: inferences.length,
      operationCount: inferences.reduce((count, inference) =>
        count + inference.blocks.filter(({ type }) => type === 'action').length, 0),
      childExecutionCount: turn.activity.children.length,
    });
  }
  if (turn.assistantText.trim()) {
    segments.push({
      id: `assistant:${turn.turnId}`,
      type: 'assistantMessage',
      revision: turn.renderRevision,
      text: turn.assistantText,
      ...(turn.assistantContent ? {
        content: {
          sha256: turn.assistantContent.sha256,
          byteLength: turn.assistantContent.byteLength,
          returnedBytes: turn.assistantContent.returnedBytes,
          truncated: true,
          artifactHash: turn.assistantContent.artifactId,
          nextRange: turn.assistantContent.nextOffset === null ? null : {
            kind: 'utf8',
            offset: turn.assistantContent.nextOffset,
            byteLength: Math.min(
              48 * 1024,
              turn.assistantContent.byteLength - turn.assistantContent.nextOffset,
            ),
          },
        },
      } : {}),
    });
  }
  segments.push(...(turn.boundaryCompactions?.afterTurn ?? []).map(projectCompactionSegment));
  return {
    id: turn.turnId,
    pathEntryId: turn.pathEntryId,
    strandId: turn.strandId,
    ordinal: turn.ordinal,
    status: turnStatus(turn),
    startedAt: turn.startedAt ?? null,
    completedAt: turn.completedAt ?? null,
    durationMs: duration(turn),
    error: turn.error ? { code: 'provider_error', message: turn.error.message } : null,
    ...(turn.outcome === 'interrupted' ? { interruptionReason: 'user' as const } : {}),
    renderRevision: turn.renderRevision,
    layoutRevision: turn.layoutRevision,
    segments,
  };
}

/** A section's own span; null while any of its blocks is still open in a live turn. */
function sectionDuration(section: NativeAgentTurnFrame) {
  const blocks = section.passes.flatMap((pass) => pass.blocks);
  const started = blocks.flatMap((block) => block.startedAt === null ? [] : [block.startedAt]);
  const ended = blocks.map((block) => block.completedAt ?? section.completedAt ?? null);
  if (!started.length || ended.some((value) => value === null)) return null;
  return Math.max(0, Math.max(...(ended as number[])) - Math.min(...started));
}

/** Partition presentation only; all sections retain the original native turn. */
function inputSections(turn: NativeAgentTurnFrame) {
  const messages = [
    ...(turn.additionalMessages ?? []).map(input => ({ ...input, type: 'message' as const })),
    ...(turn.inputItems ?? []).filter(input => input.clientMessageId !== turn.clientMessageId),
  ];
  const orderedBlocks = turn.passes.flatMap(pass => pass.blocks);
  messages.sort((a, b) => orderedBlocks.findIndex(block => block.blockId === a.afterBlockId)
    - orderedBlocks.findIndex(block => block.blockId === b.afterBlockId)
    || (a.inputOrdinal ?? 0) - (b.inputOrdinal ?? 0) || (a.createdAt ?? 0) - (b.createdAt ?? 0));
  const blocks = turn.passes.flatMap((pass) => pass.blocks);
  let start = 0;
  return [null, ...messages].map((input, index, entries) => {
    const next = entries[index + 1];
    const anchor = next?.afterBlockId ? blocks.findIndex(({ blockId }) => blockId === next.afterBlockId) : -1;
    const end = next ? Math.max(start, next.afterBlockId === null ? 0 : anchor < 0 ? blocks.length : anchor + 1)
      : blocks.length;
    const ids = new Set(blocks.slice(start, end).map(({ blockId }) => blockId));
    start = end;
    const tail = index === entries.length - 1;
    const ownsFinal = Boolean(turn.finalBlockId && ids.has(turn.finalBlockId));
    const scoped: NativeAgentTurnFrame = {
      ...turn, additionalMessages: undefined, inputItems: turn.inputItems?.filter(input => input.clientMessageId === turn.clientMessageId), boundaryCompactions: undefined,
      passes: turn.passes.map((pass) => ({ ...pass, blocks: pass.blocks.filter(({ blockId }) => ids.has(blockId)) }))
        .filter(({ blocks }) => blocks.length > 0),
      finalBlockId: ownsFinal ? turn.finalBlockId : null,
      assistantText: ownsFinal ? turn.assistantText : '',
      assistantContent: ownsFinal ? turn.assistantContent : undefined,
      // Compatibility fallbacks must not repeat every tool/child in each section.
      activity: { ...turn.activity, reasoning: '', commentary: '', operations: [], web: [], notices: [],
        // Positioned compaction notices already mark where context was dropped.
        compacted: tail && turn.activity.compacted && !turn.inputItems?.some((input) => input.origin === 'compaction'),
        fileChanges: turn.activity.fileChanges.filter((change) => Boolean(change.blockId && ids.has(change.blockId))),
        children: turn.activity.children.filter((child) => blocks.some((block) => ids.has(block.blockId) &&
          (block.payload.kind === 'native-child' || block.payload.kind === 'federated-child') &&
          block.payload.child.executionId === child.executionId)),
      },
    };
    return { input, turn: scoped, tail,
      scopeId: input ? `input:${input.clientMessageId}` : turn.executionId };
  });
}

function projectTurnWithInputs(turn: NativeAgentTurnFrame): AgentTurnRenderFrame {
  const base = projectNativeTurn({ ...turn, additionalMessages: undefined, inputItems: turn.inputItems?.filter(input => input.clientMessageId === turn.clientMessageId) });
  const segments: AgentTurnSegment[] = [...(turn.boundaryCompactions?.beforeUser ?? []).map(projectCompactionSegment)];
  const rootUser = base.segments.find((segment) => segment.type === 'userMessage' || segment.type === 'notice')!;
  segments.push(rootUser);
  for (const section of inputSections(turn)) {
    if (section.input?.type === 'notice') segments.push(projectNotice(section.input, turn.renderRevision));
    else if (section.input) segments.push({
      id: `user-input:${section.input.clientMessageId}`, type: 'userMessage',
      clientMessageId: section.input.clientMessageId, revision: turn.renderRevision,
      branchUnavailable: true,
      text: section.input.content.flatMap((part) => part.type === 'text' ? [part.text] : []).join(''),
      parts: section.input.content.map(projectUserPart),
    });
    const projected = projectNativeTurn(section.turn);
    for (const segment of projected.segments) {
      if (segment.type === 'work') {
        if (!section.turn.passes.length && !section.tail) continue;
        segments.push({ ...segment, id: `work:${section.scopeId}`, scopeId: section.scopeId,
          // A section can still contain a running tool after the input boundary.
          // Report the section's own span, never the whole turn once per section.
          durationMs: sectionDuration(section.turn) });
      } else if (segment.type === 'assistantMessage') segments.push(segment);
    }
  }
  segments.push(...(turn.boundaryCompactions?.afterTurn ?? []).map(projectCompactionSegment));
  return { ...base, segments };
}

function projectCompactionSegment(
  compaction: NonNullable<NativeAgentTurnFrame['boundaryCompactions']>['beforeUser'][number],
): Extract<AgentTurnSegment, { type: 'compaction' }> {
  return {
    id: `compaction:${compaction.operationId}`,
    type: 'compaction',
    revision: [
      compaction.operationId,
      compaction.state,
      compaction.beforeTokens ?? '',
      compaction.afterTokens ?? '',
      compaction.completedAt ?? '',
      compaction.error?.message ?? '',
    ].join(':'),
    status: compaction.state === 'started'
      ? 'compacting'
      : compaction.state === 'failed' ? 'failed' : 'compacted',
    trigger: compaction.trigger,
    beforeTokens: compaction.beforeTokens,
    afterTokens: compaction.afterTokens,
    ...(compaction.error ? { error: compaction.error.message } : {}),
  };
}

export function projectNativeExecutionScope(
  conversationId: string,
  turn: NativeAgentTurnFrame,
  request: AgentExecutionScopeRequest,
  basisSequence: number,
): AgentExecutionScopeResource {
  const section = hasAdditionalInputs(turn)
    ? inputSections(turn).find(({ scopeId }) => scopeId === request.scopeId) : undefined;
  const inferences = projectTurnInferences(section?.turn ?? turn);
  return {
    conversationId,
    turnId: turn.turnId,
    scopeId: request.scopeId,
    parentScopeId: null,
    parentOperationId: null,
    kind: 'turn',
    state: turn.state === 'recovering' ? 'recovering' : turn.state === 'completed'
      ? 'completed'
      : turn.state === 'interrupted' ? 'interrupted'
        : turn.state === 'failed' ? 'failed' : 'running',
    revision: turn.renderRevision,
    basisSequence,
    startedAt: turn.startedAt ?? 0,
    completedAt: turn.completedAt ?? null,
    durationMs: duration(turn),
    boundary: null,
    inferenceOrder: inferences.map(({ id }) => id),
    inferences,
    window: {
      startIndex: 0,
      endIndexExclusive: inferences.length,
      hasEarlier: false,
      hasLater: false,
    },
    result: null,
    artifacts: [],
  };
}

export function projectNativeChildExecutionScope(
  conversationId: string,
  transcript: NativeTranscriptWindow,
  request: AgentExecutionScopeRequest,
  basisSequence: number,
): AgentExecutionScopeResource {
  const inferences = transcript.turns.flatMap((turn) => {
    const task = turn.userContent
      .flatMap((part) => part.type === 'text' ? [part.text] : [])
      .join('\n')
      .trim();
    return projectTurnInferences(turn, task ? `Task\n\n${task}` : 'Task\n\nOriginal task unavailable.');
  }).map((inference, ordinal) => ({ ...inference, ordinal }));
  const first = transcript.turns[0];
  const last = transcript.turns.at(-1);
  const result = [...transcript.turns].reverse().find(({ assistantText }) => assistantText.trim())
    ?.assistantText.trim() ?? null;
  const state = transcript.activeTurnId
    ? 'running'
    : last?.state === 'interrupted' ? 'interrupted'
      : last?.state === 'failed' ? 'failed' : 'completed';
  const startedAt = first?.startedAt ?? 0;
  const completedAt = transcript.activeTurnId ? null : last?.completedAt ?? null;
  return {
    conversationId,
    turnId: request.turnId,
    scopeId: request.scopeId,
    parentScopeId: null,
    parentOperationId: null,
    kind: 'childExecution',
    state,
    revision: transcript.turns.map(({ renderRevision }) => renderRevision).join(':') || `${basisSequence}`,
    basisSequence,
    startedAt,
    completedAt,
    durationMs: completedAt === null ? null : Math.max(0, completedAt - startedAt),
    boundary: 'Subagent session',
    inferenceOrder: inferences.map(({ id }) => id),
    inferences,
    window: {
      startIndex: transcript.window.startIndex,
      endIndexExclusive: transcript.window.endIndexExclusive,
      hasEarlier: transcript.window.hasEarlier,
      hasLater: transcript.window.hasLater,
    },
    result,
    artifacts: [],
  };
}

export function projectNativeOperationDetail(
  conversationId: string,
  turn: NativeAgentTurnFrame,
  request: AgentOperationDetailRequest,
): AgentOperationDetailResource {
  const orderedBlock = turn.passes.flatMap(({ blocks }) => blocks)
    .find(({ blockId }) => request.operationId === blockId ||
      request.operationId.startsWith(`${blockId}:action:`));
  const orderedTool = orderedBlock?.payload.kind === 'tool' ? orderedBlock.payload : undefined;
  const operation = turn.activity.operations.find(({ eventId }) => eventId === request.operationId);
  const detailValue = orderedTool?.inputPreview ?? operation?.inputPreview;
  const outputValue = orderedTool?.outputPreview ?? operation?.outputPreview;
  const detail = detailValue === undefined ? null : printable(detailValue);
  const output = outputValue === undefined ? null : printable(outputValue);
  return {
    conversationId,
    turnId: turn.turnId,
    scopeId: request.scopeId,
    operationId: request.operationId,
    revision: turn.renderRevision,
    detail,
    output,
    truncation: {
      originalBytes: utf8Length(`${detail ?? ''}${output ?? ''}`),
      returnedBytes: utf8Length(`${detail ?? ''}${output ?? ''}`),
      truncated: false,
    },
  };
}

function projectTurnInferences(
  turn: NativeAgentTurnFrame,
  leadingCommentary?: string,
): AgentInferenceTrace[] {
  const inferences = turn.passes.map((pass, ordinal) => projectPass(turn, pass, ordinal));
  if (leadingCommentary) {
    const block: AgentInferenceBlock = {
      id: `task:${turn.turnId}`,
      type: 'commentary',
      state: turn.state === 'running' || turn.state === 'recovering' ? 'streaming' : 'final',
      revision: turn.renderRevision,
      text: leadingCommentary,
    };
    if (inferences[0]) inferences[0] = {
      ...inferences[0],
      blocks: [block, ...inferences[0].blocks],
    };
    else inferences.push(syntheticInference(turn, [block], 'task'));
  }
  // Positioned compaction notices supersede the trailing compatibility notice.
  if (turn.activity.compacted && !turn.inputItems?.some((input) => input.origin === 'compaction')) {
    inferences.push(syntheticInference(turn, [{
      id: `compaction:${turn.turnId}`,
      type: 'notice',
      state: 'final',
      revision: turn.renderRevision,
      text: 'Provider compacted its native context.',
      code: 'context-compaction',
    }], 'compaction'));
  }

  const representedCalls = new Set(inferences.flatMap(({ blocks }) => blocks.flatMap((block) =>
    block.type === 'action' ? [block.call.callId] : [])));
  const compatibilityCalls = nativeCalls(turn)
    .filter(({ callId }) => !representedCalls.has(callId));
  if (compatibilityCalls.length > 0) {
    inferences.push(syntheticInference(turn, compatibilityCalls.map((call): AgentInferenceBlock => ({
      id: `compatibility-action:${call.id}`,
      type: 'action',
      state: call.status,
      revision: call.revision,
      call,
    })), 'compatibility-actions'));
  }
  return inferences.filter(({ blocks }) => blocks.length > 0)
    .map((inference, ordinal) => ({ ...inference, ordinal,
      blocks: turn.state !== 'recovering' ? inference.blocks : inference.blocks.map((block): AgentInferenceBlock => {
        if (block.type === 'action') return block.call.status === 'running' && !block.call.childScopeId
          ? { ...block, state: 'recovering', call: { ...block.call, status: 'recovering' } } : block;
        return block.state === 'streaming' ? { ...block, state: 'partial' } : block;
      }),
    }));
}

function projectPass(
  turn: NativeAgentTurnFrame,
  pass: NativeAssistantPass,
  ordinal: number,
): AgentInferenceTrace {
  const blocks = pass.blocks.flatMap((block) =>
    block.blockId === turn.finalBlockId ? [] : projectOrderedBlock(turn, block));
  return {
    id: pass.passId,
    ordinal,
    state: passState(turn, pass),
    revision: `${turn.renderRevision}:${pass.passId}:${pass.state}:${pass.blocks.map(({ revision }) => revision).join('.')}`,
    startedAt: pass.blocks.find(({ startedAt }) => startedAt !== null)?.startedAt ?? turn.startedAt ?? 0,
    completedAt: pass.state === 'streaming'
      ? null
      : [...pass.blocks].reverse().find(({ completedAt }) => completedAt !== null)?.completedAt
        ?? turn.completedAt ?? null,
    durationMs: passDuration(pass),
    blocks,
  };
}

function projectOrderedBlock(
  turn: NativeAgentTurnFrame,
  block: NativeOrderedTurnBlock,
): AgentInferenceBlock[] {
  const revision = `${block.blockId}:${block.revision}:${block.state}`;
  switch (block.payload.kind) {
    case 'reasoning-summary':
      return block.payload.text.trim() ? [{
        id: block.blockId,
        type: 'reasoning',
        state: textBlockState(block),
        revision,
        text: block.payload.text,
        parts: reasoningPartsForDisplay(block.payload.text, block.payload.parts),
      }] : [];
    case 'commentary':
      return block.payload.text.trim() ? [{
        id: block.blockId,
        type: 'commentary',
        state: textBlockState(block),
        revision,
        text: block.payload.text,
      }] : [];
    case 'final-message':
      return block.payload.text.trim() ? [{
        id: block.blockId,
        type: 'assistantText',
        state: textBlockState(block),
        revision,
        text: block.payload.text,
      }] : [];
    case 'compatibility-notice':
      return [{
        id: block.blockId,
        type: 'notice',
        state: textBlockState(block),
        revision,
        text: block.payload.message,
        code: block.payload.code,
      }];
    case 'tool': {
      return projectOrderedToolCalls(turn, block).map((call) => ({
        id: call.id,
        type: 'action' as const,
        state: call.status,
        revision: call.revision,
        call,
      }));
    }
    case 'native-child':
    case 'federated-child': {
      const call = projectOrderedChild(block);
      return [{ id: block.blockId, type: 'action', state: call.status, revision, call }];
    }
    case 'web': {
      const activity = block.payload.activity;
      const call: AgentToolCallSummary = {
        id: block.blockId,
        callId: block.blockId,
        name: `web_${activity.kind}`,
        presentation: {
          category: 'search',
          label: activity.title ?? activity.query ?? activity.url ?? `Web ${activity.kind}`,
          subject: activity.url ?? activity.query ?? null,
        },
        status: blockActionState(block),
        revision,
        detailPreview: activity.url ?? activity.query ?? null,
        outputPreview: null,
        durationMs: blockDuration(block),
        childScopeId: null,
        childBoundary: null,
        childState: null,
        childDurationMs: null,
        childOperationCount: 0,
        childArtifactCount: 0,
        hasDetail: false,
      };
      return [{ id: block.blockId, type: 'action', state: call.status, revision, call }];
    }
  }
}

function reasoningPartsForDisplay(text: string, nativeParts?: readonly string[]) {
  if (nativeParts?.length) return [...nativeParts];
  const lines = text.split(/\r?\n/u);
  const parts: string[] = [];
  let current: string[] = [];
  const flush = () => {
    const part = current.join('\n').trim();
    if (part) parts.push(part);
    current = [];
  };
  for (const line of lines) {
    if (/^\s*\*\*[^*\n]+\*\*\s*$/u.test(line) && current.some((value) => value.trim())) flush();
    current.push(line);
  }
  flush();
  return parts.length > 1 ? parts : [text];
}

function projectOrderedToolCalls(
  turn: NativeAgentTurnFrame,
  block: NativeOrderedTurnBlock,
): AgentToolCallSummary[] {
  if (block.payload.kind !== 'tool') throw new Error('Expected a tool block.');
  const tool = block.payload.tool;
  const fileChanges = turn.activity.fileChanges.filter((change) =>
    change.blockId === block.blockId || change.blockId === tool.callId);
  if (fileChanges.length > 0) {
    return fileChanges.map((change, index) => projectFileChange(turn, change, index, block));
  }
  if (tool.category === 'shell') {
    const commandCalls = projectCommandActions(block);
    if (commandCalls.length > 0) return commandCalls;
  }
  return [projectOrderedTool(block)];
}

function projectOrderedTool(block: NativeOrderedTurnBlock): AgentToolCallSummary {
  if (block.payload.kind !== 'tool') throw new Error('Expected a tool block.');
  const { tool } = block.payload;
  const category = tool.category === 'shell'
    ? 'command'
    : tool.category === 'file' ? fileOperationCategory(tool.name)
      : tool.category === 'search' || tool.category === 'web' ? 'search'
        : 'tool';
  return {
    id: block.blockId,
    callId: tool.callId,
    name: tool.name,
    presentation: {
      category,
      label: toolLabel(tool.name, tool.title, category, blockActionState(block), block.payload.inputPreview),
      subject: block.payload.backgrounded ? 'Waiting in background' : toolSubject(category, block.payload.inputPreview),
    },
    status: blockActionState(block),
    revision: `${block.blockId}:${block.revision}:${block.state}`,
    detailPreview: block.payload.inputPreview === undefined ? null : printable(block.payload.inputPreview),
    outputPreview: block.payload.outputPreview === undefined ? null : printable(block.payload.outputPreview),
    durationMs: blockDuration(block),
    childScopeId: null,
    childBoundary: null,
    childState: null,
    childDurationMs: null,
    childOperationCount: 0,
    childArtifactCount: 0,
    hasDetail: block.payload.inputPreview !== undefined || block.payload.outputPreview !== undefined ||
      block.payload.detailRef !== undefined,
  };
}

function projectCommandActions(block: NativeOrderedTurnBlock): AgentToolCallSummary[] {
  if (block.payload.kind !== 'tool') return [];
  const input = jsonRecord(block.payload.inputPreview);
  const actions = Array.isArray(input?.commandActions) ? input.commandActions : [];
  if (actions.length === 0) return [];
  const calls: AgentToolCallSummary[] = [];
  let hasUnknown = false;
  for (const [index, value] of actions.entries()) {
    const action = jsonRecord(value);
    const type = jsonString(action?.type);
    const path = jsonString(action?.path);
    const query = jsonString(action?.query);
    const command = jsonString(action?.command);
    const name = jsonString(action?.name);
    if (type === 'unknown') {
      hasUnknown = true;
      continue;
    }
    const status = blockActionState(block);
    const running = status === 'running';
    if (type === 'read') {
      const subject = path ?? name ?? null;
      calls.push(derivedCommandCall(block, index, calls.length, {
        category: 'read',
        label: `${running ? 'Reading' : 'Read'} ${name ?? (path ? fileName(path) : 'file')}`,
        subject,
      }));
    } else if (type === 'listFiles') {
      calls.push(derivedCommandCall(block, index, calls.length, {
        category: 'read',
        label: path
          ? `${running ? 'Listing' : 'Listed'} files in ${path}`
          : `${running ? 'Listing' : 'Listed'} files`,
        subject: path ?? null,
      }));
    } else if (type === 'search') {
      const target = query ? `“${query}”` : path ?? command ?? 'files';
      calls.push(derivedCommandCall(block, index, calls.length, {
        category: 'search',
        label: `${running ? 'Searching' : 'Searched'} ${target}`,
        subject: path ?? query ?? null,
      }));
    }
  }
  if (calls.length === 0 || hasUnknown) {
    const commandCall = projectOrderedTool(block);
    calls.push({
      ...commandCall,
      id: `${block.blockId}:action:command`,
      callId: calls.length === 0 ? block.payload.tool.callId : `${block.payload.tool.callId}:command`,
    });
  }
  if (calls.length > 0 && calls[0]!.callId !== block.payload.tool.callId) {
    calls[0] = { ...calls[0]!, callId: block.payload.tool.callId };
  }
  return calls;
}

function derivedCommandCall(
  block: NativeOrderedTurnBlock,
  actionIndex: number,
  callIndex: number,
  presentation: AgentToolCallSummary['presentation'],
): AgentToolCallSummary {
  if (block.payload.kind !== 'tool') throw new Error('Expected a tool block.');
  return {
    ...projectOrderedTool(block),
    id: `${block.blockId}:action:${actionIndex}`,
    callId: callIndex === 0
      ? block.payload.tool.callId
      : `${block.payload.tool.callId}:action:${actionIndex}`,
    name: `shell_${presentation.category}`,
    presentation,
  };
}

function projectOrderedChild(block: NativeOrderedTurnBlock): AgentToolCallSummary {
  if (block.payload.kind !== 'native-child' && block.payload.kind !== 'federated-child') {
    throw new Error('Expected a child block.');
  }
  const { child } = block.payload;
  const childState = block.payload.executionState === 'running' ||
    block.payload.executionState === 'recovering'
    ? 'running'
    : block.payload.executionState === 'interrupted' ? 'interrupted'
      : block.payload.executionState === 'failed' ? 'failed' : 'completed';
  return {
    id: block.blockId,
    callId: child.executionId,
    name: child.ownership === 'native' ? 'native_subagent' : 'federated_subagent',
    presentation: {
      category: 'tool',
      label: child.title ?? `${child.provider} subagent`,
      subject: block.payload.summary ?? null,
    },
    status: blockActionState(block),
    revision: `${block.blockId}:${block.revision}:${block.state}:${childState}`,
    detailPreview: block.payload.summary ?? null,
    outputPreview: block.payload.summary ?? null,
    durationMs: blockDuration(block),
    childScopeId: nativeExecutionScopeId(child.executionId),
    childBoundary: child.ownership,
    childState,
    childDurationMs: blockDuration(block),
    childOperationCount: 0,
    childArtifactCount: 0,
    hasDetail: false,
  };
}

function syntheticInference(
  turn: NativeAgentTurnFrame,
  blocks: AgentInferenceBlock[],
  suffix: string,
): AgentInferenceTrace {
  return {
    id: `${suffix}:${turn.turnId}`,
    ordinal: turn.passes.length,
    state: inferenceState(turn),
    revision: `${turn.renderRevision}:${suffix}`,
    startedAt: turn.startedAt ?? 0,
    completedAt: turn.completedAt ?? null,
    durationMs: duration(turn),
    blocks,
  };
}

function inferenceState(turn: NativeAgentTurnFrame): AgentInferenceTrace['state'] {
  return turn.state === 'running' || turn.state === 'recovering'
    ? 'running'
    : turn.state === 'completed' ? 'completed'
      : turn.state === 'interrupted' ? 'interrupted' : 'failed';
}

function passState(
  turn: NativeAgentTurnFrame,
  pass: NativeAssistantPass,
): AgentInferenceTrace['state'] {
  if (pass.state === 'streaming') return 'running';
  return inferenceState(turn);
}

function textBlockState(block: NativeOrderedTurnBlock): 'streaming' | 'final' | 'partial' {
  if (block.state === 'streaming' || block.state === 'running') return 'streaming';
  return block.state === 'completed' ? 'final' : 'partial';
}

function blockActionState(
  block: NativeOrderedTurnBlock,
): 'running' | 'completed' | 'failed' | 'interrupted' {
  if (block.state === 'streaming' || block.state === 'running') return 'running';
  return block.state;
}

function blockDuration(block: NativeOrderedTurnBlock) {
  return block.startedAt === null || block.completedAt === null
    ? null
    : Math.max(0, block.completedAt - block.startedAt);
}

function passDuration(pass: NativeAssistantPass) {
  const startedAt = pass.blocks.find(({ startedAt }) => startedAt !== null)?.startedAt ?? null;
  const completedAt = [...pass.blocks].reverse()
    .find(({ completedAt }) => completedAt !== null)?.completedAt ?? null;
  return startedAt === null || completedAt === null ? null : Math.max(0, completedAt - startedAt);
}

function projectUserPart(part: NativeAgentTurnFrame['userContent'][number]): AgentUserMessagePart {
  if (part.type === 'text') return { type: 'text', text: part.text };
  if (part.type === 'file-reference') {
    const name = part.path.split(/[\\/]/u).filter(Boolean).at(-1) ?? part.path;
    return { type: 'mention', kind: 'file', name, path: part.path };
  }
  return {
    type: 'image',
    artifactHash: part.artifactId,
    mimeType: part.mimeType,
    name: part.name ?? 'Image',
    sizeBytes: part.byteLength ?? 0,
  };
}

function nativeCalls(turn: NativeAgentTurnFrame): AgentToolCallSummary[] {
  const orderedBlocks = turn.passes.flatMap(({ blocks }) => blocks);
  // Watched workspace changes that no tool block claims and that carry no
  // diff are observations, not calls: one summary row keeps the count honest.
  const unclaimed: NativeFileChangeView[] = [];
  const perFile = turn.activity.fileChanges.flatMap((change, index) => {
    const block = orderedBlocks.find((candidate) => candidate.payload.kind === 'tool' &&
      (change.blockId === candidate.blockId || change.blockId === candidate.payload.tool.callId));
    if (!block && !change.diffArtifactId) {
      unclaimed.push(change);
      return [];
    }
    const linkedIndex = block
      ? turn.activity.fileChanges.slice(0, index).filter((candidate) =>
          candidate.blockId === block.blockId ||
          (block.payload.kind === 'tool' && candidate.blockId === block.payload.tool.callId)).length
      : index;
    return [projectFileChange(turn, change, linkedIndex, block)];
  });
  return [
    ...turn.activity.operations.map(projectOperation),
    ...perFile,
    ...(unclaimed.length ? [projectWatchedChanges(turn, unclaimed)] : []),
    ...(turn.passes.some(({ blocks }) => blocks.some(({ kind }) => kind === 'web'))
      ? []
      : turn.activity.web.map((activity, index): AgentToolCallSummary => ({
      id: `web:${turn.turnId}:${index}`,
      callId: `web:${index}`,
      name: `web_${activity.kind}`,
      presentation: {
        category: 'search',
        label: activity.title ?? activity.query ?? activity.url ?? `Web ${activity.kind}`,
        subject: activity.url ?? activity.query ?? null,
      },
      status: 'completed',
      revision: turn.renderRevision,
      detailPreview: activity.url ?? activity.query ?? null,
      outputPreview: null,
      durationMs: null,
      childScopeId: null,
      childBoundary: null,
      childState: null,
      childDurationMs: null,
      childOperationCount: 0,
      childArtifactCount: 0,
      hasDetail: false,
      }))),
    ...turn.activity.children.map((child): AgentToolCallSummary => ({
      id: `child:${child.executionId}`,
      callId: child.executionId,
      name: child.ownership === 'native' ? 'native_subagent' : 'federated_subagent',
      presentation: {
        category: 'tool',
        label: child.title ?? `${child.provider} subagent`,
        subject: child.summary ?? null,
      },
      status: child.state === 'running' || child.state === 'recovering'
        ? 'running'
        : child.state === 'interrupted' ? 'interrupted'
          : child.state === 'failed' ? 'failed' : 'completed',
      revision: `${turn.renderRevision}:${child.executionId}:${child.state}`,
      detailPreview: child.summary ?? null,
      outputPreview: child.summary ?? null,
      durationMs: null,
      childScopeId: nativeExecutionScopeId(child.executionId),
      childBoundary: child.ownership,
      childState: child.state === 'running' || child.state === 'recovering'
        ? 'running'
        : child.state === 'interrupted' ? 'interrupted'
          : child.state === 'failed' ? 'failed' : 'completed',
      childDurationMs: null,
      childOperationCount: 0,
      childArtifactCount: 0,
      hasDetail: false,
    })),
  ];
}

export function nativeExecutionScopeId(executionId: string) {
  return `execution:${executionId}`;
}

export function nativeExecutionId(scopeId: string) {
  if (scopeId.startsWith('execution:')) return scopeId.slice('execution:'.length);
  // Read legacy in-memory/cache keys across a viewer-only reload. New
  // projections always author the provider-neutral execution scope.
  return scopeId.startsWith('federated:') ? scopeId.slice('federated:'.length) : null;
}

function projectOperation(operation: NativeOperationView): AgentToolCallSummary {
  const category = operation.tool.category === 'shell'
    ? 'command'
    : operation.tool.category === 'file' ? fileOperationCategory(operation.tool.name)
      : operation.tool.category === 'search' || operation.tool.category === 'web' ? 'search'
        : 'tool';
  return {
    id: operation.eventId,
    callId: operation.tool.callId,
    name: operation.tool.name,
    presentation: {
      category,
      label: toolLabel(
        operation.tool.name,
        operation.tool.title,
        category,
        operation.state === 'running' ? 'running' : operation.state === 'failed' ? 'failed' : 'completed',
        operation.inputPreview,
      ),
      subject: toolSubject(category, operation.inputPreview),
    },
    status: operation.state === 'running'
      ? 'running'
      : operation.state === 'failed' ? 'failed' : 'completed',
    revision: `${operation.eventId}:${operation.state}:${printable(operation.outputPreview)}`,
    detailPreview: operation.inputPreview === undefined ? null : printable(operation.inputPreview),
    outputPreview: operation.outputPreview === undefined ? null : printable(operation.outputPreview),
    durationMs: operation.completedAt === undefined ? null : Math.max(0, operation.completedAt - operation.startedAt),
    childScopeId: null,
    childBoundary: null,
    childState: null,
    childDurationMs: null,
    childOperationCount: 0,
    childArtifactCount: 0,
    hasDetail: operation.inputPreview !== undefined || operation.outputPreview !== undefined,
  };
}

function projectFileChange(
  turn: NativeAgentTurnFrame,
  change: NativeFileChangeView,
  index: number,
  block?: NativeOrderedTurnBlock,
): AgentToolCallSummary {
  const tool = block?.payload.kind === 'tool' ? block.payload.tool : undefined;
  const status = block ? blockActionState(block) : 'completed';
  const name = fileName(change.path);
  const verb = fileChangeVerb(change.kind, status === 'running');
  return {
    id: block ? `${block.blockId}:action:file:${change.path}` : `file:${turn.turnId}:${change.path}`,
    callId: tool
      ? index === 0 ? tool.callId : `${tool.callId}:file:${change.path}`
      : `file:${turn.turnId}:${change.path}`,
    name: 'file_change',
    presentation: { category: 'edit', label: `${verb} ${name}`, subject: change.path },
    status,
    revision: block
      ? `${block.blockId}:${block.revision}:${block.state}:file:${change.path}:${turn.renderRevision}`
      : `${turn.renderRevision}:file:${change.path}`,
    detailPreview: change.oldPath ? `From ${change.oldPath}` : null,
    outputPreview: null,
    durationMs: block ? blockDuration(block) : null,
    childScopeId: null,
    childBoundary: null,
    childState: null,
    childDurationMs: null,
    childOperationCount: 0,
    childArtifactCount: 0,
    hasDetail: Boolean(change.diffArtifactId),
    ...(change.diffArtifactId ? { diffArtifactId: change.diffArtifactId } : {}),
  };
}

const WATCHED_CHANGE_PREVIEW_LIMIT = 12;

function projectWatchedChanges(turn: NativeAgentTurnFrame, changes: readonly NativeFileChangeView[]): AgentToolCallSummary {
  const names = changes.map((change) => fileName(change.path));
  const uniformKind = changes.every((change) => change.kind === changes[0]!.kind) ? changes[0]!.kind : 'update';
  const verb = fileChangeVerb(uniformKind, false);
  const label = changes.length === 1 ? `${verb} ${names[0]}`
    : changes.length === 2 ? `${verb} ${names[0]} and ${names[1]}`
      : `${verb} ${changes.length} files`;
  const preview = changes.slice(0, WATCHED_CHANGE_PREVIEW_LIMIT).map((change) => change.path).join('\n');
  return {
    id: `files:${turn.turnId}`,
    callId: `files:${turn.turnId}`,
    name: 'file_change',
    presentation: { category: 'edit', label, subject: changes.length === 1 ? changes[0]!.path : null },
    status: 'completed',
    revision: `${turn.renderRevision}:files:${changes.length}`,
    detailPreview: changes.length > WATCHED_CHANGE_PREVIEW_LIMIT
      ? `${preview}\n… ${changes.length - WATCHED_CHANGE_PREVIEW_LIMIT} more`
      : changes.length > 1 ? preview : null,
    outputPreview: null,
    durationMs: null,
    childScopeId: null,
    childBoundary: null,
    childState: null,
    childDurationMs: null,
    childOperationCount: 0,
    childArtifactCount: 0,
    hasDetail: false,
  };
}

function fileChangeVerb(kind: NativeFileChangeView['kind'], running: boolean) {
  if (kind === 'add') return running ? 'Adding' : 'Added';
  if (kind === 'delete') return running ? 'Deleting' : 'Deleted';
  if (kind === 'move') return running ? 'Moving' : 'Moved';
  return running ? 'Editing' : 'Edited';
}

function toolLabel(
  name: string,
  title: string | undefined,
  category: AgentToolCallSummary['presentation']['category'],
  status: AgentToolCallSummary['status'],
  input: unknown,
) {
  const running = status === 'running';
  if (category === 'command') {
    const record = jsonRecord(input);
    const description = jsonString(record?.description)?.trim();
    if (description) return description;
    const commandInput = jsonString(record?.command) ?? jsonString(input);
    const command = displayShellCommand(commandInput ?? title ?? name);
    if (title?.trim() && title !== name && !/^(?:shell command|run command|bash)$/iu.test(title.trim()) &&
      commandInput && title.trim() !== command) return title.trim();
    // Full arguments remain available in the operation disclosure.
    const compactCommand = command.replace(/\s+/gu, ' ');
    const preview = compactCommand.slice(0, 160);
    return `${running ? 'Running' : 'Ran'} ${preview || 'command'}${compactCommand.length > 160 ? '…' : ''}`;
  }
  return title ?? name;
}

function toolSubject(
  category: AgentToolCallSummary['presentation']['category'],
  input: unknown,
) {
  const value = jsonRecord(input);
  if (!value) return input === undefined ? null : printable(input);
  if (category === 'command') return jsonString(value.cwd) ?? null;
  return jsonString(value.path)
    ?? jsonString(value.file_path)
    ?? jsonString(value.query)
    ?? printable(input);
}

function displayShellCommand(command: string) {
  const trimmed = command.trim();
  const match = /^(?:\/usr\/bin\/|\/bin\/)?(?:ba|z|)sh\s+-(?:l?c|cl)\s+(['"])([\s\S]*)\1$/u.exec(trimmed);
  if (!match?.[2]) return trimmed;
  return match[1] === "'" ? match[2].replace(/'\\''/gu, "'") : match[2];
}

function jsonRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function jsonString(value: unknown) {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function fileName(path: string) {
  return path.replace(/\\/gu, '/').split('/').filter(Boolean).at(-1) ?? path;
}

function fileOperationCategory(name: string): 'edit' | 'read' | 'search' {
  if (/(?:search|find|glob|grep)/iu.test(name)) return 'search';
  if (/(?:read|list|stat|inspect|view)/iu.test(name)) return 'read';
  return 'edit';
}

function turnStatus(turn: NativeAgentTurnFrame): AgentTurnRenderFrame['status'] {
  if (turn.state === 'queued') return 'queued';
  if (turn.state === 'running' || turn.state === 'recovering') return 'inProgress';
  return turn.state;
}

function workState(turn: NativeAgentTurnFrame): 'running' | 'recovering' | 'completed' | 'failed' | 'interrupted' {
  if (turn.state === 'running' || turn.state === 'queued') return 'running';
  return turn.state;
}

function duration(turn: NativeAgentTurnFrame) {
  if (turn.startedAt === undefined || turn.completedAt === undefined) return null;
  return Math.max(0, turn.completedAt - turn.startedAt);
}

function printable(value: unknown) {
  if (value === undefined) return '';
  return typeof value === 'string' ? value : JSON.stringify(value, null, 2);
}

function utf8Length(value: string) {
  return new TextEncoder().encode(value).byteLength;
}

function hasAdditionalInputs(turn: NativeAgentTurnFrame) {
  return Boolean(turn.additionalMessages?.length || turn.inputItems?.some(input => input.clientMessageId !== turn.clientMessageId));
}
function projectNotice(input: NativeTurnNotice, revision: string): Extract<AgentTurnSegment, { type: 'notice' }> {
  return { id: `notice:${input.clientMessageId}`, type: 'notice', revision, text: input.text,
    ...(input.elapsedMs === undefined ? {} : { elapsedMs: input.elapsedMs }) };
}
