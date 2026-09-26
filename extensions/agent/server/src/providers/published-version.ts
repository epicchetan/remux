/**
 * Latest published harness versions, read from the npm registry.
 *
 * Runtime status reads are interactive, so this never blocks on the network:
 * `read` answers from cache and schedules a refresh when the entry is stale.
 * The first read of a package therefore reports `null` until its refresh
 * lands, which the card renders as "no update known" rather than as an error.
 */

const DEFAULT_REGISTRY = 'https://registry.npmjs.org';
const DEFAULT_TTL_MS = 6 * 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 5_000;

export type PublishedVersion = {
  version: string | null;
  checkedAt: number | null;
};

type Entry = PublishedVersion & { inFlight: Promise<PublishedVersion> | null };

export type PublishedVersionCacheOptions = {
  registry?: string;
  ttlMs?: number;
  now?: () => number;
  fetchLatest?: (packageName: string, registry: string) => Promise<string | null>;
};

export class PublishedVersionCache {
  private readonly registry: string;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly fetchLatest: (packageName: string, registry: string) => Promise<string | null>;
  private readonly entries = new Map<string, Entry>();

  constructor(options: PublishedVersionCacheOptions = {}) {
    this.registry = (options.registry ?? DEFAULT_REGISTRY).replace(/\/+$/u, '');
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.now = options.now ?? Date.now;
    this.fetchLatest = options.fetchLatest ?? fetchLatestVersion;
  }

  read(packageName: string): PublishedVersion {
    const entry = this.entries.get(packageName)
      ?? { version: null, checkedAt: null, inFlight: null };
    this.entries.set(packageName, entry);
    if (!entry.inFlight && (entry.checkedAt === null || this.now() - entry.checkedAt >= this.ttlMs)) {
      void this.refresh(packageName);
    }
    return { version: entry.version, checkedAt: entry.checkedAt };
  }

  /**
   * Awaits the in-flight refresh, or starts one. Callers share a single
   * request: a read that schedules a refresh and an update action that awaits
   * one must not fetch twice, and the loser of that race must not roll the
   * cache back to the value it captured before the winner stored its own.
   */
  refresh(packageName: string): Promise<PublishedVersion> {
    const current = this.entries.get(packageName)
      ?? { version: null, checkedAt: null, inFlight: null };
    if (current.inFlight) return current.inFlight;
    const inFlight = this.fetchLatest(packageName, this.registry)
      .then((version) => {
        const next: Entry = { version, checkedAt: this.now(), inFlight: null };
        this.entries.set(packageName, next);
        return { version: next.version, checkedAt: next.checkedAt };
      })
      .catch(() => {
        // A registry that is unreachable is not a runtime fault; keep whatever
        // the cache holds now and let the next read try again.
        const latest = this.entries.get(packageName);
        this.entries.set(packageName, {
          version: latest?.version ?? null,
          checkedAt: latest?.checkedAt ?? null,
          inFlight: null,
        });
        return { version: latest?.version ?? null, checkedAt: latest?.checkedAt ?? null };
      });
    this.entries.set(packageName, { ...current, inFlight });
    return inFlight;
  }
}

async function fetchLatestVersion(packageName: string, registry: string): Promise<string | null> {
  const url = `${registry}/${packageName.replace('/', '%2f')}/latest`;
  const response = await fetch(url, {
    headers: { accept: 'application/vnd.npm.install-v1+json, application/json' },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) return null;
  const body: unknown = await response.json();
  if (!body || typeof body !== 'object') return null;
  const version = (body as { version?: unknown }).version;
  return typeof version === 'string' && version.trim().length > 0 ? version : null;
}
