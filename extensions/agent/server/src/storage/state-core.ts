import { createHash, randomUUID } from 'node:crypto';

import { canonicalProviderJson } from '../logical-context.ts';
import type {
  DurableContentRef,
  DurableResourceProjection,
  PreparedReference,
} from '../domain/state.ts';
import {
  MAX_VISIBLE_TEXT_BYTES,
  type AgentTextContentReference,
} from '../../../shared/transcript.ts';
import { canonicalJson, type CanonicalJsonValue } from './canonical-json.ts';
import type { AgentDatabase, AgentDatabaseDiagnostics } from './database.ts';
import { AgentArtifactStore, type StagedArtifact } from './artifact-store.ts';
import {
  artifactRef,
  normalizeJson,
  parseReference,
  safeInteger,
  safeNonnegativeInteger,
  truncateUtf8Text,
} from './state-codec.ts';

export const EVENT_PAYLOAD_LIMIT_BYTES = 32 * 1024;
export const INLINE_CONTENT_LIMIT_BYTES = 16 * 1024;

export type AgentStateIdKind =
  | 'project'
  | 'conversation'
  | 'turn'
  | 'scope'
  | 'event'
  | 'operation'
  | 'item'
  | 'message'
  | 'inference'
  | 'frame'
  | 'provider-item';

export type AgentStateCoreOptions = {
  now?: () => number;
  idFactory?: (kind: AgentStateIdKind) => string;
};

export type InsertEventInput = {
  eventId: string;
  projectId: string;
  conversationId: string;
  turnId?: string;
  scopeId?: string;
  type: string;
  actor?: string;
  visibility?: string;
  causalEventId?: string;
  operationId?: string;
  payload: CanonicalJsonValue;
  artifactHash?: string | null;
  createdAt: number;
};

/**
 * Shared persistence mechanics for every Agent state feature. This is the only
 * owner of the database connection, artifact store, writer fence, clock, and
 * durable event insertion primitive.
 */
export class AgentStateCore {
  readonly databasePath: string;
  protected readonly storage: AgentDatabase;
  protected readonly now: () => number;
  protected readonly artifacts: AgentArtifactStore;
  protected orphanArtifactPaths: string[] = [];
  protected writerTail: Promise<void> = Promise.resolve();
  protected closePromise: Promise<void> | null = null;
  private readonly idFactory: (kind: AgentStateIdKind) => string;

  protected constructor(storage: AgentDatabase, options: AgentStateCoreOptions) {
    this.storage = storage;
    this.databasePath = storage.paths.database;
    this.now = options.now ?? Date.now;
    this.idFactory = options.idFactory ?? (() => randomUUID());
    this.artifacts = new AgentArtifactStore(storage.paths);
  }

  diagnostics(): AgentDatabaseDiagnostics {
    this.assertOpen();
    return this.storage.diagnostics();
  }

  artifactDiagnostics() {
    this.assertOpen();
    return { orphanStoragePaths: [...this.orphanArtifactPaths] };
  }

  close() {
    if (!this.closePromise) this.closePromise = this.drainAndClose();
    return this.closePromise;
  }

  protected async drainAndClose() {
    await this.writerTail;
    this.storage.close();
  }

  protected async prepareText(text: string, forceArtifact = false): Promise<PreparedReference> {
    const bytes = Buffer.from(text, 'utf8');
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const inlineRef: DurableContentRef = { kind: 'inline', text, byteLength: bytes.byteLength, sha256 };
    if (
      !forceArtifact &&
      bytes.byteLength <= INLINE_CONTENT_LIMIT_BYTES &&
      Buffer.byteLength(canonicalJson(inlineRef), 'utf8') <= EVENT_PAYLOAD_LIMIT_BYTES - 8 * 1024
    ) {
      return { ref: inlineRef, artifact: null, sha256, text };
    }
    const artifact = await this.artifacts.put(bytes, 'text/plain; charset=utf-8');
    return { ref: artifactRef(artifact), artifact, sha256, text };
  }

