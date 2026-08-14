import { readFile, stat } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { createHash } from 'node:crypto';

import {
  MAX_WORK_ENTRY_DETAIL_BYTES,
} from '../../../shared/transcript.ts';
import type {
  AgentExecutionScopeRequest,
  AgentExecutionScopeResource,
  AgentInferenceTrace,
  AgentOperationDetailRequest,
  AgentOperationDetailResource,
  AgentToolCallSummary,
  AgentWorkUnitResourceReference,
  AgentWorkUnitStatus,
} from '../../../shared/transcript.ts';

import type { CanonicalJsonValue } from './canonical-json.ts';
import { canonicalJson } from './canonical-json.ts';
import type {
  WorkUnitEnterInput,
  WorkUnitResourceRef,
  WorkUnitReturnInput,
  WorkUnitReturnStatus,
} from '../domain/work.ts';
import type {
  DurableContentRef,
  DurableTranscriptProjectionAction,
  DurableTurnHandle,
  PreparedWorkUnitEntry,
  PreparedWorkUnitResource,
  PreparedWorkUnitReturn,
} from '../domain/state.ts';
import {
  renderMaterializedResourceSection,
  renderWorkUnitPrompt,
  type MaterializedPromptResource,
} from '../prompts.ts';
import { AgentStateCore } from './state-core.ts';
import { parseReference, safeTimestamp } from './state-codec.ts';

type ScopeIdentity = {
  scope_id: string;
  parent_scope_id: string | null;
  kind: 'turn' | 'work_unit';
  state: string;
};

type HistoryIndexInput = {
  ref: string;
  projectId: string;
  conversationId?: string | null;
  turnId?: string | null;
  kind: string;
  sequence: number;
  text: string;
};

/** Durable work-unit behavior layered on the single state core. */
export abstract class WorkUnitState extends AgentStateCore {
  protected abstract assertRunningHandle(handle: DurableTurnHandle): void;
  protected abstract scopeIdentity(scopeId: string): ScopeIdentity;
  protected abstract indexHistoryText(input: HistoryIndexInput): void;
  protected abstract resolveOpenableContent(conversationId: string, ref: string): Promise<string>;

  async prepareWorkUnitEntry(
    handle: DurableTurnHandle,
    input: WorkUnitEnterInput,
  ): Promise<PreparedWorkUnitEntry> {
    this.assertOpen();
    this.assertRunningHandle(handle);
    const objective = input.objective.trim();
    if (!objective) throw new TypeError('A work unit objective is required.');
    if (Buffer.byteLength(objective, 'utf8') > 4 * 1024) {
      throw new TypeError('A work unit objective must not exceed 4 KiB.');
    }
    const doneWhen = normalizeWorkUnitDoneWhen(input.doneWhen ?? []);
    const resources = normalizeWorkUnitResources(input.resources ?? []);
    const materializedResources = await this.prepareWorkUnitResources(
      handle,
      resources,
      this.parentMaterializedResourceHashes(handle.turnId),
    );
    const orientation = await this.prepareText(renderWorkUnitPrompt({
      objective,
      doneWhen,
      resources: materializedResources.map(modelPromptWorkUnitResource),
    }));
    const child: DurableTurnHandle = { ...handle, scopeId: this.nextId('scope') };
    return { child, doneWhen, materializedResources, objective, orientation };
  }

  commitWorkUnitEntry(
    handle: DurableTurnHandle,
    prepared: PreparedWorkUnitEntry,
    linkage: { parentOperationId: string; parentInferenceId: string },
  ) {
    const { child, doneWhen, materializedResources, objective, orientation } = prepared;
    return this.enqueueWrite(() => this.storage.transaction(() => {
      this.assertRunningHandle(handle);
      const parent = this.scopeIdentity(handle.scopeId);
      if (parent.kind !== 'turn' || parent.parent_scope_id !== null) {
        throw new Error('Work units cannot be nested.');
      }
      const parentOperation = this.storage.database.prepare(`
        SELECT 1
        FROM operations
        WHERE operation_id = ? AND project_id = ? AND conversation_id = ?
          AND turn_id = ? AND scope_id = ? AND source_inference_id = ?
          AND kind = 'tool.call'
      `).get(
        linkage.parentOperationId,
        handle.projectId,
        handle.conversationId,
        handle.turnId,
        handle.scopeId,
        linkage.parentInferenceId,
      );
      if (!parentOperation) {
        throw new Error('A work unit requires its durable parent operation and inference.');
      }
      const runningChild = this.storage.database.prepare(`
        SELECT 1 FROM execution_scopes
        WHERE parent_scope_id = ? AND kind = 'work_unit' AND terminal_sequence IS NULL
      `).get(handle.scopeId);
      if (runningChild) throw new Error('A work unit is already active for this turn.');
      const recordedAt = safeTimestamp(this.now());
      const sequence = this.insertEvent({
        ...child,
        eventId: this.nextId('event'),
        type: 'work_unit.entered',
        actor: 'model',
        visibility: 'internal',
        payload: {
          doneWhen,
          objective,
          parentInferenceId: linkage.parentInferenceId,
          parentOperationId: linkage.parentOperationId,
          parentScopeId: handle.scopeId,
          resources: materializedResources.map(({ view }) => view),
          scopeId: child.scopeId,
        },
        createdAt: recordedAt,
      });
      this.storage.database.prepare(`
        INSERT INTO execution_scopes (
          scope_id, project_id, conversation_id, turn_id,
          parent_scope_id, parent_operation_id, kind, objective_json, state, created_sequence,
          terminal_sequence, result_artifact_hash, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'work_unit', ?, 'running', ?, NULL, NULL, ?, ?)
      `).run(
        child.scopeId,
        child.projectId,
        child.conversationId,
        child.turnId,
        handle.scopeId,
        linkage.parentOperationId,
        canonicalJson({ doneWhen, objective, resources: materializedResources.map(({ view }) => view) }),
        sequence,
        recordedAt,
        recordedAt,
      );
      for (const resource of materializedResources) this.insertArtifact(resource.artifact, sequence, 'content');
      this.indexHistoryText({
        ref: `history://scope/${encodeURIComponent(child.scopeId)}`,
        projectId: child.projectId,
        conversationId: child.conversationId,
        turnId: child.turnId,
        kind: 'work-unit-objective',
        sequence,
        text: objective,
      });
      const orientationSequence = this.insertEvent({
        ...child,
        eventId: this.nextId('event'),
        type: 'message.internal',
        actor: 'harness',
        visibility: 'internal',
        payload: { content: orientation.ref, kind: 'work_unit_orientation' },
        artifactHash: artifactHash(orientation.ref),
        createdAt: recordedAt,
      });
      this.insertArtifact(orientation.artifact, orientationSequence);
      return {
        handle: child,
        parentScopeId: handle.scopeId,
        objective,
        doneWhen,
        resources: materializedResources.map(({ view }) => view),
        transcriptSequence: sequence,
        transcriptCreatedAt: recordedAt,
      };
    }));
  }

