import { expect, test } from '@playwright/test';

import validArtifact from '../../../extensions/narrate/server/schemas/fixtures/narration-artifact-v4.valid.json' with { type: 'json' };
import {
  decodeNarrationReadResponse,
  decodeNarrationStartResponse,
  NarrationProtocolError,
} from '../src';

const artifactKey = validArtifact.artifactKey;

function progress() {
  return {
    auditWindowsCompleted: 1,
    auditWindowsTotal: 1,
    transcriptWindowsCompleted: 1,
    transcriptWindowsTotal: 1,
    chunksCompleted: 1,
    chunksTotal: 1,
    sentences: 1,
    stage: 'ready',
    words: 2,
  };
}

function resource() {
  return {
    artifactKey,
    complete: true,
    error: null,
    manifest: structuredClone(validArtifact),
    progress: progress(),
    revision: '3',
    status: 'ready',
  };
}

function startEnvelope(): Record<string, unknown> {
  return {
    artifactKey,
    resource: resource(),
    status: 'accepted',
  };
}

test('decodes the exact v4 start and read envelopes consumed by the client', () => {
  const start = decodeNarrationStartResponse(startEnvelope());
  expect(start.artifactKey).toBe(artifactKey);
  expect(start.resource.manifest?.audio.totalSamples).toBe(24_000);

  expect(decodeNarrationReadResponse({ resource: null, status: 'notModified' }, artifactKey))
    .toEqual({ resource: null, status: 'notModified' });
  expect(decodeNarrationReadResponse({ resource: null, status: 'missing' }, artifactKey))
    .toEqual({ resource: null, status: 'missing' });
});

test('rejects a start envelope without status before any property access can escape', () => {
  const value = startEnvelope();
  delete value.status;
  expect(() => decodeNarrationStartResponse(value)).toThrow(NarrationProtocolError);
  expect(() => decodeNarrationStartResponse(value)).toThrow('Invalid narration response: start status is invalid');
});

test('rejects missing and status-inconsistent read resources', () => {
  expect(() => decodeNarrationReadResponse({ status: 'ok' }, artifactKey))
    .toThrow('Invalid narration response: resource must be an object');
  expect(() => decodeNarrationReadResponse({ status: 'missing' }, artifactKey))
    .toThrow('Invalid narration response: read resource must be null for missing');
  expect(() => decodeNarrationReadResponse({ resource: resource(), status: 'missing' }, artifactKey))
    .toThrow('Invalid narration response: read resource must be null for missing');
});

test('rejects artifact-key mismatches at every envelope boundary', () => {
  const value = startEnvelope();
  (value.resource as Record<string, unknown>).artifactKey = `sha256-${'f'.repeat(64)}`;
  expect(() => decodeNarrationStartResponse(value))
    .toThrow('Invalid narration response: resource artifactKey is invalid');
});

test('rejects malformed arrays, ranges, and non-finite counters', () => {
  const arrays = startEnvelope();
  const arraysResource = arrays.resource as Record<string, unknown>;
  const arraysManifest = arraysResource.manifest as Record<string, unknown>;
  arraysManifest.wordCues = {};
  expect(() => decodeNarrationStartResponse(arrays))
    .toThrow('Invalid narration response: manifest wordCues must be an array');

  const range = startEnvelope();
  const rangeResource = range.resource as Record<string, unknown>;
  const rangeManifest = rangeResource.manifest as Record<string, unknown>;
  (rangeManifest.blocks as Array<Record<string, unknown>>)[0].endSample = 24_001;
  expect(() => decodeNarrationStartResponse(range))
    .toThrow('Invalid narration response: block 0 exceeds total samples');

  const counter = startEnvelope();
  const counterResource = counter.resource as Record<string, unknown>;
  const counterProgress = counterResource.progress as Record<string, unknown>;
  counterProgress.words = Number.POSITIVE_INFINITY;
  expect(() => decodeNarrationStartResponse(counter))
    .toThrow('Invalid narration response: progress words must be a nonnegative integer');
});

test('rejects a media URL that does not match the audio digest', () => {
  const value = startEnvelope();
  const valueResource = value.resource as Record<string, unknown>;
  const manifest = valueResource.manifest as Record<string, unknown>;
  const audio = manifest.audio as Record<string, unknown>;
  audio.url = `/remux/media/sha256/${'f'.repeat(64)}`;
  expect(() => decodeNarrationStartResponse(value))
    .toThrow('Invalid narration response: audio URL does not match its SHA-256');
});
