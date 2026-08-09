export type ComposerMentionTrigger = {
  endOffset: number;
  query: string;
  startOffset: number;
};

export function detectComposerMentionTrigger(text: string, cursorOffset: number): ComposerMentionTrigger | null {
  if (cursorOffset < 0 || cursorOffset > text.length) {
    return null;
  }

  const beforeCursor = text.slice(0, cursorOffset);
  const atIndex = beforeCursor.lastIndexOf('@');

  if (atIndex < 0) {
    return null;
  }

  if (atIndex > 0 && !isMentionBoundary(beforeCursor[atIndex - 1])) {
    return null;
  }

  const query = beforeCursor.slice(atIndex + 1);

  if (/\s/.test(query)) {
    return null;
  }

  return {
    endOffset: cursorOffset,
    query,
    startOffset: atIndex,
  };
}

function isMentionBoundary(character: string) {
  return /\s/.test(character);
}