  async prepareWorkUnitReturn(
    handle: DurableTurnHandle,
    input: WorkUnitReturnInput,
  ): Promise<PreparedWorkUnitReturn> {
    this.assertOpen();
    this.assertRunningHandle(handle);
    const child = this.scopeIdentity(handle.scopeId);
    if (child.kind !== 'work_unit' || child.parent_scope_id === null) {
      throw new Error('No work unit is active.');
    }
    const normalized = normalizeWorkUnitReturnInput(input);
    const resources = await this.prepareWorkUnitResources(
      handle,
      normalized.resources,
      this.parentMaterializedResourceHashes(handle.turnId),
    );
    const bundle = renderWorkUnitReturnBundle({
      resources: resources.map(modelPromptWorkUnitResource),
      result: normalized.result,
      status: normalized.status,
      threadUpdate: normalized.threadUpdate,
    });
    const resultArtifact = await this.artifacts.put(
      Buffer.from(bundle, 'utf8'),
      'text/markdown; charset=utf-8',
    );
    const folded = await this.prepareText([
      'Current work: parent conversation. The focused work unit is closed; do not call work_unit_finish again.',
      `The work unit returned from history://scope/${encodeURIComponent(handle.scopeId)}.`,
      '',
      bundle,
      '',
      `Exact work-unit History: history://scope/${encodeURIComponent(handle.scopeId)}`,
    ].join('\n'));
    return { ...normalized, bundle, folded, resources, resultArtifact };
  }

  commitWorkUnitReturn(handle: DurableTurnHandle, prepared: PreparedWorkUnitReturn) {
    this.assertOpen();
    return this.enqueueWrite(() => this.storage.transaction(() => {
      this.assertRunningHandle(handle);
      const child = this.scopeIdentity(handle.scopeId);
      if (child.kind !== 'work_unit' || child.parent_scope_id === null) {
        throw new Error('No work unit is active.');
      }
      const parentHandle = { ...handle, scopeId: child.parent_scope_id };
      const parent = this.scopeIdentity(parentHandle.scopeId);
      if (parent.kind !== 'turn' || parent.state !== 'running') {
        throw new Error('The work unit parent is no longer running.');
      }
      const recordedAt = safeTimestamp(this.now());
      const terminalSequence = this.insertEvent({
        ...handle,
        eventId: this.nextId('event'),
        type: 'work_unit.returned',
        actor: 'model',
        visibility: 'internal',
        payload: {
          resources: prepared.resources.map(({ view }) => view),
          parentScopeId: parentHandle.scopeId,
          resultRef: `history://artifact/${prepared.resultArtifact.hash}`,
          scopeId: handle.scopeId,
          status: prepared.status,
        },
        artifactHash: prepared.resultArtifact.hash,
        createdAt: recordedAt,
      });
      this.insertArtifact(prepared.resultArtifact, terminalSequence, 'content');
      for (const resource of prepared.resources) this.insertArtifact(resource.artifact, terminalSequence, 'content');
      this.storage.database.prepare(`
        UPDATE execution_scopes
        SET state = 'completed', terminal_sequence = ?, result_artifact_hash = ?, updated_at = ?
        WHERE scope_id = ? AND state = 'running' AND terminal_sequence IS NULL
      `).run(terminalSequence, prepared.resultArtifact.hash, recordedAt, handle.scopeId);
      this.indexHistoryText({
        ref: `history://artifact/${prepared.resultArtifact.hash}`,
        projectId: handle.projectId,
        conversationId: handle.conversationId,
        turnId: handle.turnId,
        kind: 'work-unit-result',
        sequence: terminalSequence,
        text: prepared.bundle,
      });
      const foldedSequence = this.insertEvent({
        ...parentHandle,
        eventId: this.nextId('event'),
        type: 'message.internal',
        actor: 'harness',
        visibility: 'internal',
        payload: {
          childScopeId: handle.scopeId,
          content: prepared.folded.ref,
          kind: 'work_unit_result',
          resultRef: `history://artifact/${prepared.resultArtifact.hash}`,
        },
        artifactHash: artifactHash(prepared.folded.ref),
        createdAt: recordedAt,
      });
      this.insertArtifact(prepared.folded.artifact, foldedSequence);
      return {
        parentHandle,
        status: prepared.status,
        result: prepared.result,
        ...(prepared.threadUpdate ? { threadUpdate: prepared.threadUpdate } : {}),
        resources: prepared.resources.map(({ view }) => view),
        resultRef: `history://artifact/${prepared.resultArtifact.hash}`,
        scopeId: handle.scopeId,
        transcriptSequence: terminalSequence,
        transcriptCreatedAt: recordedAt,
      };
    }));
  }

  async returnWorkUnit(handle: DurableTurnHandle, input: WorkUnitReturnInput) {
    return this.commitWorkUnitReturn(handle, await this.prepareWorkUnitReturn(handle, input));
  }

