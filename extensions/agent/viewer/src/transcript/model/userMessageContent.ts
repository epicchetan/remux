import type { AgentUserMessageSegment } from '../../../../shared/transcript.ts';

export type UserMessagePlacement = 'topLevel' | 'work';

export type UserMessageRailItem =
  | {
      artifactHash: string;
      id: string;
      mimeType: string;
      name: string;
      sizeBytes: number;
      subtitle: string;
      type: 'image';
    }
  | {
      id: string;
      label: string;
      path: string;
      subtitle: string;
      type: 'reference';
    };

export type UserMessageLayout = {
  bodyMarkdown: string | null;
  placement: UserMessagePlacement;
  railItems: UserMessageRailItem[];
  revision: string;
};

export function buildUserMessageLayout(
  message: Pick<AgentUserMessageSegment, 'id' | 'parts' | 'revision' | 'text' | 'type'>,
  placement: UserMessagePlacement = 'topLevel',
): UserMessageLayout {
  const parts = message.parts ?? [{ text: message.text, type: 'text' as const }];
  const markdown: string[] = [];
  const railItems: UserMessageRailItem[] = [];
  for (const [index, part] of parts.entries()) {
    if (part.type === 'text') {
      if (part.text.trim()) markdown.push(part.text);
      continue;
    }
    if (part.type === 'mention') {
      railItems.push({
        id: `mention:${index}:${part.path}`,
        label: part.name,
        path: part.path,
        subtitle: part.kind === 'directory' ? 'Folder' : 'Reference',
        type: 'reference',
      });
      continue;
    }
    railItems.push({
      artifactHash: part.artifactHash,
      id: `image:${index}:${part.artifactHash}`,
      mimeType: part.mimeType,
      name: part.name,
      sizeBytes: part.sizeBytes,
      subtitle: 'Image',
      type: 'image',
    });
  }
  if (markdown.length === 0 && message.text.trim()) markdown.push(message.text);
  return {
    bodyMarkdown: markdown.length > 0 ? markdown.join('') : null,
    placement,
    railItems,
    revision: `${message.id}:${message.revision}:${parts.map(partRevision).join('|')}`,
  };
}

export function plainTextFromUserMessage(message: Pick<AgentUserMessageSegment, 'parts' | 'text'>) {
  const value = (message.parts ?? [{ text: message.text, type: 'text' as const }]).map((part) => {
    if (part.type === 'text') return part.text;
    if (part.type === 'mention') return `@${part.path}`;
    return '[image]';
  }).join('').trim();
  return value || message.text.trim();
}

function partRevision(part: NonNullable<AgentUserMessageSegment['parts']>[number]) {
  if (part.type === 'text') return `text:${part.text}`;
  if (part.type === 'mention') return `mention:${part.kind}:${part.path}`;
  return `image:${part.artifactHash}`;
}
