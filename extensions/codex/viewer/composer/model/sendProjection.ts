import type { CodexComposerMessagePart } from '../../../shared/threadCommands';

import type { ComposerSnapshot } from './composerModel';

export type ComposerSendProjection =
  | {
      displayText: string;
      parts: CodexComposerMessagePart[];
      type: 'ok';
    }
  | {
      message: string;
      type: 'error';
    };

export function buildComposerSendParts(snapshot: ComposerSnapshot): ComposerSendProjection {
  const parts: CodexComposerMessagePart[] = [];
  const displayParts: string[] = [];

  for (const part of trimDocumentTextEdges(snapshot.document.parts)) {
    switch (part.type) {
      case 'text': {
        if (!part.text) {
          continue;
        }

        pushTextPart(parts, part.text);
        displayParts.push(part.text);
        break;
      }
      case 'attachment': {
        const attachment = snapshot.attachments.find((candidate) => candidate.id === part.id);
        if (!attachment) {
          return {
            message: `Image ${part.name} is not ready.`,
            type: 'error',
          };
        }

        if (attachment.error) {
          return {
            message: attachment.error,
            type: 'error',
          };
        }

        if (!attachment.dataUrl) {
          return {
            message: `Image ${attachment.name} is still loading.`,
            type: 'error',
          };
        }

        parts.push({
          dataUrl: attachment.dataUrl,
          mimeType: attachment.mimeType,
          name: attachment.name,
          type: 'image',
        });
        displayParts.push(attachment.name);
        break;
      }
      case 'mention': {
        parts.push({
          name: part.name,
          path: part.path,
          type: 'mention',
        });
        displayParts.push(part.name || part.path);
        break;
      }
    }
  }

  if (parts.length === 0) {
    return {
      message: 'Enter a message or attach an image.',
      type: 'error',
    };
  }

  return {
    displayText: displayParts.join('\n').trim(),
    parts,
    type: 'ok',
  };
}

function pushTextPart(parts: CodexComposerMessagePart[], text: string) {
  const previous = parts.at(-1);

  if (previous?.type === 'text') {
    previous.text += text;
    return;
  }

  parts.push({
    text,
    type: 'text',
  });
}

function trimDocumentTextEdges(parts: ComposerSnapshot['document']['parts']) {
  const next = parts.map((part) => ({ ...part }));
  const firstText = next.find((part) => part.type === 'text');
  const lastText = [...next].reverse().find((part) => part.type === 'text');

  if (firstText?.type === 'text') {
    firstText.text = firstText.text.trimStart();
  }

  if (lastText?.type === 'text') {
    lastText.text = lastText.text.trimEnd();
  }

  return next.filter((part) => part.type !== 'text' || part.text.length > 0);
}
