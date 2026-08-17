import type { Model } from '@earendil-works/pi-ai';
import type { ModelRuntime } from '@earendil-works/pi-coding-agent';

import {
  canonicalProviderCompactionItem,
  compactionRequestPayload,
  type ContextCompactionUsage,
} from '../../context/compaction.ts';
import type { CanonicalJsonValue } from '../../storage/canonical-json.ts';

const DEFAULT_CODEX_BASE_URL = 'https://chatgpt.com/backend-api';
const JWT_CLAIM_PATH = 'https://api.openai.com/auth';
const MAX_ATTEMPTS = 3;

export type RemoteCompactionResult = {
  providerItem: CanonicalJsonValue;
  usage: ContextCompactionUsage;
  durationMs: number;
};

export interface RemoteCompactionClient {
  compact(input: {
    model: Model<string>;
    payload: unknown;
    signal?: AbortSignal;
  }): Promise<RemoteCompactionResult>;
}

export class OpenAICodexRemoteCompactionClient implements RemoteCompactionClient {
  private readonly modelRuntime: ModelRuntime;
  private readonly fetcher: typeof fetch;

  constructor(
    modelRuntime: ModelRuntime,
    fetcher: typeof fetch = fetch,
  ) {
    this.modelRuntime = modelRuntime;
    this.fetcher = fetcher;
  }

  async compact(input: {
    model: Model<string>;
    payload: unknown;
    signal?: AbortSignal;
  }): Promise<RemoteCompactionResult> {
    const startedAt = performance.now();
    const resolution = await this.modelRuntime.getAuth(input.model, { signal: input.signal });
    const token = resolution?.auth.apiKey;
    if (!token) throw new Error('Remote compaction requires OpenAI Codex authentication.');
    const accountId = extractAccountId(token);
    const headers = buildHeaders(
      input.model.headers,
      resolution.auth.headers,
      token,
      accountId,
    );
    const baseUrl = resolution.auth.baseUrl ?? input.model.baseUrl;
    const body = JSON.stringify(compactionRequestPayload(input.payload));
    let lastError: unknown = null;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      input.signal?.throwIfAborted();
      try {
        const response = await this.fetcher(resolveCodexUrl(baseUrl), {
          method: 'POST',
          headers,
          body,
          signal: input.signal,
        });
        if (!response.ok) {
          const detail = await response.text();
          if (attempt + 1 < MAX_ATTEMPTS && isRetryableStatus(response.status, detail)) {
            await retryDelay(attempt, input.signal);
            continue;
          }
          throw new Error(`Remote compaction failed with HTTP ${response.status}: ${providerError(detail)}`);
        }
        const parsed = await collectRemoteCompaction(response, input.signal);
        return {
          ...parsed,
          durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
        };
      } catch (error) {
        lastError = error;
        if (input.signal?.aborted || attempt + 1 >= MAX_ATTEMPTS || !isRetryableError(error)) throw error;
        await retryDelay(attempt, input.signal);
      }
    }
    throw lastError instanceof Error ? lastError : new Error('Remote compaction failed.');
  }
}

async function collectRemoteCompaction(
  response: Response,
  signal?: AbortSignal,
): Promise<Omit<RemoteCompactionResult, 'durationMs'>> {
  if (!response.body) throw new Error('Remote compaction response has no body.');
  const items: CanonicalJsonValue[] = [];
  let completed = false;
  let usage: ContextCompactionUsage = {
    inputTokens: null,
    outputTokens: null,
    cachedInputTokens: null,
  };
  for await (const event of parseSse(response.body, signal)) {
    const type = typeof event.type === 'string' ? event.type : '';
    if (type === 'error' || type === 'response.failed') {
      throw new Error(providerEventError(event));
    }
    if (type === 'response.output_item.done') {
      const item = event.item;
      if (isCompactionItem(item)) items.push(canonicalProviderCompactionItem(item));
      continue;
    }
    if (type === 'response.completed' || type === 'response.done') {
      completed = true;
      const providerResponse = asRecord(event.response);
      const output = Array.isArray(providerResponse?.output) ? providerResponse.output : [];
      for (const item of output) {
        if (isCompactionItem(item)) items.push(canonicalProviderCompactionItem(item));
      }
      usage = responseUsage(providerResponse?.usage);
      break;
    }
    if (type === 'response.incomplete') {
      throw new Error('Remote compaction response was incomplete.');
    }
  }
  if (!completed) throw new Error('Remote compaction stream ended before response.completed.');
  const unique = new Map(items.map((item) => [JSON.stringify(item), item]));
  if (unique.size !== 1) {
    throw new Error(`Remote compaction expected exactly one opaque item; received ${unique.size}.`);
  }
  return { providerItem: [...unique.values()][0]!, usage };
}