  async readExecutionScopeTranscriptResource(
    conversationId: string,
    request: AgentExecutionScopeRequest,
  ): Promise<AgentExecutionScopeResource | null> {
    this.assertOpen();
    await this.writerTail;
    const scope = this.storage.database.prepare(`
      SELECT s.scope_id, s.turn_id, s.parent_scope_id, s.parent_operation_id,
             s.kind, s.objective_json, s.state, s.created_sequence,
             s.terminal_sequence, s.result_artifact_hash, s.created_at, s.updated_at,
             terminal.payload_json AS terminal_payload
      FROM execution_scopes s
      LEFT JOIN events terminal ON terminal.sequence = s.terminal_sequence
      WHERE s.conversation_id = ? AND s.turn_id = ? AND s.scope_id = ?
    `).get(conversationId, request.turnId, request.scopeId) as {
      scope_id: string;
      turn_id: string;
      parent_scope_id: string | null;
      parent_operation_id: string | null;
      kind: 'turn' | 'work_unit';
      objective_json: string;
      state: string;
      created_sequence: number;
      terminal_sequence: number | null;
      result_artifact_hash: string | null;
      created_at: number;
      updated_at: number;
      terminal_payload: string | null;
    } | undefined;
    if (!scope) return null;

    const terminal = scope.terminal_payload
      ? JSON.parse(scope.terminal_payload) as Record<string, unknown>
      : null;
    const objective = scope.kind === 'work_unit'
      ? parseWorkUnitObjective(scope.objective_json)
      : { objective: null, doneWhen: [], resources: [] };
    const bundle = scope.result_artifact_hash
      ? await this.readArtifactTextByHash(scope.result_artifact_hash)
      : null;
    const sections = bundle ? workUnitBundleSections(bundle) : { result: null, threadUpdate: null };
    const returnedResources = parseWorkUnitResourceReferences(terminal?.resources);
    const rows = this.storage.database.prepare(`
      SELECT i.inference_id, i.ordinal, i.state, i.started_sequence,
             i.terminal_sequence, i.reasoning_summary_artifact_hash,
             i.assistant_text_artifact_hash, i.assistant_text_phase,
             (
               SELECT pi.inspectable_artifact_hash
               FROM provider_items pi
               WHERE pi.inference_id = i.inference_id
               ORDER BY pi.ordinal DESC LIMIT 1
             ) AS inspectable_artifact_hash,
             started.created_at AS started_at, terminal.created_at AS completed_at,
             EXISTS (
               SELECT 1 FROM events superseded
               WHERE superseded.scope_id = i.scope_id
                 AND superseded.type = 'inference.superseded'
                 AND json_extract(superseded.payload_json, '$.inferenceId') = i.inference_id
             ) AS superseded
      FROM inferences i
      JOIN events started ON started.sequence = i.started_sequence
      LEFT JOIN events terminal ON terminal.sequence = i.terminal_sequence
      WHERE i.scope_id = ?
      ORDER BY i.ordinal, i.inference_id
    `).all(scope.scope_id) as Array<{
      inference_id: string;
      ordinal: number;
      state: 'running' | 'completed' | 'failed' | 'interrupted';
      started_sequence: number;
      terminal_sequence: number | null;
      reasoning_summary_artifact_hash: string | null;
      assistant_text_artifact_hash: string | null;
      assistant_text_phase: 'commentary' | 'final_answer' | null;
      inspectable_artifact_hash: string | null;
      started_at: number;
      completed_at: number | null;
      superseded: number;
    }>;

    const selection = selectExecutionScopeWindow(rows, request.window);
    let basisSequence = Math.max(
      scope.terminal_sequence ?? scope.created_sequence,
      ...rows.map((row) => row.terminal_sequence ?? row.started_sequence),
    );
    const inferences: AgentInferenceTrace[] = [];
    for (const row of selection.rows) {
      basisSequence = Math.max(basisSequence, row.terminal_sequence ?? row.started_sequence);
      const reasoning = await this.readInferenceReasoning(
        scope.scope_id,
        row.inference_id,
        row.reasoning_summary_artifact_hash,
        row.state,
      );
      basisSequence = Math.max(basisSequence, reasoning.basisSequence);
      const commentary = await this.readInferenceCommentary(
        scope.scope_id,
        row.inference_id,
        row.assistant_text_artifact_hash,
        row.assistant_text_phase,
        row.state,
      );
      basisSequence = Math.max(basisSequence, commentary.basisSequence);
      const operationRows = this.storage.database.prepare(`
        SELECT o.operation_id, o.call_id, o.state, o.accepted_sequence,
               o.terminal_sequence, o.value_json,
               accepted.created_at AS started_at, terminal.created_at AS completed_at,
               child.scope_id AS child_scope_id, child.objective_json AS child_objective_json,
               child.state AS child_state, child.created_at AS child_created_at,
               child.updated_at AS child_updated_at,
               child.terminal_sequence AS child_terminal_sequence,
               child_terminal.payload_json AS child_terminal_payload,
               (SELECT COUNT(*) FROM operations child_operation
                WHERE child_operation.scope_id = child.scope_id
                  AND child_operation.kind = 'tool.call'
                  AND json_extract(child_operation.value_json, '$.name') <> 'work_unit_finish'
               ) AS child_operation_count
        FROM operations o
        JOIN events accepted ON accepted.sequence = o.accepted_sequence
        LEFT JOIN events terminal ON terminal.sequence = o.terminal_sequence
        LEFT JOIN execution_scopes child ON child.parent_operation_id = o.operation_id
        LEFT JOIN events child_terminal ON child_terminal.sequence = child.terminal_sequence
        WHERE o.scope_id = ? AND o.source_inference_id = ? AND o.kind = 'tool.call'
        ORDER BY o.accepted_sequence, o.operation_id
      `).all(scope.scope_id, row.inference_id) as Array<{
        operation_id: string;
        call_id: string | null;
        state: string;
        accepted_sequence: number;
        terminal_sequence: number | null;
        value_json: string;
        started_at: number;
        completed_at: number | null;
        child_scope_id: string | null;
        child_objective_json: string | null;
        child_state: string | null;
        child_created_at: number | null;
        child_updated_at: number | null;
        child_terminal_sequence: number | null;
        child_terminal_payload: string | null;
        child_operation_count: number;
      }>;
      const calls: AgentToolCallSummary[] = [];
      for (const operation of operationRows) {
        basisSequence = Math.max(
          basisSequence,
          operation.terminal_sequence ?? operation.accepted_sequence,
        );
        const value = JSON.parse(operation.value_json) as Record<string, unknown>;
        const argumentText = await this.readWorkUnitEventText(value.args);
        const presentationArgs = parseOperationArguments(argumentText);
        const status = operationTranscriptStatus(operation.state);
        const completedAt = operation.completed_at;
        const childTerminal = operation.child_terminal_payload
          ? JSON.parse(operation.child_terminal_payload) as Record<string, unknown>
          : null;
        const childState = operation.child_state === null
          ? null
          : executionScopeTranscriptStatus(operation.child_state, childTerminal?.status);
        const childDurationMs = operation.child_terminal_sequence === null ||
            operation.child_created_at === null || operation.child_updated_at === null
          ? null
          : Math.max(0, operation.child_updated_at - operation.child_created_at);
        const childReturnedResourceCount = parseWorkUnitResourceReferences(
          childTerminal?.resources,
        ).length;
        const name = typeof value.name === 'string' ? value.name : 'tool';
        calls.push({
          id: operation.operation_id,
          callId: operation.call_id ?? operation.operation_id,
          name,
          presentation: toolPresentation(name, presentationArgs),
          status,
          revision: `operation:${operation.terminal_sequence ?? operation.accepted_sequence}`,
          detailPreview: argumentText
            ? truncateWorkUnitPreview(argumentText.replace(/\s+/gu, ' ').trim(), 500)
            : null,
          outputPreview: operation.terminal_sequence === null
            ? null
            : await this.readWorkUnitEventPreview(value.result),
          durationMs: completedAt === null ? null : Math.max(0, completedAt - operation.started_at),
          childScopeId: operation.child_scope_id,
          childObjective: operation.child_objective_json
            ? parseWorkUnitObjective(operation.child_objective_json).objective
            : null,
          childState,
          childDurationMs,
          childOperationCount: operation.child_operation_count,
          childReturnedResourceCount,
          hasDetail: true,
        });
      }
      const completedAt = row.completed_at;
      const state = row.superseded === 1 ? 'superseded' : row.state;
      const contentOrder = await this.readInferenceContentOrder(
        row.inspectable_artifact_hash,
        {
          actions: calls.length > 0,
          commentary: Boolean(commentary.text),
          reasoning: Boolean(reasoning.text),
        },
      );
      const revisionBasis = [
        row.inference_id,
        row.terminal_sequence ?? 'running',
        commentary.revision,
        reasoning.revision,
        contentOrder.join(','),
        ...calls.map((call) => [
          call.revision,
          call.childState,
          call.childDurationMs,
          call.childOperationCount,
          call.childReturnedResourceCount,
        ].join(':')),
      ].join(':');
      inferences.push({
        id: row.inference_id,
        ordinal: row.ordinal,
        state,
        revision: `inference:${createHash('sha256').update(revisionBasis).digest('hex')}`,
        startedAt: row.started_at,
        completedAt,
        durationMs: completedAt === null ? null : Math.max(0, completedAt - row.started_at),
        contentOrder,
        commentary: commentary.text
          ? {
              kind: 'assistantCommentary',
              state: commentary.state,
              text: commentary.text,
              ...(commentary.content ? { content: commentary.content } : {}),
            }
          : null,
        reasoning: reasoning.text
          ? {
              kind: 'providerSummary',
              state: reasoning.state,
              text: reasoning.text,
              ...(reasoning.content ? { content: reasoning.content } : {}),
            }
          : null,
        actionGroup: calls.length > 0
          ? {
              id: `actions:${row.inference_id}`,
              status: operationGroupStatus(calls.map((call) => call.status)),
              callCount: calls.length,
              calls,
            }
          : null,
      });
    }

    const revisionBasis = [
      scope.created_sequence,
      scope.terminal_sequence ?? 'running',
      ...rows.map((row) => `${row.inference_id}:${row.terminal_sequence ?? 'running'}`),
      ...inferences.map((inference) => inference.revision),
    ].join(':');
    return {
      conversationId,
      turnId: scope.turn_id,
      scopeId: scope.scope_id,
      parentScopeId: scope.parent_scope_id,
      parentOperationId: scope.parent_operation_id,
      kind: scope.kind === 'turn' ? 'turn' : 'workUnit',
      state: executionScopeTranscriptStatus(scope.state, terminal?.status),
      revision: `execution-scope:${createHash('sha256').update(revisionBasis).digest('hex')}`,
      basisSequence,
      startedAt: scope.created_at,
      completedAt: scope.terminal_sequence === null ? null : scope.updated_at,
      durationMs: scope.terminal_sequence === null ? null : Math.max(0, scope.updated_at - scope.created_at),
      objective: objective.objective,
      doneWhen: objective.doneWhen,
      providedResources: objective.resources,
      inferenceOrder: rows.map((row) => row.inference_id),
      inferences,
      window: {
        startIndex: selection.startIndex,
        endIndexExclusive: selection.endIndexExclusive,
        hasEarlier: selection.startIndex > 0,
        hasLater: selection.endIndexExclusive < rows.length,
      },
      result: sections.result,
      returnedResources,
      threadUpdate: sections.threadUpdate,
    };
  }

