export type ComposerDocumentPart =
  | {
      text: string;
      type: 'text';
    }
  | {
      id: string;
      kind: 'directory' | 'file';
      name: string;
      path: string;
      type: 'mention';
    }
  | {
      id: string;
      mimeType: string | null;
      name: string;
      type: 'attachment';
    };

export type ComposerDocument = {
  parts: ComposerDocumentPart[];
};

export type ComposerAttachmentView = Extract<ComposerDocumentPart, { type: 'attachment' }> & {
  dataUrl: string | null;
  digest: string | null;
  error: string | null;
  previewUrl: string | null;
  sizeBytes: number;
};

export type ComposerSnapshot = {
  attachments: ComposerAttachmentView[];
  canSend: boolean;
  canSendText: boolean;
  contentKey: string;
  document: ComposerDocument;
  error: string | null;
  hasSendableContent: boolean;
  isEmpty: boolean;
  isReadingImages: boolean;
  plainText: string;
};

export type ComposerAttachmentResource = {
  dataUrl: string | null;
  digest: string | null;
  error: string | null;
  file: File | null;
  id: string;
  mimeType: string;
  name: string;
  previewUrl: string | null;
  sizeBytes: number;
};

export function normalizeComposerDocument(document: ComposerDocument): ComposerDocument {
  const parts: ComposerDocumentPart[] = [];

  for (const part of document.parts) {
    if (part.type === 'text') {
      if (!part.text) {
        continue;
      }

      const previous = parts.at(-1);
      if (previous?.type === 'text') {
        previous.text += part.text;
      } else {
        parts.push({ text: part.text, type: 'text' });
      }
      continue;
    }

    parts.push(part);
  }

  return { parts };
}

export function composerDocumentPlainText(document: ComposerDocument) {
  return document.parts
    .map((part) => {
      switch (part.type) {
        case 'text':
          return part.text;
        case 'mention':
          return '';
        case 'attachment':
          return '';
      }
    })
    .join('');
}

export function composerDocumentIsEmpty(document: ComposerDocument) {
  return document.parts.every((part) =>
    part.type === 'text' ? part.text.trim().length === 0 : false);
}

export function createComposerSnapshot(
  document: ComposerDocument,
  resources: ReadonlyMap<string, ComposerAttachmentResource> = new Map(),
  plainText = composerDocumentPlainText(document),
  error: string | null = null,
): ComposerSnapshot {
  const normalized = normalizeComposerDocument(document);
  const attachments = normalized.parts
    .filter((part): part is Extract<ComposerDocumentPart, { type: 'attachment' }> => part.type === 'attachment')
    .map((part) => {
      const resource = resources.get(part.id);

      return {
        ...part,
        dataUrl: resource?.dataUrl ?? null,
        digest: resource?.digest ?? null,
        error: resource?.error ?? null,
        previewUrl: resource?.previewUrl ?? null,
        sizeBytes: resource?.sizeBytes ?? 0,
      };
    });
  const isReadingImages = attachments.some((attachment) => !attachment.dataUrl && !attachment.error);
  const hasAttachmentErrors = attachments.some((attachment) => Boolean(attachment.error));
  const hasSendableContent = normalized.parts.some((part) => {
    switch (part.type) {
      case 'text':
        return part.text.trim().length > 0;
      case 'mention':
        return true;
      case 'attachment':
        return true;
    }
  });

  return {
    attachments,
    canSend: hasSendableContent && !isReadingImages && !hasAttachmentErrors,
    canSendText: plainText.trim().length > 0,
    contentKey: composerContentKey(normalized, resources),
    document: normalized,
    error,
    hasSendableContent,
    isEmpty: composerDocumentIsEmpty(normalized),
    isReadingImages,
    plainText,
  };
}

export function createEmptyComposerSnapshot(): ComposerSnapshot {
  return createComposerSnapshot({ parts: [] });
}

export function createComposerAttachmentResource(file: File, metadata?: {
  mimeType?: string;
  name?: string;
  sizeBytes?: number;
}): ComposerAttachmentResource {
  const mimeType = metadata?.mimeType ?? file.type;
  return {
    dataUrl: null,
    digest: null,
    error: null,
    file,
    id: createComposerNodeId(),
    mimeType,
    name: metadata?.name ?? file.name ?? 'Image',
    previewUrl: mimeType.startsWith('image/') ? URL.createObjectURL(file) : null,
    sizeBytes: metadata?.sizeBytes ?? file.size,
  };
}

export function createComposerAttachmentResourceFromDataUrl({
  dataUrl,
  digest,
  mimeType,
  name,
  sizeBytes,
}: {
  dataUrl: string;
  digest: string;
  mimeType: string;
  name: string;
  sizeBytes: number;
}): ComposerAttachmentResource {
  return {
    dataUrl,
    digest,
    error: null,
    file: null,
    id: createComposerNodeId(),
    mimeType,
    name: name || 'Image',
    previewUrl: mimeType.startsWith('image/') ? dataUrl : null,
    sizeBytes,
  };
}

export function revokeComposerAttachmentResource(resource: ComposerAttachmentResource) {
  if (resource.previewUrl?.startsWith('blob:')) {
    URL.revokeObjectURL(resource.previewUrl);
  }
}

export function createComposerNodeId() {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }

  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function composerContentKey(
  document: ComposerDocument,
  resources: ReadonlyMap<string, ComposerAttachmentResource>,
) {
  return document.parts
    .map((part) => {
      switch (part.type) {
        case 'text':
          return `text:${part.text}`;
      case 'mention':
          return `mention:${part.id}:${part.kind}:${part.path}`;
        case 'attachment': {
          const resource = resources.get(part.id);
          return `attachment:${part.id}:${resource?.digest ?? resource?.error ?? 'pending'}`;
        }
      }
    })
    .join('|');
}
