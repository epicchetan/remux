import type { TranscriptViewportAnchor } from './viewportTypes';

export type TranscriptViewportCacheEntry =
  | { kind: 'bottom' }
  | { kind: 'user-message'; segmentId: string; turnId: string }
  | { kind: 'row-offset'; anchor: TranscriptViewportAnchor };

export type TranscriptInitialViewportIntent = Extract<
  TranscriptViewportCacheEntry,
  { kind: 'bottom' | 'user-message' }
>;

const MAX_CACHED_TRANSCRIPT_VIEWPORTS = 5;
const viewportCache = new Map<string, TranscriptViewportCacheEntry>();

export function cachedTranscriptViewportAnchor(conversationId: string) {
  const anchor = viewportCache.get(conversationId) ?? null;
  if (!anchor) return null;
  viewportCache.delete(conversationId);
  viewportCache.set(conversationId, anchor);
  return anchor;
}

export function cacheTranscriptViewportAnchor(
  conversationId: string,
  anchor: TranscriptViewportCacheEntry,
) {
  viewportCache.delete(conversationId);
  viewportCache.set(conversationId, anchor);
  while (viewportCache.size > MAX_CACHED_TRANSCRIPT_VIEWPORTS) {
    const oldestConversationId = viewportCache.keys().next().value as string | undefined;
    if (!oldestConversationId) return;
    viewportCache.delete(oldestConversationId);
  }
}