  async readOperationDetailTranscriptResource(
    conversationId: string,
    request: AgentOperationDetailRequest,
  ): Promise<AgentOperationDetailResource | null> {
    this.assertOpen();
    await this.writerTail;
    const row = this.storage.database.prepare(`
      SELECT o.operation_id, o.accepted_sequence, o.terminal_sequence, o.value_json
      FROM operations o
      WHERE o.conversation_id = ? AND o.turn_id = ? AND o.scope_id = ?
        AND o.operation_id = ? AND o.kind = 'tool.call'
    `).get(
      conversationId,
      request.turnId,
      request.scopeId,
      request.operationId,
    ) as {
      operation_id: string;
      accepted_sequence: number;
      terminal_sequence: number | null;
      value_json: string;
    } | undefined;
    if (!row) return null;
    const value = JSON.parse(row.value_json) as Record<string, unknown>;
    const detail = await this.readProjectedTextRef(
      value.args as CanonicalJsonValue,
      MAX_WORK_ENTRY_DETAIL_BYTES / 2,
    );
    const output = value.result === null || value.result === undefined
      ? null
      : await this.readProjectedTextRef(
          value.result as CanonicalJsonValue,
          MAX_WORK_ENTRY_DETAIL_BYTES - Buffer.byteLength(detail.text, 'utf8'),
        );
    const returnedBytes = Buffer.byteLength(detail.text, 'utf8') +
      Buffer.byteLength(output?.text ?? '', 'utf8');
    const originalBytes = (detail.content?.byteLength ?? Buffer.byteLength(detail.text, 'utf8')) +
      (output?.content?.byteLength ?? Buffer.byteLength(output?.text ?? '', 'utf8'));
    return {
      conversationId,
      turnId: request.turnId,
      scopeId: request.scopeId,
      operationId: row.operation_id,
      revision: `operation-detail:${row.terminal_sequence ?? row.accepted_sequence}`,
      detail: detail.text || null,
      output: output?.text || null,
      truncation: {
        originalBytes,
        returnedBytes,
        truncated: originalBytes > returnedBytes,
      },
      ...(detail.content || output?.content
        ? {
            content: {
              ...(detail.content ? { detail: detail.content } : {}),
              ...(output?.content ? { output: output.content } : {}),
            },
          }
        : {}),
    };
  }

