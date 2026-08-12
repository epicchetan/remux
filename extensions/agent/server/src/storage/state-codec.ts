import { createHash } from 'node:crypto';

import type { DurableContentRef } from '../domain/state.ts';
import type { CanonicalJsonValue } from './canonical-json.ts';
import type { StagedArtifact } from './artifact-store.ts';

export function sqlPlaceholders(count: number) {
  if (!Number.isSafeInteger(count) || count < 1) throw new Error('SQL placeholder count must be positive.');
  return new Array(count).fill('?').join(', ');
}

export function truncateUtf8Text(value: string, maxBytes: number) {
  if (maxBytes <= 0) return '';
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.byteLength <= maxBytes) return value;
  return bytes.subarray(0, maxBytes).toString('utf8').replace(/\uFFFD$/u, '');
}

export function artifactRef(artifact: StagedArtifact): DurableContentRef {
  return {
    kind: 'artifact',
    hash: artifact.hash,
    byteLength: artifact.byteLength,
    mediaType: artifact.mediaType,
    storagePath: artifact.storagePath,
  };
}

export function parseReference(value: CanonicalJsonValue | undefined): DurableContentRef {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Durable content reference is invalid.');
  }
  const ref = value as Record<string, CanonicalJsonValue>;
  const kind = requiredString(ref.kind, 'kind');
  const byteLength = requiredNonnegativeInteger(ref.byteLength, 'byteLength');
  if (kind === 'inline') {
    const text = requiredString(ref.text, 'text');
    const sha256 = requiredHash(ref.sha256, 'sha256');
    if (Buffer.byteLength(text, 'utf8') !== byteLength) throw new Error('Inline content byte length is invalid.');
    if (createHash('sha256').update(text).digest('hex') !== sha256) {
      throw new Error('Inline content hash is invalid.');
    }
    return { kind, text, byteLength, sha256 };
  }
  if (kind !== 'artifact') throw new Error('Durable content reference kind is invalid.');
  return {
    kind,
    hash: requiredHash(ref.hash, 'hash'),
    byteLength,
    mediaType: requiredString(ref.mediaType, 'mediaType'),
    storagePath: requiredString(ref.storagePath, 'storagePath'),
  };
}

export function normalizeJson(value: unknown): CanonicalJsonValue {
  if (value === undefined) return null;
  const serialized = JSON.stringify(value);
  if (serialized === undefined) return null;
  return JSON.parse(serialized) as CanonicalJsonValue;
}

export function boundedSafeInteger(value: number, min: number, max: number, label: string) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new TypeError(`${label} must be an integer between ${min} and ${max}.`);
  }
  return value;
}

export function boundedUtf8Slice(bytes: Buffer, requestedOffset: number, maxBytes: number) {
  let offset = requestedOffset;
  while (offset < bytes.byteLength && (bytes[offset]! & 0xc0) === 0x80) offset += 1;
  let end = Math.min(bytes.byteLength, offset + maxBytes);
  while (end > offset && end < bytes.byteLength && (bytes[end]! & 0xc0) === 0x80) end -= 1;
  return {
    offset,
    byteLength: end - offset,
    text: bytes.subarray(offset, end).toString('utf8'),
  };
}

export function requiredString(value: CanonicalJsonValue | undefined, label: string) {
  if (typeof value !== 'string') throw new Error(`Durable ${label} is invalid.`);
  return value;
}

export function requiredHash(value: CanonicalJsonValue | undefined, label: string) {
  const hash = requiredString(value, label);
  if (!/^[0-9a-f]{64}$/u.test(hash)) throw new Error(`Durable ${label} is invalid.`);
  return hash;
}

export function requiredNonnegativeInteger(value: CanonicalJsonValue | undefined, label: string) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Durable ${label} is invalid.`);
  }
  return value;
}

export function safeTimestamp(value: number) {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError('Recorded timestamp must be nonnegative.');
  return value;
}

export function safeDuration(value: number) {
  if (!Number.isFinite(value) || value < 0) throw new TypeError('Turn duration must be nonnegative.');
  return Math.round(value);
}

export function safeInteger(value: number, label: string) {
  if (!Number.isSafeInteger(value)) throw new Error(`Invalid ${label}.`);
  return value;
}

export function safeNonnegativeInteger(value: unknown, label: string) {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error(`Invalid ${label}.`);
  return Number(value);
}
