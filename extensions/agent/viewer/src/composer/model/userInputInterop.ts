import type { AgentUserMessagePart } from '../../../../shared/transcript.ts';

import {
  createComposerAttachmentResourceFromDataUrl,
  createComposerNodeId,
  type ComposerAttachmentResource,
  type ComposerAttachmentView,
  type ComposerDocument,
  type ComposerSnapshot,
} from './composerModel.ts';
import { digestDataUrl } from '../attachments/readFileAsDataUrl.ts';

export type ComposerDocumentLoad = {
  document: ComposerDocument;
  resources: ComposerAttachmentResource[];
};

export function composerDocumentFromUserInput(input: AgentUserMessagePart[]): ComposerDocumentLoad {
  const parts: ComposerDocument['parts'] = [];
  const resources: ComposerAttachmentResource[] = [];

  for (const item of input) {
    switch (item.type) {
      case 'text':
        if (item.text) parts.push({ text: item.text, type: 'text' });
        break;
      case 'mention':
        parts.push({
          id: createComposerNodeId(),
          kind: item.kind,
          name: item.name,
          path: item.path,
          type: 'mention',
        });
        break;
      case 'image': {
        if (!item.dataUrl?.startsWith('data:image/')) break;
        const resource = createComposerAttachmentResourceFromDataUrl({
          dataUrl: item.dataUrl,
          digest: digestDataUrl(item.dataUrl),
          mimeType: item.mimeType,
          name: item.name,
          sizeBytes: item.sizeBytes,
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
    }
  }

  return { document: { parts }, resources };
}

export function composerUserInputCanStartEdit(input: AgentUserMessagePart[]) {
  return input.some((item) => item.type !== 'image' || Boolean(item.dataUrl));
}

export function plainTextFromUserInput(input: AgentUserMessagePart[]) {
  return input.map((item) => {
    switch (item.type) {
      case 'text':
        return item.text;
      case 'mention':
        return `@${item.path}`;
      case 'image':
        return '[image]';
    }
  }).join('').trim();
}

export function composerResourcesFromSnapshot(snapshot: ComposerSnapshot): ComposerAttachmentResource[] {
  return snapshot.attachments.flatMap(resourceFromAttachmentView);
}

function resourceFromAttachmentView(attachment: ComposerAttachmentView): ComposerAttachmentResource[] {
  if (!attachment.dataUrl || !attachment.digest) return [];
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