  async readWorkUnitProjectionActions(
    conversationId: string,
    turnIds?: readonly string[],
  ): Promise<DurableTranscriptProjectionAction[]> {
    this.assertOpen();
    await this.writerTail;
    if (turnIds && turnIds.length === 0) return [];
    const rows = (turnIds
      ? this.storage.database.prepare(`
          SELECT s.scope_id, s.turn_id, s.objective_json, s.state,
                 s.created_sequence, s.terminal_sequence, s.result_artifact_hash,
                 s.created_at, s.updated_at, terminal.payload_json AS terminal_payload,
                 (SELECT COUNT(*) FROM operations o
                  WHERE o.scope_id = s.scope_id AND o.kind = 'tool.call') AS operation_count
          FROM execution_scopes s
          LEFT JOIN events terminal ON terminal.sequence = s.terminal_sequence
          WHERE s.conversation_id = ? AND s.kind = 'work_unit'
            AND s.turn_id IN (${turnIds.map(() => '?').join(', ')})
          ORDER BY s.created_sequence, s.scope_id
        `).all(conversationId, ...turnIds)
      : this.storage.database.prepare(`
          SELECT s.scope_id, s.turn_id, s.objective_json, s.state,
                 s.created_sequence, s.terminal_sequence, s.result_artifact_hash,
                 s.created_at, s.updated_at, terminal.payload_json AS terminal_payload,
                 (SELECT COUNT(*) FROM operations o
                  WHERE o.scope_id = s.scope_id AND o.kind = 'tool.call') AS operation_count
          FROM execution_scopes s
          LEFT JOIN events terminal ON terminal.sequence = s.terminal_sequence
          WHERE s.conversation_id = ? AND s.kind = 'work_unit'
          ORDER BY s.created_sequence, s.scope_id
        `).all(conversationId)) as Array<{
          scope_id: string;
          turn_id: string;
          objective_json: string;
          state: string;
          created_sequence: number;
          terminal_sequence: number | null;
          result_artifact_hash: string | null;
          created_at: number;
          updated_at: number;
          terminal_payload: string | null;
          operation_count: number;
        }>;
    const actions: DurableTranscriptProjectionAction[] = [];
    for (const row of rows) {
      const objective = parseWorkUnitObjective(row.objective_json);
      const terminal = row.terminal_payload
        ? JSON.parse(row.terminal_payload) as Record<string, unknown>
        : null;
      const resources = uniqueWorkUnitReferences([
        ...objective.resources,
        ...parseWorkUnitResourceReferences(terminal?.resources),
      ]);
      const bundle = row.result_artifact_hash
        ? await this.readArtifactTextByHash(row.result_artifact_hash)
        : null;
      const result = bundle ? workUnitBundleSections(bundle).result : null;
      const transcriptStatus = workUnitTranscriptStatus(row.state, terminal?.status);
      actions.push({
        type: 'work-unit-start',
        turnId: row.turn_id,
        scopeId: row.scope_id,
        objective: objective.objective,
        doneWhen: objective.doneWhen,
        resourceCount: resources.length,
        operationCount: row.operation_count,
        sequence: row.created_sequence,
        createdAt: row.created_at,
        itemId: null,
      });
      if (row.terminal_sequence !== null) {
        actions.push({
          type: 'work-unit-finish',
          turnId: row.turn_id,
          scopeId: row.scope_id,
          status: transcriptStatus === 'running'
            ? 'abandoned'
            : transcriptStatus,
          resultPreview: result
            ? truncateWorkUnitPreview(result.replace(/\s+/gu, ' ').trim(), 320)
            : null,
          resourceCount: resources.length,
          durationMs: Math.max(0, row.updated_at - row.created_at),
          sequence: row.terminal_sequence,
          createdAt: row.updated_at,
          itemId: null,
        });
      }
    }
    return actions;
  }

  private async readWorkUnitEventText(value: unknown) {
    try {
      const ref = parseReference(value as CanonicalJsonValue);
      return ref.kind === 'inline' ? ref.text : await this.readArtifactTextByHash(ref.hash);
    } catch {
      return '';
    }
  }

  private async readWorkUnitEventPreview(value: unknown) {
    const text = await this.readWorkUnitEventText(value);
    return text ? truncateWorkUnitPreview(text.replace(/\s+/gu, ' ').trim(), 500) : null;
  }

  private async readInferenceReasoning(
    scopeId: string,
    inferenceId: string,
    finalArtifactHash: string | null,
    inferenceState: 'running' | 'completed' | 'failed' | 'interrupted',
  ) {
    if (finalArtifactHash) {
      const artifact = this.storage.database.prepare(`
        SELECT byte_length, media_type, storage_path, created_sequence
        FROM artifacts WHERE hash = ?
      `).get(finalArtifactHash) as {
        byte_length: number;
        media_type: string;
        storage_path: string;
        created_sequence: number;
      } | undefined;
      if (!artifact) throw new Error(`Inference reasoning artifact ${finalArtifactHash} is missing.`);
      const projected = await this.readProjectedTextRef({
        kind: 'artifact',
        hash: finalArtifactHash,
        byteLength: artifact.byte_length,
        mediaType: artifact.media_type,
        storagePath: artifact.storage_path,
      });
      return {
        ...projected,
        state: 'final' as const,
        revision: finalArtifactHash,
        basisSequence: artifact.created_sequence,
      };
    }
    const checkpoints = this.storage.database.prepare(`
      SELECT sequence, payload_json
      FROM events
      WHERE scope_id = ? AND type = 'assistant.checkpoint'
        AND json_extract(payload_json, '$.inferenceId') = ?
      ORDER BY sequence
    `).all(scopeId, inferenceId) as Array<{ sequence: number; payload_json: string }>;
    const deltas: string[] = [];
    for (const checkpoint of checkpoints) {
      const payload = JSON.parse(checkpoint.payload_json) as Record<string, unknown>;
      const delta = typeof payload.reasoningDelta === 'string'
        ? payload.reasoningDelta
        : await this.readWorkUnitEventText(payload.reasoning);
      if (delta) deltas.push(delta);
    }
    const text = deltas.join('');
    return {
      text,
      content: undefined,
      state: inferenceState === 'running' ? 'streaming' as const : 'partial' as const,
      revision: `checkpoint:${checkpoints.at(-1)?.sequence ?? 0}`,
      basisSequence: checkpoints.at(-1)?.sequence ?? 0,
    };
  }