  protected async prepareJson(value: unknown, forceArtifact = false): Promise<PreparedReference> {
    const normalized = normalizeJson(value);
    const json = canonicalJson(normalized);
    const bytes = Buffer.from(json, 'utf8');
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const inlineRef: DurableContentRef = { kind: 'inline', text: json, byteLength: bytes.byteLength, sha256 };
    if (
      !forceArtifact &&
      bytes.byteLength <= INLINE_CONTENT_LIMIT_BYTES &&
      Buffer.byteLength(canonicalJson(inlineRef), 'utf8') <= EVENT_PAYLOAD_LIMIT_BYTES - 8 * 1024
    ) {
      return { ref: inlineRef, artifact: null, sha256, text: json };
    }
    const artifact = await this.artifacts.put(bytes, 'application/json');
    return { ref: artifactRef(artifact), artifact, sha256, text: json };
  }

  protected async prepareProviderJson(value: unknown): Promise<PreparedReference> {
    const json = canonicalProviderJson(value);
    const bytes = Buffer.from(json, 'utf8');
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const artifact = await this.artifacts.put(bytes, 'application/json');
    return { ref: artifactRef(artifact), artifact, sha256, text: json };
  }

  protected insertArtifact(
    artifact: StagedArtifact | null,
    sequence: number,
    sensitivity: 'content' | 'inspectable' | 'private' = 'content',
  ) {
    if (!artifact) return;
    this.storage.database.prepare(`
      INSERT OR IGNORE INTO artifacts (
        hash, byte_length, media_type, created_sequence, storage_path, sensitivity
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      artifact.hash,
      artifact.byteLength,
      artifact.mediaType,
      sequence,
      artifact.storagePath,
      sensitivity,
    );
    if (sensitivity === 'private') {
      this.storage.database.prepare(`
        UPDATE artifacts SET sensitivity = 'private' WHERE hash = ?
      `).run(artifact.hash);
    }
    const row = this.storage.database.prepare(`
      SELECT byte_length, media_type, storage_path FROM artifacts WHERE hash = ?
    `).get(artifact.hash) as {
      byte_length: number;
      media_type: string;
      storage_path: string;
    };
    if (row.byte_length !== artifact.byteLength || row.storage_path !== artifact.storagePath) {
      throw new Error(`Artifact ${artifact.hash} conflicts with its durable metadata.`);
    }
    const linked = this.storage.database.prepare(`
      SELECT 1
      FROM events source
      WHERE source.sequence = ?
        AND (
          source.artifact_hash = ?
          OR EXISTS (
            SELECT 1 FROM json_tree(source.payload_json) linked
            WHERE linked.value = ? OR linked.value = 'history://artifact/' || ?
          )
        )
      LIMIT 1
    `).get(sequence, artifact.hash, artifact.hash, artifact.hash);
    if (linked) return;
    const source = this.storage.database.prepare(`
      SELECT project_id, conversation_id, turn_id, scope_id, event_id, created_at
      FROM events WHERE sequence = ?
    `).get(sequence) as {
      project_id: string;
      conversation_id: string;
      turn_id: string | null;
      scope_id: string | null;
      event_id: string;
      created_at: number;
    } | undefined;
    if (!source) throw new Error(`Artifact ${artifact.hash} has no durable source event.`);
    this.insertEvent({
      eventId: this.nextId('event'),
      projectId: source.project_id,
      conversationId: source.conversation_id,
      ...(source.turn_id ? { turnId: source.turn_id } : {}),
      ...(source.scope_id ? { scopeId: source.scope_id } : {}),
      type: 'artifact.linked',
      actor: 'harness',
      visibility: 'internal',
      payload: {
        artifactRef: `history://artifact/${artifact.hash}`,
        sourceEventRef: `history://event-id/${source.event_id}`,
      },
      artifactHash: artifact.hash,
      createdAt: source.created_at,
    });
  }

  protected async readTextRef(value: CanonicalJsonValue | undefined) {
    const ref = parseReference(value);
    if (ref.kind === 'inline') return ref.text;
    const bytes = await this.artifacts.read(ref);
    return bytes.toString('utf8');
  }

  protected async readArtifactTextByHash(hash: string) {
    const row = this.storage.database.prepare(`
      SELECT byte_length, storage_path FROM artifacts WHERE hash = ?
    `).get(hash) as { byte_length: number; storage_path: string } | undefined;
    if (!row) throw new Error(`Artifact ${hash} is missing.`);
    const bytes = await this.artifacts.read({
      hash,
      byteLength: safeNonnegativeInteger(row.byte_length, 'artifact byte length'),
      storagePath: row.storage_path,
    });
    return bytes.toString('utf8');
  }

  protected async readProjectedTextRef(
    value: CanonicalJsonValue | undefined,
    maxBytes = MAX_VISIBLE_TEXT_BYTES,
  ) {
    const ref = parseReference(value);
    if (ref.kind === 'inline') {
      const text = truncateUtf8Text(ref.text, maxBytes);
      const returnedBytes = Buffer.byteLength(text, 'utf8');
      return {
        text,
        content: ref.byteLength > returnedBytes
          ? {
              sha256: ref.sha256,
              byteLength: ref.byteLength,
              returnedBytes,
              truncated: true as const,
              artifactHash: null,
              nextRange: null,
            } satisfies AgentTextContentReference
          : undefined,
      };
    }
    const bytes = await this.artifacts.readRange(ref, 0, Math.min(ref.byteLength, maxBytes));
    const text = bytes.toString('utf8').replace(/\uFFFD$/u, '');
    const returnedBytes = Buffer.byteLength(text, 'utf8');
    return {
      text,
      content: ref.byteLength > returnedBytes
        ? {
            sha256: ref.hash,
            byteLength: ref.byteLength,
            returnedBytes,
            truncated: true as const,
            artifactHash: ref.hash,
            nextRange: { kind: 'utf8' as const, offset: returnedBytes, byteLength: maxBytes },
          } satisfies AgentTextContentReference
        : undefined,
    };
  }

  protected async readJsonRef(value: CanonicalJsonValue | undefined) {
    return JSON.parse(await this.readTextRef(value)) as CanonicalJsonValue;
  }

  protected upsertResource(
    key: DurableResourceProjection['key'],
    basisSequence: number,
    value: DurableResourceProjection['value'],
    updatedAt: number,
  ) {
    this.storage.database.prepare(`
      INSERT INTO resources (resource_key, basis_sequence, value_json, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(resource_key) DO UPDATE SET
        basis_sequence = excluded.basis_sequence,
        value_json = excluded.value_json,
        updated_at = excluded.updated_at
    `).run(key, basisSequence, canonicalJson(value), updatedAt);
  }

  protected insertEvent(event: InsertEventInput) {
    const payload = canonicalJson(event.payload);
    if (Buffer.byteLength(payload, 'utf8') > EVENT_PAYLOAD_LIMIT_BYTES) {
      throw new Error(`Agent event payload exceeds ${EVENT_PAYLOAD_LIMIT_BYTES} bytes.`);
    }
    const row = this.storage.database.prepare(`
      INSERT INTO events (
        event_id, project_id, conversation_id, turn_id, scope_id,
        type, actor, visibility, causal_event_id, operation_id,
        payload_json, artifact_hash, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)
      RETURNING sequence
    `).get(
      event.eventId,
      event.projectId,
      event.conversationId,
      event.turnId ?? null,
      event.scopeId ?? null,
      event.type,
      event.actor ?? 'harness',
      event.visibility ?? 'internal',
      event.operationId ?? null,
      payload,
      event.artifactHash ?? null,
      event.createdAt,
    ) as { sequence: number };
    return safeInteger(row.sequence, 'event sequence');
  }

  protected nextId(kind: AgentStateIdKind) {
    const id = this.idFactory(kind);
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(id)) {
      throw new TypeError(`Agent ${kind} ID must be a lowercase UUID v4.`);
    }
    return id;
  }

  protected enqueueWrite<T>(work: () => T | Promise<T>): Promise<T> {
    const result = this.writerTail.then(work, work);
    this.writerTail = result.then(() => undefined, () => undefined);
    return result;
  }

  protected assertOpen() {
    if (this.closePromise) throw new Error('Agent state store is closed.');
  }
}
