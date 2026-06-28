import type { UserInput } from '@remux/codex/protocol/v2';

import {
  createComposerAttachmentResourceFromDataUrl,
  createComposerNodeId,
  type ComposerAttachmentView,
  type ComposerAttachmentResource,
  type ComposerDocument,
  type ComposerSnapshot,
} from './composerModel';
import { digestDataUrl } from '../attachments/readFileAsDataUrl';

export type ComposerDocumentLoad = {
  document: ComposerDocument;
  resources: ComposerAttachmentResource[];
};

export function composerDocumentFromUserInput(input: UserInput[]): ComposerDocumentLoad {
  const parts: ComposerDocument['parts'] = [];
  const resources: ComposerAttachmentResource[] = [];

  for (const item of input) {
    switch (item.type) {
      case 'text':
        parts.push({
          text: item.text,
          type: 'text',
        });
        break;
      case 'mention':
        parts.push({
          id: createComposerNodeId(),
          kind: 'file',
          name: item.name,
          path: item.path,
          type: 'mention',
        });
        break;
      case 'image': {
        if (!composerUserInputItemCanLoad(item)) {
          break;
        }

        const mimeType = mimeTypeFromDataUrl(item.url) ?? 'image/png';
        const resource = createComposerAttachmentResourceFromDataUrl({
          dataUrl: item.url,
          digest: digestDataUrl(item.url),
          mimeType,
          name: nameForMimeType(mimeType),
          sizeBytes: estimateDataUrlBytes(item.url),
        });
        resources.push(resource);
        parts.push({
          id: resource.id,
          mimeType: resource.mimeType,
          name: resource.name,
          type: 'attachment',
        });
        break;
      }
      case 'localImage':
      case 'skill':
        break;
    }
  }

  if (parts.length === 0) {
    const text = plainTextFromUserInput(input);
    if (text) {
      parts.push({
        text,
        type: 'text',
      });
    }
  }

  return {
    document: { parts },
    resources,
  };
}

export function composerUserInputCanLoad(input: UserInput[]) {
  return input.every(composerUserInputItemCanLoad);
}

export function composerUserInputCanStartEdit(input: UserInput[]) {
  return plainTextFromUserInput(input).length > 0 || input.some(composerUserInputItemCanLoad);
}

export function plainTextFromUserInput(input: UserInput[]) {
  return input
    .map((item) => {
      switch (item.type) {
        case 'text':
          return item.text;
        case 'mention':
          return `@${item.path}`;
        case 'skill':
          return item.path ? `/${item.path}` : `/${item.name}`;
        case 'image':
          return '[image]';
        case 'localImage':
          return item.path;
      }
    })
    .join('')
    .trim();
}

export function composerResourcesFromSnapshot(snapshot: ComposerSnapshot): ComposerAttachmentResource[] {
  return snapshot.attachments.flatMap((attachment) => resourceFromAttachmentView(attachment));
}

function composerUserInputItemCanLoad(item: UserInput) {
  switch (item.type) {
    case 'text':
    case 'mention':
      return true;
    case 'image':
      return item.url.startsWith('data:image/');
    case 'localImage':
    case 'skill':
      return false;
  }
}

function resourceFromAttachmentView(attachment: ComposerAttachmentView): ComposerAttachmentResource[] {
  if (!attachment.dataUrl || !attachment.digest) {
    return [];
  }

  return [{
    dataUrl: attachment.dataUrl,
    digest: attachment.digest,
    error: attachment.error,
    file: null,
    id: attachment.id,
    mimeType: attachment.mimeType ?? 'image/png',
    name: attachment.name,
    previewUrl: attachment.previewUrl ?? attachment.dataUrl,
    sizeBytes: attachment.sizeBytes,
  }];
}

function mimeTypeFromDataUrl(dataUrl: string) {
  return /^data:([^;,]+);base64,/i.exec(dataUrl)?.[1] ?? null;
}

function nameForMimeType(mimeType: string) {
  const extension = mimeType.split('/')[1]?.split(/[+;]/)[0] || 'png';
  return `image.${extension}`;
}

function estimateDataUrlBytes(dataUrl: string) {
  const base64 = dataUrl.split(',', 2)[1] ?? '';
  return Math.max(0, Math.floor((base64.length * 3) / 4));
}
