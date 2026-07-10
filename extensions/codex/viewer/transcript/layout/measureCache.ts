export const transcriptMeasureCacheVersion = 4;

export type TranscriptMeasureCacheLookup = {
  contentWidth: number;
  threadId: string;
  turnId: string;
  turnRevision: string;
  userActionRowId: string | null;
  userMessageDisclosureRevision: string;
};

export type TranscriptMeasureCacheRow = {
  height: number;
  segmentId: string;
  showAssistantActions: boolean;
  showUserActions: boolean;
  userMessageDisclosure?: {
    collapsible: boolean;
    expanded: boolean;
    maxLines: number;
  };
};

export type TranscriptMeasureCacheValue = {
  collapsedHeight: number;
  rows: TranscriptMeasureCacheRow[];
};

type TranscriptMeasureCacheEntry = TranscriptMeasureCacheValue & {
  key: string;
  lastUsedAt: number;
  threadId: string;
};

export type TranscriptMeasureCacheStats = {
  entries: number;
  hits: number;
  misses: number;
  threads: number;
};

export class TranscriptMeasureCache {
  private readonly entries = new Map<string, TranscriptMeasureCacheEntry>();
  private readonly maxEntries: number;
  private readonly maxThreads: number;
  private readonly threadLastUsedAt = new Map<string, number>();
  private clock = 0;
  private hits = 0;
  private misses = 0;

  constructor({
    maxEntries = 2000,
    maxThreads = 5,
  }: {
    maxEntries?: number;
    maxThreads?: number;
  } = {}) {
    this.maxEntries = maxEntries;
    this.maxThreads = maxThreads;
  }

  clear() {
    this.entries.clear();
    this.threadLastUsedAt.clear();
    this.clock = 0;
    this.hits = 0;
    this.misses = 0;
  }

  read(lookup: TranscriptMeasureCacheLookup): TranscriptMeasureCacheValue | null {
    const key = cacheKey(lookup);
    const entry = this.entries.get(key);
    if (!entry) {
      this.misses += 1;
      return null;
    }

    this.hits += 1;
    this.touch(entry);
    return {
      collapsedHeight: entry.collapsedHeight,
      rows: entry.rows,
    };
  }

  stats(): TranscriptMeasureCacheStats {
    return {
      entries: this.entries.size,
      hits: this.hits,
      misses: this.misses,
      threads: this.threadLastUsedAt.size,
    };
  }

  write(lookup: TranscriptMeasureCacheLookup, value: TranscriptMeasureCacheValue) {
    const key = cacheKey(lookup);
    const entry: TranscriptMeasureCacheEntry = {
      collapsedHeight: value.collapsedHeight,
      key,
      lastUsedAt: 0,
      rows: value.rows.map((row) => ({ ...row })),
      threadId: lookup.threadId,
    };

    this.entries.set(key, entry);
    this.touch(entry);
    this.prune();
  }

  private prune() {
    this.pruneThreads();
    this.pruneEntries();
  }

  private pruneEntries() {
    while (this.entries.size > this.maxEntries) {
      let oldest: TranscriptMeasureCacheEntry | null = null;
      for (const entry of this.entries.values()) {
        if (!oldest || entry.lastUsedAt < oldest.lastUsedAt) {
          oldest = entry;
        }
      }

      if (!oldest) {
        return;
      }

      this.entries.delete(oldest.key);
      this.rebuildThreadUsage(oldest.threadId);
    }
  }

  private pruneThreads() {
    while (this.threadLastUsedAt.size > this.maxThreads) {
      let oldestThreadId: string | null = null;
      let oldestUsedAt = Number.POSITIVE_INFINITY;
      for (const [threadId, usedAt] of this.threadLastUsedAt) {
        if (usedAt < oldestUsedAt) {
          oldestThreadId = threadId;
          oldestUsedAt = usedAt;
        }
      }

      if (!oldestThreadId) {
        return;
      }

      for (const [key, entry] of this.entries) {
        if (entry.threadId === oldestThreadId) {
          this.entries.delete(key);
        }
      }
      this.threadLastUsedAt.delete(oldestThreadId);
    }
  }

  private rebuildThreadUsage(threadId: string) {
    let lastUsedAt = 0;
    for (const entry of this.entries.values()) {
      if (entry.threadId === threadId) {
        lastUsedAt = Math.max(lastUsedAt, entry.lastUsedAt);
      }
    }

    if (lastUsedAt === 0) {
      this.threadLastUsedAt.delete(threadId);
    } else {
      this.threadLastUsedAt.set(threadId, lastUsedAt);
    }
  }

  private touch(entry: TranscriptMeasureCacheEntry) {
    entry.lastUsedAt = this.nextClock();
    this.threadLastUsedAt.set(entry.threadId, entry.lastUsedAt);
  }

  private nextClock() {
    this.clock += 1;
    return this.clock;
  }
}

function cacheKey(lookup: TranscriptMeasureCacheLookup) {
  return [
    transcriptMeasureCacheVersion,
    lookup.threadId,
    lookup.turnId,
    lookup.turnRevision,
    normalizedWidth(lookup.contentWidth),
    lookup.userActionRowId ?? '',
    lookup.userMessageDisclosureRevision,
  ].join('\u001f');
}

function normalizedWidth(width: number) {
  return Math.max(1, Number(width.toFixed(2)));
}
