import { createViewerUuid } from '../../identity.ts';

export type ComposerTextPart = {
  id: string;
  text: string;
  type: 'text';
};

export type ComposerDocument = {
  parts: ComposerTextPart[];
};

export type ComposerSnapshot = {
  canSend: boolean;
  contentKey: string;
  document: ComposerDocument;
  error: string | null;
  isEmpty: boolean;
  plainText: string;
};

export function normalizeComposerDocument(document: ComposerDocument): ComposerDocument {
  const first = document.parts[0];
  const text = document.parts.map((part) => part.text).join('');
  if (!first && !text) return { parts: [] };
  return {
    parts: [{ id: first?.id ?? createComposerNodeId(), text, type: 'text' }],
  };
}

export function createComposerSnapshot(
  document: ComposerDocument,
  error: string | null = null,
): ComposerSnapshot {
  const normalized = normalizeComposerDocument(document);
  const plainText = normalized.parts.map((part) => part.text).join('');
  const isEmpty = plainText.trim().length === 0;

  return {
    canSend: !isEmpty && !error,
    contentKey: normalized.parts.map((part) => `${part.id}:${part.text}`).join('|'),
    document: normalized,
    error,
    isEmpty,
    plainText,
  };
}

export function createTextComposerDocument(text: string, id = createComposerNodeId()): ComposerDocument {
  return text ? { parts: [{ id, text, type: 'text' }] } : { parts: [] };
}

export function createEmptyComposerSnapshot(): ComposerSnapshot {
  return createComposerSnapshot({ parts: [] });
}

export function createComposerNodeId() {
  return createViewerUuid();
}
