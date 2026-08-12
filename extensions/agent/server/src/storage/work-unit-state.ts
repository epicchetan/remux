import { readFile, stat } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';

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
import { safeTimestamp } from './state-codec.ts';

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

  commitWorkUnitEntry(handle: DurableTurnHandle, prepared: PreparedWorkUnitEntry) {
    const { child, doneWhen, materializedResources, objective, orientation } = prepared;
    return this.enqueueWrite(() => this.storage.transaction(() => {
      this.assertRunningHandle(handle);
      const parent = this.scopeIdentity(handle.scopeId);
      if (parent.kind !== 'turn' || parent.parent_scope_id !== null) {
        throw new Error('Work units cannot be nested.');
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
          parentScopeId: handle.scopeId,
          resources: materializedResources.map(({ view }) => view),
          scopeId: child.scopeId,
        },
        createdAt: recordedAt,
      });
      this.storage.database.prepare(`
        INSERT INTO execution_scopes (
          scope_id, project_id, conversation_id, turn_id,
          parent_scope_id, kind, objective_json, state, created_sequence,
          terminal_sequence, result_artifact_hash, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 'work_unit', ?, 'running', ?, NULL, NULL, ?, ?)
      `).run(
        child.scopeId,
        child.projectId,
        child.conversationId,
        child.turnId,
        handle.scopeId,
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
      };
    }));
  }

  async enterWorkUnit(handle: DurableTurnHandle, input: WorkUnitEnterInput) {
    return this.commitWorkUnitEntry(handle, await this.prepareWorkUnitEntry(handle, input));
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
      };
    }));
  }

  async returnWorkUnit(handle: DurableTurnHandle, input: WorkUnitReturnInput) {
    return this.commitWorkUnitReturn(handle, await this.prepareWorkUnitReturn(handle, input));
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
