import type { ReasoningLevel } from '../../../shared/protocol.ts';
import {
  createComposerSnapshot,
  type ComposerDocument,
  type ComposerSnapshot,
} from '../composer/model/composerModel.ts';

export type AgentNewChatDraft = {
  cwd: string;
  id: string;
  modelId: string;
  reasoning: ReasoningLevel;
  snapshot: ComposerSnapshot;
  updatedAt: number;
};

const NEW_CHAT_PREFIX = 'remux.agent.new-chat-draft.v1:';
const CONVERSATION_PREFIX = 'remux.agent.conversation-draft.v1:';

export function loadNewChatDraft(id: string): AgentNewChatDraft | null {
  const parsed = readJson(storageKey(NEW_CHAT_PREFIX, id));
  if (!parsed || parsed.id !== id || typeof parsed.cwd !== 'string' ||
      typeof parsed.modelId !== 'string' || !isReasoningLevel(parsed.reasoning)) {
    return null;
  }
  const snapshot = parseSnapshot(parsed.snapshot);
  if (!snapshot) return null;
  return {
    cwd: parsed.cwd,
    id,
    modelId: parsed.modelId,
    reasoning: parsed.reasoning,
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

export function loadConversationDraft(conversationId: string) {
  return parseSnapshot(readJson(storageKey(CONVERSATION_PREFIX, conversationId))?.snapshot);
}

export function persistConversationDraft(conversationId: string, snapshot: ComposerSnapshot) {
  if (snapshot.isEmpty) {
    removeConversationDraft(conversationId);
    return;
  }
  writeJson(storageKey(CONVERSATION_PREFIX, conversationId), {
    snapshot: persistedSnapshot(snapshot),
    updatedAt: Date.now(),
  });
}

export function removeConversationDraft(conversationId: string) {
  remove(storageKey(CONVERSATION_PREFIX, conversationId));
}

function persistedSnapshot(snapshot: ComposerSnapshot) {
  return { document: snapshot.document };
}

function parseSnapshot(value: unknown): ComposerSnapshot | null {
  if (!value || typeof value !== 'object') return null;
  const document = parseDocument((value as { document?: unknown }).document);
  return document ? createComposerSnapshot(document) : null;
}

function parseDocument(value: unknown): ComposerDocument | null {
  if (!value || typeof value !== 'object' || !Array.isArray((value as ComposerDocument).parts)) return null;
  const parts = (value as { parts: unknown[] }).parts;
  if (parts.length > 1) return null;
  const parsed = parts.flatMap((part) => {
    if (!part || typeof part !== 'object') return [];
    const candidate = part as { id?: unknown; text?: unknown; type?: unknown };
    return candidate.type === 'text' && typeof candidate.id === 'string' && typeof candidate.text === 'string'
      ? [{ id: candidate.id, text: candidate.text, type: 'text' as const }]
      : [];
  });
  return parsed.length === parts.length ? { parts: parsed } : null;
}

function isReasoningLevel(value: unknown): value is ReasoningLevel {
  return value === 'off' || value === 'minimal' || value === 'low' ||
    value === 'medium' || value === 'high' || value === 'xhigh' || value === 'max';
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
