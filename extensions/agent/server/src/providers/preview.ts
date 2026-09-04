import {
  PROVIDER_RUNTIME_LIMITS,
  type JsonValue,
} from '../../../shared/provider-runtime.ts';

const TRUNCATION_MARKER = '\n… output truncated …\n';

type TruncationStrategy = 'head' | 'tail' | 'head-tail';

/**
 * Produces a JSON-safe presentation value that satisfies the provider preview
 * byte contract. This is only for Remux's journal/viewer projection; it never
 * changes the native tool result delivered to the model by its harness.
 */
export function fitJsonPreview(
  value: unknown,
  options: { maxBytes?: number; strategy?: TruncationStrategy } = {},
): JsonValue {
  const maxBytes = options.maxBytes ?? PROVIDER_RUNTIME_LIMITS.previewBytes;
  const strategy = options.strategy ?? 'head-tail';
  let encoded: string;
  try {
    encoded = JSON.stringify(value);
  } catch {
    return '[Unserializable provider value]';
  }
  if (encoded === undefined) return '[Unavailable provider value]';
  if (encodedJsonByteLength(encoded, true) <= maxBytes) {
    return JSON.parse(encoded) as JsonValue;
  }
  if (typeof value === 'string') {
    return fitTextInContainer(value, (text) => text, maxBytes, strategy, false);
  }
  return fitTextInContainer(encoded, (text) => text, maxBytes, strategy, false);
}

/**
 * Merges native streaming tool-output deltas while retaining a useful tail and
 * measuring the complete JSON object, including its wrapper and escaping.
 */
export function mergeJsonPreview(
  previous: JsonValue | undefined,
  next: JsonValue,
  maxBytes = PROVIDER_RUNTIME_LIMITS.previewBytes,
): JsonValue {
  const left = jsonRecord(previous);
  const right = jsonRecord(next);
  if (right && typeof right.delta === 'string') {
    const previousDelta = left && typeof left.delta === 'string' ? left.delta : '';
    const wasTruncated = previousDelta.startsWith(TRUNCATION_MARKER);
    const combined = `${stripTruncationMarker(previousDelta)}${right.delta}`;
    const base = { ...(left ?? {}), ...right };
    const delta = fitTextInContainer(
      combined,
      (text) => ({ ...base, delta: text }),
      maxBytes,
      'tail',
      wasTruncated,
    );
    return { ...base, delta } as JsonValue;
  }
  return fitJsonPreview(next, { maxBytes });
}

export function jsonPreviewByteLength(value: unknown) {
  let encoded: string | undefined;
  try {
    encoded = JSON.stringify(value);
  } catch {
    return Number.POSITIVE_INFINITY;
  }
  return encoded === undefined ? Number.POSITIVE_INFINITY : encodedJsonByteLength(encoded, true);
}

function fitTextInContainer<T extends JsonValue>(
  text: string,
  container: (text: string) => T,
  maxBytes: number,
  strategy: TruncationStrategy,
  forceMarker: boolean,
) {
  if (!forceMarker && jsonPreviewByteLength(container(text)) <= maxBytes) return text;

  let low = 0;
  let high = text.length;
  let best = TRUNCATION_MARKER.trim();
  while (low <= high) {
    const kept = Math.floor((low + high) / 2);
    const candidate = truncatedText(text, kept, strategy);
    if (jsonPreviewByteLength(container(candidate)) <= maxBytes) {
      best = candidate;
      low = kept + 1;
    } else {
      high = kept - 1;
    }
  }
  return best;
}

function truncatedText(text: string, keptCodeUnits: number, strategy: TruncationStrategy) {
  if (strategy === 'head') {
    return `${safePrefix(text, keptCodeUnits)}${TRUNCATION_MARKER}`;
  }
  if (strategy === 'tail') {
    return `${TRUNCATION_MARKER}${safeSuffix(text, keptCodeUnits)}`;
  }
  const head = Math.ceil(keptCodeUnits / 2);
  const tail = Math.floor(keptCodeUnits / 2);
  return `${safePrefix(text, head)}${TRUNCATION_MARKER}${safeSuffix(text, tail)}`;
}

function safePrefix(text: string, codeUnits: number) {
  let end = Math.min(text.length, Math.max(0, codeUnits));
  if (end > 0 && end < text.length && isHighSurrogate(text.charCodeAt(end - 1))) end -= 1;
  return text.slice(0, end);
}

function safeSuffix(text: string, codeUnits: number) {
  let start = Math.max(0, text.length - Math.max(0, codeUnits));
  if (start > 0 && start < text.length && isLowSurrogate(text.charCodeAt(start))) start += 1;
  return text.slice(start);
}

function stripTruncationMarker(value: string) {
  return value.startsWith(TRUNCATION_MARKER) ? value.slice(TRUNCATION_MARKER.length) : value;
}

function isHighSurrogate(code: number) {
  return code >= 0xD800 && code <= 0xDBFF;
}

function isLowSurrogate(code: number) {
  return code >= 0xDC00 && code <= 0xDFFF;
}

function jsonRecord(value: JsonValue | undefined): Record<string, JsonValue> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, JsonValue>
    : undefined;
}

function encodedJsonByteLength(encoded: string, alreadyEncoded: boolean) {
  return new TextEncoder().encode(alreadyEncoded ? encoded : JSON.stringify(encoded)).byteLength;
}
