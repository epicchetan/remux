import type { ThreadCanvasValue, TurnReadValue } from '../../../shared/protocol.ts';
import type {
  ThreadDocumentView,
  ThreadPatchInput,
  ThreadReplaceInput,
} from '../domain/work.ts';
import type { DurableTurnHandle } from '../domain/state.ts';
import { safeInteger, safeTimestamp } from './state-codec.ts';
import { WorkUnitState } from './work-unit-state.ts';

/** Versioned Thread document and durable turn-inspection behavior. */
export abstract class ThreadState extends WorkUnitState {
  async readThread(conversationId: string): Promise<ThreadDocumentView> {
    this.assertOpen();
    await this.writerTail;
    const row = this.storage.database.prepare(`
      SELECT d.document_id, d.head_version_id, v.content_artifact_hash
      FROM conversations c
      JOIN state_documents d
        ON d.conversation_id = c.conversation_id
       AND d.scope_kind = 'conversation' AND d.key = 'thread.md'
      JOIN document_versions v ON v.version_id = d.head_version_id
      WHERE c.conversation_id = ?
    `).get(conversationId) as {
      document_id: string;
      head_version_id: string;
      content_artifact_hash: string;
    } | undefined;
    if (!row) throw new Error(`Conversation ${conversationId} has no thread.md document.`);
    return {
      documentId: row.document_id,
      versionId: row.head_version_id,
      content: await this.readArtifactTextByHash(row.content_artifact_hash),
      ref: `history://document-version/${encodeURIComponent(row.head_version_id)}`,
    };
  }

  async readThreadHistory(conversationId: string): Promise<ThreadCanvasValue> {
    this.assertOpen();
    await this.writerTail;
    const row = this.storage.database.prepare(`
      SELECT d.document_id,
             current.version_id AS current_version_id,
             current.ordinal AS current_ordinal,
             current.based_on_turn_id AS current_turn_id,
             current.created_at AS current_created_at,
             current.content_artifact_hash AS current_artifact_hash,
             previous.version_id AS previous_version_id,
             previous.ordinal AS previous_ordinal,
             previous.based_on_turn_id AS previous_turn_id,
             previous.created_at AS previous_created_at,
             previous.content_artifact_hash AS previous_artifact_hash
      FROM conversations c
      JOIN state_documents d
        ON d.conversation_id = c.conversation_id
       AND d.scope_kind = 'conversation' AND d.key = 'thread.md'
      JOIN document_versions current ON current.version_id = d.head_version_id
      LEFT JOIN document_versions previous ON previous.version_id = current.parent_version_id
      WHERE c.conversation_id = ?
    `).get(conversationId) as {
      document_id: string;
      current_version_id: string;
      current_ordinal: number;
      current_turn_id: string | null;
      current_created_at: number;
      current_artifact_hash: string;
      previous_version_id: string | null;
      previous_ordinal: number | null;
      previous_turn_id: string | null;
      previous_created_at: number | null;
      previous_artifact_hash: string | null;
    } | undefined;
    if (!row) throw new Error(`Conversation ${conversationId} has no thread.md document.`);
    const currentContent = await this.readArtifactTextByHash(row.current_artifact_hash);
    const previousContent = row.previous_artifact_hash
      ? await this.readArtifactTextByHash(row.previous_artifact_hash)
      : null;
    return {
      conversationId,
      documentId: row.document_id,
      current: {
        versionId: row.current_version_id,
        ordinal: safeInteger(row.current_ordinal, 'thread document ordinal'),
        basedOnTurnId: row.current_turn_id,
        createdAt: safeTimestamp(row.current_created_at),
        content: currentContent,
        byteLength: Buffer.byteLength(currentContent, 'utf8'),
      },
      previous: row.previous_version_id && row.previous_ordinal !== null &&
          row.previous_created_at !== null && previousContent !== null
        ? {
            versionId: row.previous_version_id,
            ordinal: safeInteger(row.previous_ordinal, 'previous thread document ordinal'),
            basedOnTurnId: row.previous_turn_id,
            createdAt: safeTimestamp(row.previous_created_at),
            content: previousContent,
            byteLength: Buffer.byteLength(previousContent, 'utf8'),
          }
        : null,
    };
  }

