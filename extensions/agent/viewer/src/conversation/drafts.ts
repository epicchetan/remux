import {
  createComposerSnapshot,
  type ComposerAttachmentResource,
  type ComposerDocument,
  type ComposerDocumentPart,
  type ComposerSnapshot,
} from '../composer/model/composerModel.ts';

export type AgentNewChatDraft = {
  cwd: string;
  id: string;
  snapshot: ComposerSnapshot;
  updatedAt: number;
};

const NEW_CHAT_PREFIX = 'remux.agent.new-chat-draft.v1:';
const CONVERSATION_PREFIX = 'remux.agent.conversation-draft.v1:';

export function loadNewChatDraft(id: string): AgentNewChatDraft | null {
  const parsed = readJson(storageKey(NEW_CHAT_PREFIX, id));
  if (!parsed || parsed.id !== id || typeof parsed.cwd !== 'string') {
    return null;
  }
  const snapshot = parseSnapshot(parsed.snapshot);
  if (!snapshot) return null;
  return {
    cwd: parsed.cwd,
    id,
    snapshot,
    updatedAt: typeof parsed.updatedAt === 'number' ? parsed.updatedAt : Date.now(),
  };
}

export function persistNewChatDraft(draft: AgentNewChatDraft) {
  writeJson(storageKey(NEW_CHAT_PREFIX, draft.id), {
    ...draft,
    snapshot: persistedSnapshot(draft.snapshot),
  });
}

export function removeNewChatDraft(id: string) {
  remove(storageKey(NEW_CHAT_PREFIX, id));
}

export type AgentConversationDraft = {
  snapshot: ComposerSnapshot;
};

export function loadConversationDraft(conversationId: string): AgentConversationDraft {
  const parsed = readJson(storageKey(CONVERSATION_PREFIX, conversationId));
  return {
    snapshot: parseSnapshot(parsed?.snapshot) ?? createComposerSnapshot({ parts: [] }, new Map()),
  };
}

export function persistConversationDraft(
  conversationId: string,
  snapshot: ComposerSnapshot,
) {
  writeJson(storageKey(CONVERSATION_PREFIX, conversationId), {
    snapshot: persistedSnapshot(snapshot),
    updatedAt: Date.now(),
  });
}

export function clearConversationDraftContent(conversationId: string) {
  removeConversationDraft(conversationId);
}

export function removeConversationDraft(conversationId: string) {
  remove(storageKey(CONVERSATION_PREFIX, conversationId));
}

function persistedSnapshot(snapshot: ComposerSnapshot) {
  return {
    ...snapshot,
    attachments: snapshot.attachments.map((attachment) => ({
      ...attachment,
      previewUrl: attachment.dataUrl,
    })),
  };
}

function parseSnapshot(value: unknown): ComposerSnapshot | null {
  if (!value || typeof value !== 'object') return null;
  const document = parseDocument((value as { document?: unknown }).document);
  if (!document) return null;
  const attachments = Array.isArray((value as { attachments?: unknown }).attachments)
    ? (value as { attachments: unknown[] }).attachments.flatMap(parseAttachment)
    : [];
  const resources = new Map(attachments.map((resource) => [resource.id, resource]));
  return createComposerSnapshot(document, resources);
}

function parseDocument(value: unknown): ComposerDocument | null {
  if (!value || typeof value !== 'object' || !Array.isArray((value as ComposerDocument).parts)) return null;
  const parts = (value as { parts: unknown[] }).parts;
  const parsed: ComposerDocumentPart[] = [];
  for (const part of parts) {
    if (!part || typeof part !== 'object') return null;
    const candidate = part as Record<string, unknown>;
    if (candidate.type === 'text' && typeof candidate.text === 'string') {
      parsed.push({ text: candidate.text, type: 'text' });
      continue;
    }
    if (
      candidate.type === 'mention' &&
      typeof candidate.id === 'string' &&
      (candidate.kind === 'directory' || candidate.kind === 'file') &&
      typeof candidate.name === 'string' &&
      typeof candidate.path === 'string'
    ) {
      parsed.push({
        id: candidate.id,
        kind: candidate.kind,
        name: candidate.name,
        path: candidate.path,
        type: 'mention',
      });
      continue;
    }
    if (
      candidate.type === 'attachment' &&
      typeof candidate.id === 'string' &&
      (typeof candidate.mimeType === 'string' || candidate.mimeType === null) &&
      typeof candidate.name === 'string'
    ) {
      parsed.push({
        id: candidate.id,
        mimeType: candidate.mimeType,
        name: candidate.name,
        type: 'attachment',
      });
      continue;
    }
    return null;
  }
  return parsed.length === parts.length ? { parts: parsed } : null;
}

function parseAttachment(value: unknown): ComposerAttachmentResource[] {
  if (!value || typeof value !== 'object') return [];
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.id !== 'string' ||
    typeof candidate.name !== 'string' ||
    typeof candidate.mimeType !== 'string' ||
    typeof candidate.dataUrl !== 'string' ||
    !candidate.dataUrl.startsWith('data:image/') ||
    typeof candidate.digest !== 'string' ||
    typeof candidate.sizeBytes !== 'number'
  ) return [];
  return [{
    dataUrl: candidate.dataUrl,
    digest: candidate.digest,
    error: typeof candidate.error === 'string' ? candidate.error : null,
    file: null,
    id: candidate.id,
    mimeType: candidate.mimeType,
    name: candidate.name,
    previewUrl: candidate.dataUrl,
    sizeBytes: candidate.sizeBytes,
  }];
}

function storageKey(prefix: string, id: string) {
  return `${prefix}${encodeURIComponent(id)}`;
}

function readJson(key: string): Record<string, unknown> | null {
  try {
    const raw = globalThis.sessionStorage?.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function writeJson(key: string, value: unknown) {
  try {
    globalThis.sessionStorage?.setItem(key, JSON.stringify(value));
  } catch {
    // Session persistence is best-effort; the mounted viewer retains the draft.
  }
}

function remove(key: string) {
  try {
    globalThis.sessionStorage?.removeItem(key);
  } catch {
    // Storage availability does not affect the in-memory draft.
  }
}