  private async readInferenceContentOrder(
    inspectableArtifactHash: string | null,
    present: Record<'reasoning' | 'commentary' | 'actions', boolean>,
  ): Promise<NonNullable<AgentInferenceTrace['contentOrder']>> {
    const order: NonNullable<AgentInferenceTrace['contentOrder']> = [];
    const add = (kind: NonNullable<AgentInferenceTrace['contentOrder']>[number]) => {
      if (present[kind] && !order.includes(kind)) order.push(kind);
    };
    if (inspectableArtifactHash) {
      try {
        const value = JSON.parse(await this.readArtifactTextByHash(inspectableArtifactHash)) as {
          content?: unknown;
        };
        if (Array.isArray(value.content)) {
          for (const entry of value.content) {
            if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
            const type = (entry as { type?: unknown }).type;
            if (type === 'thinking') add('reasoning');
            else if (type === 'text') add('commentary');
            else if (type === 'toolCall') add('actions');
          }
        }
      } catch {
        // A running or older inference can lack inspectable provider structure.
      }
    }
    // Preserve every semantic surface even if a partial provider record omitted its block.
    add('reasoning');
    add('commentary');
    add('actions');
    return order;
  }

  private async readInferenceCommentary(
    scopeId: string,
    inferenceId: string,
    finalArtifactHash: string | null,
    phase: 'commentary' | 'final_answer' | null,
    inferenceState: 'running' | 'completed' | 'failed' | 'interrupted',
  ) {
    if (finalArtifactHash && phase === 'commentary') {
      const artifact = this.storage.database.prepare(`
        SELECT byte_length, media_type, storage_path, created_sequence
        FROM artifacts WHERE hash = ?
      `).get(finalArtifactHash) as {
        byte_length: number;
        media_type: string;
        storage_path: string;
        created_sequence: number;
      } | undefined;
      if (!artifact) throw new Error(`Inference commentary artifact ${finalArtifactHash} is missing.`);
      const projected = await this.readProjectedTextRef({
        kind: 'artifact',
        hash: finalArtifactHash,
        byteLength: artifact.byte_length,
        mediaType: artifact.media_type,
        storagePath: artifact.storage_path,
      });
      return {
        ...projected,
        state: 'final' as const,
        revision: finalArtifactHash,
        basisSequence: artifact.created_sequence,
      };
    }
    if (phase === 'final_answer') {
      return {
        text: '',
        content: undefined,
        state: 'final' as const,
        revision: 'final-answer',
        basisSequence: 0,
      };
    }
    const checkpoints = this.storage.database.prepare(`
      SELECT sequence, payload_json
      FROM events
      WHERE scope_id = ? AND type = 'assistant.checkpoint'
        AND json_extract(payload_json, '$.inferenceId') = ?
      ORDER BY sequence
    `).all(scopeId, inferenceId) as Array<{ sequence: number; payload_json: string }>;
    const deltas: string[] = [];
    for (const checkpoint of checkpoints) {
      const payload = JSON.parse(checkpoint.payload_json) as Record<string, unknown>;
      if (payload.textPhase !== 'commentary') continue;
      const delta = typeof payload.textDelta === 'string'
        ? payload.textDelta
        : await this.readWorkUnitEventText(payload.text);
      if (delta) deltas.push(delta);
    }
    const text = deltas.join('');
    return {
      text,
      content: undefined,
      state: inferenceState === 'running' ? 'streaming' as const : 'partial' as const,
      revision: `checkpoint:${checkpoints.at(-1)?.sequence ?? 0}`,
      basisSequence: checkpoints.at(-1)?.sequence ?? 0,
    };
  }

  protected contextIdentity(conversationId: string) {
    const row = this.storage.database.prepare(`
      SELECT c.project_id, c.cwd FROM conversations c WHERE c.conversation_id = ?
    `).get(conversationId) as { project_id: string; cwd: string } | undefined;
    if (!row) throw new Error(`Conversation ${conversationId} has no context identity.`);
    return { projectId: row.project_id, cwd: row.cwd };
  }

  protected activeScopeIdentity(conversationId: string) {
    const row = this.storage.database.prepare(`
      SELECT c.project_id, c.cwd, c.reasoning, t.turn_id,
             t.root_scope_id, s.scope_id, s.parent_scope_id, s.kind,
             s.objective_json
      FROM conversations c
      JOIN turns t ON t.conversation_id = c.conversation_id
      JOIN execution_scopes s ON s.turn_id = t.turn_id
      WHERE c.conversation_id = ?
      ORDER BY (t.state = 'running') DESC, t.accepted_sequence DESC,
               (s.state = 'running') DESC,
               (s.kind = 'work_unit' AND s.state = 'running') DESC,
               (s.kind = 'turn') DESC, s.created_sequence DESC
      LIMIT 1
    `).get(conversationId) as {
      project_id: string;
      cwd: string;
      reasoning: string;
      turn_id: string;
      root_scope_id: string;
      scope_id: string;
      parent_scope_id: string | null;
      kind: 'turn' | 'work_unit';
      objective_json: string;
    } | undefined;
    if (!row) throw new Error(`Conversation ${conversationId} has no active context boundary.`);
    return {
      projectId: row.project_id,
      cwd: row.cwd,
      reasoning: row.reasoning,
      turnId: row.turn_id,
      rootScopeId: row.root_scope_id,
      scopeId: row.scope_id,
      parentScopeId: row.parent_scope_id,
      kind: row.kind,
      objective: JSON.parse(row.objective_json) as CanonicalJsonValue,
    };
  }

  private async prepareWorkUnitResources(
    handle: DurableTurnHandle,
    resources: readonly WorkUnitResourceRef[],
    inheritedHashes: ReadonlySet<string>,
  ): Promise<PreparedWorkUnitResource[]> {
    const identity = this.contextIdentity(handle.conversationId);
    const seen = new Set(inheritedHashes);
    const prepared: PreparedWorkUnitResource[] = [];
    for (const resource of resources) {
      let content: string;
      let source: 'file' | 'history';
      if (resource.ref.startsWith('history://')) {
        content = await this.resolveOpenableContent(handle.conversationId, resource.ref);
        source = 'history';
      } else {
        const path = isAbsolute(resource.ref) ? resource.ref : resolve(identity.cwd, resource.ref);
        const metadata = await stat(path);
        if (!metadata.isFile()) {
          throw new TypeError(
            `Work unit resource ${resource.ref} must be a UTF-8 text file; directories are not supported.`,
          );
        }
        const bytes = await readFile(path);
        try {
          content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        } catch {
          throw new TypeError(`Work unit resource ${resource.ref} is not UTF-8 text.`);
        }
        source = 'file';
      }
      const artifact = await this.artifacts.put(Buffer.from(content, 'utf8'), 'text/plain; charset=utf-8');
      const inclusion = seen.has(artifact.hash) ? 'inherited' : 'materialized';
      seen.add(artifact.hash);
      prepared.push({
        artifact,
        content,
        view: {
          ...resource,
          inclusion,
          snapshot: {
            ref: `history://artifact/${artifact.hash}`,
            hash: artifact.hash,
            byteLength: artifact.byteLength,
            mediaType: artifact.mediaType,
            source,
          },
        },
      });
    }
    return prepared;
  }