  async readTurn(conversationId: string, turnId: string): Promise<TurnReadValue> {
    this.assertOpen();
    await this.writerTail;
    const row = this.storage.database.prepare(`
      SELECT t.state, t.terminal_sequence, t.thread_version_before, t.thread_version_after,
             t.created_at, t.updated_at,
             json_extract(e.payload_json, '$.error') AS error,
             json_extract(e.payload_json, '$.errorCode') AS error_code
      FROM turns t
      LEFT JOIN events e ON e.sequence = t.terminal_sequence AND e.type = 'turn.terminal'
      WHERE t.conversation_id = ? AND t.turn_id = ?
    `).get(conversationId, turnId) as {
      state: string;
      terminal_sequence: number | null;
      thread_version_before: string;
      thread_version_after: string | null;
      created_at: number;
      updated_at: number;
      error: string | null;
      error_code: string | null;
    } | undefined;
    if (!row) throw new Error(`Turn ${turnId} does not exist in conversation ${conversationId}.`);
    return {
      conversationId,
      turnId,
      state: durableTurnReadState(row.state),
      terminal: row.terminal_sequence !== null,
      terminalSequence: row.terminal_sequence === null
        ? null
        : safeInteger(row.terminal_sequence, 'turn terminal sequence'),
      error: row.error,
      errorCode: durableTurnErrorCode(row.error_code),
      threadVersionBefore: row.thread_version_before,
      threadVersionAfter: row.thread_version_after,
      createdAt: safeTimestamp(row.created_at),
      updatedAt: safeTimestamp(row.updated_at),
    };
  }

  async patchThread(handle: DurableTurnHandle, input: ThreadPatchInput): Promise<ThreadDocumentView> {
    this.assertOpen();
    if (!input.baseVersionId.trim()) throw new TypeError('baseVersionId is required.');
    if (input.edits.length < 1 || input.edits.length > 32) {
      throw new TypeError('Thread patches require between one and 32 exact edits.');
    }
    if (this.scopeIdentity(handle.scopeId).kind !== 'turn') {
      throw new Error('The Thread is parent-owned; finish the work unit first.');
    }
    await this.writerTail;
    this.assertRunningHandle(handle);
    const row = this.storage.database.prepare(`
      SELECT d.head_version_id, v.content_artifact_hash
      FROM state_documents d
      JOIN document_versions v ON v.version_id = d.head_version_id
      WHERE d.conversation_id = ?
        AND d.scope_kind = 'conversation' AND d.key = 'thread.md'
    `).get(handle.conversationId) as {
      head_version_id: string;
      content_artifact_hash: string;
    } | undefined;
    if (!row) throw new Error('The conversation has no Thread document.');
    if (row.head_version_id !== input.baseVersionId) {
      throw new Error(
        `The Thread changed from ${input.baseVersionId} to ${row.head_version_id}; read it and retry.`,
      );
    }
    const content = applyExactThreadEdits(
      await this.readArtifactTextByHash(row.content_artifact_hash),
      input.edits,
    );
    return this.commitThreadContent(handle, input.baseVersionId, content, 'patch');
  }

  async replaceThread(handle: DurableTurnHandle, input: ThreadReplaceInput): Promise<ThreadDocumentView> {
    this.assertOpen();
    if (!input.baseVersionId.trim()) throw new TypeError('baseVersionId is required.');
    return this.commitThreadContent(handle, input.baseVersionId, input.content, 'replace');
  }

