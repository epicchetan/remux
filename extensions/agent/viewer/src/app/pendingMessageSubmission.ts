import type { AgentComposerMessagePart, ReasoningEffort } from '../../../shared/protocol.ts';
import type { ProviderAccess } from '../../../shared/provider-runtime.ts';
import type { TurnSubmissionInput } from '../composer/actions/turnAction.ts';

const PREFIX = 'remux.agent.new-chat-submission.v1:';

export type PendingMessageSubmission = {
  version: 1;
  source: 'new-chat' | 'existing-conversation';
  draftId: string | null;
  snapshotKey: string;
  create: {
    operationId: string; providerInstanceId: string; cwd: string; nativeModelId: string;
    reasoning: ReasoningEffort; serviceTier: string | null; access: ProviderAccess;
  } | null;
  original: TurnSubmissionInput;
  messageOperationId: string;
  clientMessageId: string;
  conversationId: string | null;
  message: {
    operationId: string; clientMessageId: string; conversationId: string;
    parts: AgentComposerMessagePart[]; nativeModelId: string; reasoning: ReasoningEffort;
    serviceTier: string | null; providerInstanceId: string; access: ProviderAccess;
    configurationRevision: string; delivery: 'auto' | 'queue' | 'steer';
  } | null;
};

export function findPendingMessageSubmission(input: {
  conversationId: string | null;
  draftId: string | null;
}): PendingMessageSubmission | null {
  return listPendingMessageSubmissions().find((record) => submissionMatchesTarget(record, input)) ?? null;
}

export function submissionMatchesTarget(
  record: Pick<PendingMessageSubmission, 'source' | 'conversationId' | 'draftId'>,
  input: { conversationId: string | null; draftId: string | null },
): boolean {
  return record.source === 'existing-conversation'
    ? Boolean(input.conversationId && record.conversationId === input.conversationId)
    : Boolean((input.conversationId && record.conversationId === input.conversationId)
      || (!input.conversationId && record.draftId === input.draftId));
}

export function listPendingMessageSubmissions(): PendingMessageSubmission[] {
  try {
    return Array.from({ length: sessionStorage.length }, (_, index) => sessionStorage.key(index))
      .filter((key): key is string => Boolean(key?.startsWith(PREFIX)))
      .flatMap((key) => {
        const record = parseRecord(sessionStorage.getItem(key));
        return record && key === storageKey(ownerOperationId(record)) ? [record] : [];
      });
  } catch { return []; }
}

export function persistPendingMessageSubmission(value: PendingMessageSubmission) {
  const key = storageKey(ownerOperationId(value));
  const serialized = value.message
    ? { ...value, message: { ...value.message, parts: undefined } }
    : value;
  const encoded = JSON.stringify(serialized);
  if (!parseRecord(encoded)) throw new Error('The pending message is invalid and cannot be saved.');
  sessionStorage.setItem(key, encoded);
  if (sessionStorage.getItem(key) !== encoded) throw new Error('Could not save the pending message for recovery.');
}

export function clearPendingMessageSubmission(operationId: string) {
  sessionStorage.removeItem(storageKey(operationId));
}

function storageKey(operationId: string) {
  return `${PREFIX}${encodeURIComponent(operationId)}`;
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function nonempty(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function nullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function validConfiguration(value: Record<string, unknown>): boolean {
  return nonempty(value.providerInstanceId) && validReasoning(value.reasoning)
    && validAccess(value.access) && nullableString(value.serviceTier);
}

function validDelivery(value: unknown): boolean {
  return value === 'auto' || value === 'queue' || value === 'steer';
}

function parseRecord(raw: string | null): PendingMessageSubmission | null {
  try {
    const value: unknown = JSON.parse(raw ?? 'null');
    if (!object(value) || value.version !== 1 || !nullableString(value.draftId)
      || !nonempty(value.snapshotKey)
      || !object(value.original) || !validConfiguration(value.original)
      || !Array.isArray(value.original.parts) || !validParts(value.original.parts)
      || !nonempty(value.original.modelId) || typeof value.original.displayText !== 'string'
      || !nullableString(value.original.configurationRevision) || !validDelivery(value.original.delivery)
      || !nonempty(value.messageOperationId) || !nonempty(value.clientMessageId)
      || !nullableString(value.conversationId)) return null;
    const source = value.source === undefined ? 'new-chat' : value.source;
    if (source !== 'new-chat' && source !== 'existing-conversation') return null;
    if (source === 'new-chat' && (!object(value.create)
      || !nonempty(value.create.operationId) || !nonempty(value.create.cwd)
      || !nonempty(value.create.nativeModelId) || !validConfiguration(value.create))) return null;
    if (source === 'existing-conversation' && (value.create !== null
      || !nonempty(value.conversationId) || value.draftId !== null || !object(value.message))) return null;
    if (value.message !== null) {
      const message = value.message;
      if (!object(message) || !validConfiguration(message) || !nonempty(message.nativeModelId)
        || !nonempty(message.conversationId) || message.conversationId !== value.conversationId
        || message.operationId !== value.messageOperationId || message.clientMessageId !== value.clientMessageId
        || !nonempty(message.configurationRevision) || !validDelivery(message.delivery)) return null;
      // Attachments have one canonical persisted copy, avoiding a second base64
      // payload when creation advances to first-message dispatch.
      message.parts = value.original.parts;
    }
    value.source = source;
    return value as PendingMessageSubmission;
  } catch { return null; }
}

export function ownerOperationId(value: PendingMessageSubmission) {
  return value.source === 'existing-conversation'
    ? value.messageOperationId
    : value.create!.operationId;
}

function validReasoning(value: unknown): value is ReasoningEffort {
  return value === null || typeof value === 'string';
}

function validAccess(value: unknown): value is ProviderAccess {
  return value === 'read-only' || value === 'workspace-write' || value === 'full-access';
}

function validParts(value: unknown[]): value is AgentComposerMessagePart[] {
  return value.every((part) => {
    if (!part || typeof part !== 'object') return false;
    const candidate = part as Record<string, unknown>;
    if (candidate.type === 'text') return typeof candidate.text === 'string';
    if (candidate.name !== undefined && !nullableString(candidate.name)) return false;
    if (candidate.type === 'mention') return typeof candidate.path === 'string'
      && (candidate.kind === undefined || candidate.kind === 'file' || candidate.kind === 'directory');
    if (candidate.mimeType !== undefined && !nullableString(candidate.mimeType)) return false;
    return candidate.type === 'image' && typeof candidate.dataUrl === 'string'
      && candidate.dataUrl.startsWith('data:image/');
  });
}
