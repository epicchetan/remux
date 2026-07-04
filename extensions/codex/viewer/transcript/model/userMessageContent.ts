import type { ThreadItem } from '@remux/codex/protocol/v2';

import {
  normalizeUserTextToMarkdown,
  textElementsRevision,
} from './userMessageMarkdown';

export type UserMessagePlacement = 'topLevel' | 'work';

export type UserMessageRailItem =
  | {
      alt: string;
      id: string;
      name: string;
      src: string;
      subtitle: string;
      type: 'image';
    }
  | {
      id: string;
      name: string;
      path: string;
      subtitle: string;
      type: 'localImage';
    }
  | {
      chipType: 'mention' | 'skill';
      id: string;
      label: string;
      path: string;
      subtitle: string;
      type: 'reference';
    };

export type UserMessageLayoutModel = {
  bodyMarkdown: string | null;
  placement: UserMessagePlacement;
  railItems: UserMessageRailItem[];
  showSteeringLabel: boolean;
};

type UserMessageItem = Extract<ThreadItem, { type: 'userMessage' }>;
type UserInput = UserMessageItem['content'][number];
type UserTextPart = Extract<UserInput, { type: 'text' }>;

export type NormalizedUserText = {
  strippedAttachmentPaths: string[];
  strippedWrapper: boolean;
  text: string;
  textElements: UserTextPart['text_elements'];
};

export function buildUserMessageLayout(
  item: UserMessageItem,
  placement: UserMessagePlacement,
): UserMessageLayoutModel {
  const markdownParts: string[] = [];
  const railItems: UserMessageRailItem[] = [];
  const structuredAttachmentPaths = structuredUserAttachmentPaths(item.content);

  for (const [index, part] of item.content.entries()) {
    switch (part.type) {
      case 'text':
        // Mention spans inside the text render as inline chips via
        // normalizeUserTextToMarkdown, so they do not add rail items.
        appendTextMarkdown(markdownParts, part, structuredAttachmentPaths);
        break;
      case 'image':
        railItems.push(imageRailItem(part.url, index));
        break;
      case 'localImage':
        railItems.push({
          id: `local-image:${index}:${part.path}`,
          name: fileNameFromPath(part.path) || 'Image',
          path: part.path,
          subtitle: 'Image',
          type: 'localImage',
        });
        break;
      case 'skill':
      case 'mention':
        railItems.push(referenceRailItem(part, index));
        break;
      default:
        break;
    }
  }

  return {
    bodyMarkdown: markdownParts.length > 0 ? markdownParts.join('\n\n') : null,
    placement,
    railItems,
    showSteeringLabel: placement === 'work',
  };
}

export function userMessageContentRevision(item: UserMessageItem) {
  return `user-message-v2:${item.content.map((part) => `${part.type}:${contentRevision(part)}`).join(',')}`;
}

function appendTextMarkdown(
  markdownParts: string[],
  part: UserTextPart,
  structuredAttachmentPaths: string[],
) {
  const normalized = normalizeUserMessageTextPart(part, {
    hasStructuredAttachments: structuredAttachmentPaths.length > 0,
    structuredAttachmentPaths,
  });

  if (!normalized.text.trim()) {
    return;
  }

  markdownParts.push(normalizeUserTextToMarkdown(normalized.text, normalized.textElements));
}

export function normalizeUserMessageTextPart(
  part: UserTextPart,
  context: {
    hasStructuredAttachments: boolean;
    structuredAttachmentPaths: string[];
  },
): NormalizedUserText {
  const fallback = (): NormalizedUserText => ({
    strippedAttachmentPaths: [],
    strippedWrapper: false,
    text: part.text,
    textElements: part.text_elements,
  });

  if (part.text_elements.length > 0) {
    return fallback();
  }

  const text = part.text;
  if (!text.trimStart().startsWith('# Files mentioned by the user:')) {
    return fallback();
  }

  const requestHeading = /^[ \t]*## My request for Codex:[ \t]*\r?$/gm.exec(text);
  if (!requestHeading) {
    return fallback();
  }

  const wrapperText = text.slice(0, requestHeading.index);
  const wrapperPaths = parsedFilesMentionedPaths(wrapperText);
  const structuredPathSet = new Set(context.structuredAttachmentPaths.map(normalizeAttachmentPathForCompare));
  const pathsMatch =
    wrapperPaths.length > 0
      ? wrapperPaths.every((path) => structuredPathSet.has(normalizeAttachmentPathForCompare(path)))
      : context.hasStructuredAttachments;

  if (!pathsMatch) {
    return fallback();
  }

  return {
    strippedAttachmentPaths: wrapperPaths,
    strippedWrapper: true,
    text: text.slice(requestHeading.index + requestHeading[0].length).replace(/^\r?\n/, ''),
    textElements: [],
  };
}

function structuredUserAttachmentPaths(content: UserMessageItem['content']) {
  return content.flatMap((part) => {
    switch (part.type) {
      case 'image':
        return [part.url];
      case 'localImage':
        return [part.path];
      default:
        return [];
    }
  });
}

function parsedFilesMentionedPaths(wrapperText: string) {
  return wrapperText
    .split(/\r?\n/)
    .flatMap((line) => {
      const match = /^[ \t]*##[ \t]+[^:]+:[ \t]*(.+?)[ \t]*$/.exec(line);
      return match?.[1] ? [match[1]] : [];
    });
}

function normalizeAttachmentPathForCompare(path: string) {
  const trimmed = path.trim();
  if (!trimmed.toLowerCase().startsWith('file://')) {
    return trimmed;
  }

  try {
    return decodeURIComponent(trimmed.replace(/^file:\/\//i, ''));
  } catch {
    return trimmed.replace(/^file:\/\//i, '');
  }
}

function imageRailItem(src: string, index: number): UserMessageRailItem {
  const name = fileNameFromPath(src) || 'Image attachment';
  return {
    alt: 'Image attachment',
    id: `image:${index}:${src}`,
    name,
    src,
    subtitle: 'Image',
    type: 'image',
  };
}

function referenceRailItem(part: Extract<UserInput, { type: 'mention' | 'skill' }>, index: number): UserMessageRailItem {
  return {
    chipType: part.type,
    id: `${part.type}:${index}:${part.path}`,
    label: part.name,
    path: part.path,
    subtitle: part.type === 'skill' ? 'Skill' : referenceSubtitle(part.path),
    type: 'reference',
  };
}

function referenceSubtitle(path: string) {
  return path.endsWith('/') ? 'Folder' : 'Reference';
}

function fileNameFromPath(path: string) {
  const withoutHash = path.split('#')[0] ?? path;
  const withoutQuery = withoutHash.split('?')[0] ?? withoutHash;
  const normalized = withoutQuery.replace(/^file:\/\//i, '');
  try {
    return decodeURIComponent(normalized).split('/').filter(Boolean).at(-1) ?? normalized;
  } catch {
    return normalized.split('/').filter(Boolean).at(-1) ?? normalized;
  }
}

function contentRevision(part: UserInput) {
  switch (part.type) {
    case 'text':
      return `${part.text}:${textElementsRevision(part.text_elements)}`;
    case 'image':
      return part.url;
    case 'localImage':
      return part.path;
    case 'mention':
    case 'skill':
      return `${part.name}:${part.path}`;
    default:
      return '';
  }
}