  private parentMaterializedResourceHashes(turnId: string) {
    const rows = this.storage.database.prepare(`
      SELECT payload_json FROM events
      WHERE turn_id = ? AND type = 'work_unit.returned'
      ORDER BY sequence
    `).all(turnId) as Array<{ payload_json: string }>;
    const hashes = new Set<string>();
    for (const row of rows) {
      const payload = JSON.parse(row.payload_json) as { resources?: unknown };
      if (!Array.isArray(payload.resources)) continue;
      for (const value of payload.resources) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
        const snapshot = (value as { snapshot?: unknown }).snapshot;
        if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) continue;
        const hash = (snapshot as { hash?: unknown }).hash;
        if (typeof hash === 'string' && /^[0-9a-f]{64}$/u.test(hash)) hashes.add(hash);
      }
    }
    return hashes;
  }
}

function artifactHash(ref: DurableContentRef) {
  return ref.kind === 'artifact' ? ref.hash : null;
}

function parseWorkUnitObjective(value: string) {
  const parsed = JSON.parse(value) as Record<string, unknown>;
  return {
    objective: typeof parsed.objective === 'string' ? parsed.objective : 'Focused work unit',
    doneWhen: Array.isArray(parsed.doneWhen)
      ? parsed.doneWhen.filter((entry): entry is string => typeof entry === 'string')
      : [],
    resources: parseWorkUnitResourceReferences(parsed.resources),
  };
}

function parseWorkUnitResourceReferences(value: unknown): AgentWorkUnitResourceReference[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [];
    const resource = entry as Record<string, unknown>;
    if (
      typeof resource.ref !== 'string' ||
      (resource.role !== 'authority' && resource.role !== 'deliverable' && resource.role !== 'evidence')
    ) return [];
    return [{
      ref: resource.ref,
      role: resource.role,
      ...(typeof resource.description === 'string' ? { description: resource.description } : {}),
    }];
  });
}

