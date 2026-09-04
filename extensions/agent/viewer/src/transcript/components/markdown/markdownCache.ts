export type MarkdownCacheScope =
  | { kind: 'complete' }
  | { key: string; kind: 'streaming' };

export const completeMarkdownCacheScope: MarkdownCacheScope = { kind: 'complete' };