async function* parseSse(body: ReadableStream<Uint8Array>, signal?: AbortSignal) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const abort = () => void reader.cancel().catch(() => undefined);
  signal?.addEventListener('abort', abort, { once: true });
  try {
    while (true) {
      signal?.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true }).replaceAll('\r\n', '\n');
      let boundary = buffer.indexOf('\n\n');
      while (boundary !== -1) {
        const chunk = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const data = chunk.split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trim())
          .join('\n')
          .trim();
        if (data && data !== '[DONE]') {
          yield JSON.parse(data) as Record<string, unknown>;
        }
        boundary = buffer.indexOf('\n\n');
      }
    }
  } finally {
    signal?.removeEventListener('abort', abort);
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

function responseUsage(value: unknown): ContextCompactionUsage {
  const usage = asRecord(value);
  const details = asRecord(usage?.input_tokens_details);
  return {
    inputTokens: nonnegativeIntegerOrNull(usage?.input_tokens),
    outputTokens: nonnegativeIntegerOrNull(usage?.output_tokens),
    cachedInputTokens: nonnegativeIntegerOrNull(details?.cached_tokens),
  };
}

function isCompactionItem(value: unknown) {
  const item = asRecord(value);
  return item?.type === 'compaction' || item?.type === 'compaction_summary';
}

function providerEventError(value: Record<string, unknown>) {
  const response = asRecord(value.response);
  const error = asRecord(value.error) ?? asRecord(response?.error);
  const message = error?.message ?? value.message;
  return typeof message === 'string' && message ? message : 'Remote compaction provider error.';
}

function buildHeaders(
  modelHeaders: Record<string, string> | undefined,
  authHeaders: Record<string, string | null> | undefined,
  token: string,
  accountId: string,
) {
  const headers = new Headers(modelHeaders);
  for (const [name, value] of Object.entries(authHeaders ?? {})) {
    if (value === null) headers.delete(name);
    else headers.set(name, value);
  }
  headers.set('Authorization', `Bearer ${token}`);
  headers.set('chatgpt-account-id', accountId);
  headers.set('originator', 'remux-agent');
  headers.set('User-Agent', `remux-agent (${process.platform} ${process.arch})`);
  headers.set('OpenAI-Beta', 'responses=experimental');
  headers.set('accept', 'text/event-stream');
  headers.set('content-type', 'application/json');
  return headers;
}

function extractAccountId(token: string) {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) throw new Error('Invalid OAuth token.');
    const payload = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8')) as Record<string, unknown>;
    const auth = asRecord(payload[JWT_CLAIM_PATH]);
    if (typeof auth?.chatgpt_account_id !== 'string' || !auth.chatgpt_account_id) {
      throw new Error('OAuth token has no ChatGPT account ID.');
    }
    return auth.chatgpt_account_id;
  } catch (error) {
    throw new Error('Failed to resolve ChatGPT account identity for remote compaction.', { cause: error });
  }
}

function resolveCodexUrl(baseUrl: string | undefined) {
  const normalized = (baseUrl?.trim() || DEFAULT_CODEX_BASE_URL).replace(/\/+$/u, '');
  if (normalized.endsWith('/codex/responses')) return normalized;
  if (normalized.endsWith('/codex')) return `${normalized}/responses`;
  return `${normalized}/codex/responses`;
}

function isRetryableStatus(status: number, detail: string) {
  if (status === 429 && /usage limit|quota|balance|out of budget/iu.test(detail)) return false;
  return status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

function isRetryableError(error: unknown) {
  if (!(error instanceof Error)) return true;
  return !/aborted|usage limit|quota|balance|out of budget|HTTP 4\d\d/iu.test(error.message);
}

async function retryDelay(attempt: number, signal?: AbortSignal) {
  await new Promise<void>((resolve, reject) => {
    const finish = () => {
      signal?.removeEventListener('abort', abort);
      resolve();
    };
    const timeout = setTimeout(finish, 500 * (2 ** attempt));
    const abort = () => {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abort);
      reject(signal?.reason ?? new Error('Remote compaction aborted.'));
    };
    signal?.addEventListener('abort', abort, { once: true });
  });
}

function providerError(value: string) {
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    const error = asRecord(parsed.error);
    return typeof error?.message === 'string' ? error.message : value.slice(0, 2_000);
  } catch {
    return value.slice(0, 2_000);
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function nonnegativeIntegerOrNull(value: unknown) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}