  private async commitThreadContent(
    handle: DurableTurnHandle,
    baseVersionId: string,
    content: string,
    method: 'patch' | 'replace',
  ): Promise<ThreadDocumentView> {
    const bytes = Buffer.from(content, 'utf8');
    if (bytes.byteLength > 96 * 1024) throw new TypeError('The Thread must not exceed 96 KiB.');
    const artifact = await this.artifacts.put(bytes, 'text/markdown; charset=utf-8');
    const versionId = this.nextId('document-version');
    return this.enqueueWrite(() => this.storage.transaction(() => {
      this.assertRunningHandle(handle);
      if (this.scopeIdentity(handle.scopeId).kind !== 'turn') {
        throw new Error('The Thread is parent-owned; finish the work unit first.');
      }
      const document = this.storage.database.prepare(`
        SELECT document_id, head_version_id
        FROM state_documents
        WHERE conversation_id = ?
          AND scope_kind = 'conversation' AND key = 'thread.md'
      `).get(handle.conversationId) as {
        document_id: string;
        head_version_id: string;
      } | undefined;
      if (!document) throw new Error('The conversation has no Thread document.');
      if (document.head_version_id !== baseVersionId) {
        throw new Error(
          `The Thread changed from ${baseVersionId} to ${document.head_version_id}; read it and retry.`,
        );
      }
      const ordinalRow = this.storage.database.prepare(`
        SELECT COALESCE(MAX(ordinal), -1) + 1 AS ordinal
        FROM document_versions WHERE document_id = ?
      `).get(document.document_id) as { ordinal: number };
      const ordinal = safeInteger(ordinalRow.ordinal, 'thread document ordinal');
      const recordedAt = safeTimestamp(this.now());
      const sequence = this.insertEvent({
        ...handle,
        eventId: this.nextId('event'),
        type: 'thread.document.updated',
        actor: 'model',
        visibility: 'internal',
        payload: {
          baseVersionId,
          contentArtifactHash: artifact.hash,
          documentId: document.document_id,
          method,
          ordinal,
          versionId,
        },
        artifactHash: artifact.hash,
        createdAt: recordedAt,
      });
      this.insertArtifact(artifact, sequence, 'content');
      this.storage.database.prepare(`
        INSERT INTO document_versions (
          version_id, document_id, ordinal, parent_version_id,
          content_artifact_hash, based_on_turn_id, created_sequence, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        versionId,
        document.document_id,
        ordinal,
        document.head_version_id,
        artifact.hash,
        handle.turnId,
        sequence,
        recordedAt,
      );
      const updated = this.storage.database.prepare(`
        UPDATE state_documents
        SET head_version_id = ?, updated_sequence = ?, updated_at = ?
        WHERE document_id = ? AND head_version_id = ?
      `).run(versionId, sequence, recordedAt, document.document_id, baseVersionId);
      if (updated.changes !== 1) throw new Error('thread.md compare-and-swap failed.');
      this.indexHistoryText({
        ref: `history://document-version/${encodeURIComponent(versionId)}`,
        projectId: handle.projectId,
        conversationId: handle.conversationId,
        turnId: handle.turnId,
        kind: 'thread-document',
        sequence,
        text: content,
      });
      return {
        documentId: document.document_id,
        versionId,
        content,
        ref: `history://document-version/${encodeURIComponent(versionId)}`,
      };
    }));
  }
}

function applyExactThreadEdits(content: string, edits: ThreadPatchInput['edits']) {
  let next = content;
  for (const [index, edit] of edits.entries()) {
    if (!edit.oldText) throw new TypeError(`Thread patch edit ${index + 1} requires non-empty oldText.`);
    const match = next.indexOf(edit.oldText);
    if (match < 0) throw new Error(`Thread patch edit ${index + 1} did not match the current document.`);
    if (next.indexOf(edit.oldText, match + edit.oldText.length) >= 0) {
      throw new Error(`Thread patch edit ${index + 1} is ambiguous in the current document.`);
    }
    next = `${next.slice(0, match)}${edit.newText}${next.slice(match + edit.oldText.length)}`;
  }
  if (next === content) throw new Error('Thread patch did not change the document.');
  return next;
}

function durableTurnReadState(value: string): TurnReadValue['state'] {
  if (
    value !== 'running' && value !== 'completed' && value !== 'failed' &&
    value !== 'interrupted' && value !== 'interrupted_by_restart'
  ) {
    throw new Error('Durable turn state is invalid.');
  }
  return value;
}

function durableTurnErrorCode(value: string | null): TurnReadValue['errorCode'] {
  if (value === null) return null;
  if (value !== 'provider_error' && value !== 'runtime_error' && value !== 'storage_error') {
    throw new Error('Durable turn error code is invalid.');
  }
  return value;
}