function uniqueWorkUnitReferences(values: AgentWorkUnitResourceReference[]) {
  const seen = new Set<string>();
  return values.filter((resource) => {
    const key = `${resource.role}\0${resource.ref}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function workUnitTranscriptStatus(state: string, returnedStatus: unknown): AgentWorkUnitStatus {
  if (state === 'running') return 'running';
  if (state === 'abandoned' || state === 'failed' || state === 'interrupted') return 'abandoned';
  if (returnedStatus === 'partial' || returnedStatus === 'blocked') return returnedStatus;
  return 'completed';
}

function operationTranscriptStatus(state: string): AgentToolCallSummary['status'] {
  if (state === 'running') return 'running';
  if (state === 'failed') return 'failed';
  if (state === 'interrupted' || state === 'abandoned') return 'interrupted';
  return 'completed';
}

function toolPresentation(
  name: string,
  args: unknown,
): AgentToolCallSummary['presentation'] {
  const normalized = name.toLowerCase().replace(/[.-]/gu, '_');
  const path = toolArgument(args, 'path', 'filePath', 'file_path');
  const command = toolArgument(args, 'command', 'cmd');
  const query = toolArgument(args, 'query', 'pattern');
  const ref = toolArgument(args, 'ref');

  if (normalized === 'bash' || normalized.endsWith('_bash')) {
    return { category: 'command', label: 'Shell command', subject: command };
  }
  if (normalized === 'read' || normalized.endsWith('_read')) {
    if (normalized.includes('thread')) {
      return { category: 'context', label: 'Read Thread', subject: null };
    }
    if (normalized.includes('history')) {
      return { category: 'context', label: 'Read History', subject: ref };
    }
    return {
      category: 'read',
      label: path ? `Read ${toolSubjectName(path)}` : 'Read file',
      subject: path,
    };
  }
  if (normalized.includes('search')) {
    return {
      category: 'search',
      label: normalized.includes('history') ? 'Searched History' : 'Searched workspace',
      subject: query,
    };
  }
  if (normalized === 'edit' || normalized.endsWith('_edit') || normalized === 'write' ||
      normalized.endsWith('_write')) {
    if (normalized.includes('thread')) {
      return { category: 'context', label: 'Updated Thread', subject: null };
    }
    const verb = normalized === 'write' || normalized.endsWith('_write') ? 'Wrote' : 'Edited';
    return {
      category: 'edit',
      label: path ? `${verb} ${toolSubjectName(path)}` : `${verb} file`,
      subject: path,
    };
  }
  if (normalized === 'thread_patch' || normalized === 'thread_replace') {
    return { category: 'context', label: 'Updated Thread', subject: null };
  }
  if (normalized.startsWith('thread_')) {
    return { category: 'context', label: humanizeToolName(name), subject: null };
  }
  return { category: 'tool', label: humanizeToolName(name), subject: null };
}

function parseOperationArguments(value: string): unknown {
  if (!value) return null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function toolArgument(value: unknown, ...keys: string[]) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  for (const key of keys) {
    const candidate = record[key];
    if (typeof candidate === 'string' && candidate.trim()) {
      return truncateWorkUnitPreview(candidate.trim().replace(/\s+/gu, ' '), 180);
    }
  }
  return null;
}

function toolSubjectName(value: string) {
  const segments = value.replace(/\\/gu, '/').split('/').filter(Boolean);
  return segments.at(-1) ?? value;
}

function humanizeToolName(name: string) {
  return name
    .replace(/[._-]+/gu, ' ')
    .replace(/\b\w/gu, (letter) => letter.toUpperCase());
}

function operationGroupStatus(
  statuses: AgentToolCallSummary['status'][],
): NonNullable<AgentInferenceTrace['actionGroup']>['status'] {
  if (statuses.some((status) => status === 'running')) return 'running';
  if (statuses.some((status) => status === 'failed')) return 'failed';
  if (statuses.some((status) => status === 'interrupted')) return 'interrupted';
  return 'completed';
}

function executionScopeTranscriptStatus(
  state: string,
  returnedStatus: unknown,
): AgentExecutionScopeResource['state'] {
  if (state === 'running') return 'running';
  if (state === 'failed') return 'failed';
  if (state === 'interrupted') return 'interrupted';
  if (state === 'abandoned') return 'abandoned';
  if (returnedStatus === 'partial' || returnedStatus === 'blocked') return returnedStatus;
  return 'completed';
}

function selectExecutionScopeWindow<T extends { inference_id: string }>(
  rows: T[],
  window: AgentExecutionScopeRequest['window'],
) {
  const max = 64;
  let startIndex = 0;
  let endIndexExclusive = rows.length;
  if (!window || window.kind === 'tail') {
    const count = window?.count ?? 48;
    startIndex = Math.max(0, rows.length - count);
  } else if (window.kind === 'around') {
    const anchor = rows.findIndex((row) => row.inference_id === window.inferenceId);
    if (anchor < 0) throw new Error('Execution-scope inference anchor was not found.');
    startIndex = Math.max(0, anchor - window.before);
    endIndexExclusive = Math.min(rows.length, anchor + window.after + 1);
  } else {
    startIndex = rows.findIndex((row) => row.inference_id === window.startInferenceId);
    const endIndex = rows.findIndex((row) => row.inference_id === window.endInferenceId);
    if (startIndex < 0 || endIndex < startIndex) {
      throw new Error('Execution-scope inference range is invalid.');
    }
    endIndexExclusive = endIndex + 1;
  }
  if (endIndexExclusive - startIndex > max) {
    throw new Error(`Execution-scope window exceeds the ${max} inference limit.`);
  }
  return {
    rows: rows.slice(startIndex, endIndexExclusive),
    startIndex,
    endIndexExclusive,
  };
}

function workUnitBundleSections(bundle: string) {
  return {
    result: markdownSection(bundle, 'Result'),
    threadUpdate: markdownSection(bundle, 'Proposed Thread update'),
  };
}

function markdownSection(markdown: string, heading: string) {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const match = new RegExp(`(?:^|\\n)## ${escaped}\\s*\\n([\\s\\S]*?)(?=\\n## |$)`, 'u').exec(markdown);
  return match?.[1]?.trim() || null;
}

function truncateWorkUnitPreview(value: string, maxCodePoints: number) {
  const codePoints = [...value];
  return codePoints.length <= maxCodePoints
    ? value
    : `${codePoints.slice(0, Math.max(0, maxCodePoints - 1)).join('')}…`;
}

function modelPromptWorkUnitResource(resource: PreparedWorkUnitResource): MaterializedPromptResource {
  return { ...resource.view, content: resource.content };
}

function normalizeWorkUnitDoneWhen(values: readonly string[]) {
  if (values.length > 16) throw new TypeError('A work unit accepts at most sixteen done-when conditions.');
  const normalized = values.map((value) =>
    normalizeWorkUnitResourceText(value, 'done-when condition', 4 * 1024));
  return [...new Set(normalized)];
}

function normalizeWorkUnitResources(resources: readonly WorkUnitResourceRef[]) {
  if (resources.length > 16) throw new TypeError('A work unit accepts at most sixteen resource references.');
  const normalized: WorkUnitResourceRef[] = [];
  const seen = new Set<string>();
  for (const resource of resources) {
    const ref = normalizeWorkUnitResourceRef(resource.ref);
    if (resource.role !== 'authority' && resource.role !== 'deliverable' && resource.role !== 'evidence') {
      throw new TypeError('A work unit resource role must be authority, deliverable, or evidence.');
    }
    const description = resource.description === undefined
      ? undefined
      : normalizeWorkUnitResourceText(resource.description, 'resource description', 2 * 1024);
    const identity = `${resource.role}\0${ref}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    normalized.push({ ref, role: resource.role, ...(description ? { description } : {}) });
  }
  if (Buffer.byteLength(canonicalJson(normalized), 'utf8') > 16 * 1024) {
    throw new TypeError('Work unit resource references must not exceed 16 KiB in total.');
  }
  return normalized;
}

function normalizeWorkUnitReturnInput(input: WorkUnitReturnInput): {
  status: WorkUnitReturnStatus;
  result: string;
  threadUpdate?: string;
  resources: WorkUnitResourceRef[];
} {
  if (input.status !== 'completed' && input.status !== 'partial' && input.status !== 'blocked') {
    throw new TypeError('A work unit status must be completed, partial, or blocked.');
  }
  if (typeof input.result !== 'string') throw new TypeError('A work unit result must be text.');
  const result = input.result.trim();
  if (!result) throw new TypeError('A work unit result is required.');
  if (input.threadUpdate !== undefined && typeof input.threadUpdate !== 'string') {
    throw new TypeError('A proposed Thread update must be text.');
  }
  const threadUpdate = input.threadUpdate?.trim() || undefined;
  const resources = normalizeWorkUnitResources(input.resources ?? []);
  return { status: input.status, result, ...(threadUpdate ? { threadUpdate } : {}), resources };
}

function normalizeWorkUnitResourceRef(value: unknown) {
  if (typeof value !== 'string') throw new TypeError('A work unit resource reference must be text.');
  const normalized = value.trim();
  if (!normalized) throw new TypeError('A work unit resource reference is required.');
  if (Buffer.byteLength(normalized, 'utf8') > 4 * 1024) {
    throw new TypeError('A work unit resource reference is too large.');
  }
  return normalized;
}

function normalizeWorkUnitResourceText(value: unknown, label: string, maxBytes: number) {
  if (typeof value !== 'string') throw new TypeError(`A work unit ${label} must be text.`);
  const normalized = value.trim().replace(/\s+/gu, ' ');
  if (!normalized) throw new TypeError(`A work unit ${label} is required.`);
  if (Buffer.byteLength(normalized, 'utf8') > maxBytes) {
    throw new TypeError(`A work unit ${label} is too large.`);
  }
  return normalized;
}

function renderWorkUnitReturnBundle(input: {
  status: WorkUnitReturnStatus;
  result: string;
  threadUpdate?: string;
  resources: readonly MaterializedPromptResource[];
}) {
  const sections = [
    '# Completed work unit', '', '## Status', '', input.status, '', '## Result', '', input.result,
  ];
  if (input.threadUpdate) {
    sections.push(
      '', '## Proposed Thread update', '',
      'The parent must deliberately merge this proposal; it has not been applied automatically.',
      '', input.threadUpdate,
    );
  }
  const resourceSection = renderMaterializedResourceSection('Materialized resources', input.resources);
  if (resourceSection) sections.push('', resourceSection);
  return sections.join('\n').trim();
}
