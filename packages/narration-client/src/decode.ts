import type {
  NarrationArtifact,
  NarrationCancelResponse,
  NarrationProgress,
  NarrationReadResponse,
  NarrationResource,
  NarrationStartResponse,
  NarrationUpdatedNotification,
} from './protocol';

const sha256Pattern = /^sha256-[0-9a-f]{64}$/;
const mediaUrlPattern = /^\/remux\/media\/sha256\/([0-9a-f]{64})$/;

export class NarrationProtocolError extends Error {
  constructor(detail: string) {
    super(`Invalid narration response: ${detail}`);
    this.name = 'NarrationProtocolError';
  }
}

export function decodeNarrationStartResponse(value: unknown): NarrationStartResponse {
  const object = record(value, 'start envelope');
  equal(object.status, 'accepted', 'start status');
  const artifactKey = nonempty(object.artifactKey, 'start artifactKey');
  const resource = decodeResource(object.resource, artifactKey);
  return { artifactKey, resource, status: 'accepted' };
}

export function decodeNarrationReadResponse(
  value: unknown,
  expectedArtifactKey: string,
): NarrationReadResponse {
  const object = record(value, 'read envelope');
  const status = oneOf(object.status, ['missing', 'notModified', 'ok'] as const, 'read status');
  if (status === 'ok') {
    return {
      resource: decodeResource(object.resource, expectedArtifactKey),
      status,
    };
  }
  if (object.resource !== null) {
    fail(`read resource must be null for ${status}`);
  }
  return { resource: null, status };
}

export function decodeNarrationCancelResponse(
  value: unknown,
  expectedArtifactKey: string,
): NarrationCancelResponse {
  const object = record(value, 'cancel envelope');
  equal(object.status, 'accepted', 'cancel status');
  equal(object.artifactKey, expectedArtifactKey, 'cancel artifactKey');
  return { artifactKey: expectedArtifactKey, status: 'accepted' };
}

export function decodeNarrationUpdatedNotification(value: unknown): NarrationUpdatedNotification {
  const object = record(value, 'updated notification');
  return { artifactKey: nonempty(object.artifactKey, 'updated artifactKey') };
}

export function decodeNarrationResource(
  value: unknown,
  expectedArtifactKey: string,
): NarrationResource {
  return decodeResource(value, expectedArtifactKey);
}

function decodeResource(value: unknown, expectedArtifactKey: string): NarrationResource {
  const object = record(value, 'resource');
  equal(object.artifactKey, expectedArtifactKey, 'resource artifactKey');
  const status = oneOf(
    object.status,
    ['preparing', 'synthesizing', 'finalizing', 'ready', 'failed', 'cancelled'] as const,
    'resource status',
  );
  const complete = boolean(object.complete, 'resource complete');
  const revision = nonempty(object.revision, 'resource revision');
  if (!/^\d+$/.test(revision)) fail('resource revision must be a nonnegative integer string');
  const error = nullableString(object.error, 'resource error');
  const progress = decodeProgress(object.progress);
  const manifest = object.manifest === null
    ? null
    : decodeArtifact(object.manifest, expectedArtifactKey);
  if (status === 'ready' && (!complete || manifest === null)) {
    fail('ready resource must be complete and contain a manifest');
  }
  if (complete && manifest === null && status !== 'failed' && status !== 'cancelled') {
    fail('complete resource must contain a manifest');
  }
  return {
    artifactKey: expectedArtifactKey,
    complete,
    error,
    manifest,
    progress,
    revision,
    status,
  };
}

function decodeProgress(value: unknown): NarrationProgress {
  const object = record(value, 'progress');
  const auditWindowsCompleted = count(object.auditWindowsCompleted, 'progress auditWindowsCompleted');
  const auditWindowsTotal = count(object.auditWindowsTotal, 'progress auditWindowsTotal');
  const transcriptWindowsCompleted = count(
    object.transcriptWindowsCompleted,
    'progress transcriptWindowsCompleted',
  );
  const transcriptWindowsTotal = count(object.transcriptWindowsTotal, 'progress transcriptWindowsTotal');
  const chunksCompleted = count(object.chunksCompleted, 'progress chunksCompleted');
  const chunksTotal = count(object.chunksTotal, 'progress chunksTotal');
  if (auditWindowsCompleted > auditWindowsTotal) fail('progress audit windows exceed total');
  if (transcriptWindowsCompleted > transcriptWindowsTotal) fail('progress transcript windows exceed total');
  if (chunksCompleted > chunksTotal) fail('progress chunks exceed total');
  return {
    auditWindowsCompleted,
    auditWindowsTotal,
    transcriptWindowsCompleted,
    transcriptWindowsTotal,
    chunksCompleted,
    chunksTotal,
    sentences: count(object.sentences, 'progress sentences'),
    stage: oneOf(
      object.stage,
      ['baseline', 'languagePlanning', 'planning', 'loadingModel', 'synthesizing', 'finalizing', 'ready'] as const,
      'progress stage',
    ),
    words: count(object.words, 'progress words'),
  };
}

function decodeArtifact(value: unknown, expectedArtifactKey: string): NarrationArtifact {
  const object = record(value, 'manifest');
  equal(object.schemaVersion, 4, 'manifest schemaVersion');
  equal(object.offsetEncoding, 'utf16CodeUnit', 'manifest offsetEncoding');
  equal(object.artifactKey, expectedArtifactKey, 'manifest artifactKey');
  const artifactKey = digest(object.artifactKey, 'manifest artifactKey');
  const documentHash = digest(object.documentHash, 'manifest documentHash');
  const pronunciationPlanSha256 = digest(
    object.pronunciationPlanSha256,
    'manifest pronunciationPlanSha256',
  );
  const structuralTranscriptPlanSha256 = digest(
    object.structuralTranscriptPlanSha256,
    'manifest structuralTranscriptPlanSha256',
  );
  const audioObject = record(object.audio, 'manifest audio');
  equal(audioObject.channels, 1, 'audio channels');
  equal(audioObject.mimeType, 'audio/wav', 'audio mimeType');
  equal(audioObject.sampleRate, 24000, 'audio sampleRate');
  const sha256 = digest(audioObject.sha256, 'audio sha256');
  const url = nonempty(audioObject.url, 'audio url');
  const urlMatch = mediaUrlPattern.exec(url);
  if (!urlMatch || `sha256-${urlMatch[1]}` !== sha256) {
    fail('audio URL does not match its SHA-256');
  }
  const totalSamples = positiveCount(audioObject.totalSamples, 'audio totalSamples');
  const sizeBytes = positiveCount(audioObject.sizeBytes, 'audio sizeBytes');
  const blocks = array(object.blocks, 'manifest blocks').map((item, index) => {
    const range = decodeSampleRange(item, `block ${index}`, totalSamples);
    return { ...range, blockId: nonempty(range.object.blockId, `block ${index} blockId`) };
  });
  const sentences = array(object.sentences, 'manifest sentences').map((item, index) => {
    const range = decodeSampleRange(item, `sentence ${index}`, totalSamples);
    const text = decodeTextRange(range.object, `sentence ${index}`);
    return {
      blockId: nonempty(range.object.blockId, `sentence ${index} blockId`),
      endSample: range.endSample,
      id: nonempty(range.object.id, `sentence ${index} id`),
      startSample: range.startSample,
      ...text,
    };
  });
  const wordCues = array(object.wordCues, 'manifest wordCues').map((item, index) => {
    const range = decodeSampleRange(item, `word cue ${index}`, totalSamples);
    const text = decodeTextRange(range.object, `word cue ${index}`);
    return {
      blockId: nonempty(range.object.blockId, `word cue ${index} blockId`),
      endSample: range.endSample,
      sentenceId: nonempty(range.object.sentenceId, `word cue ${index} sentenceId`),
      startSample: range.startSample,
      ...text,
    };
  });
  assertSortedRanges(blocks, 'blocks');
  assertSortedRanges(sentences, 'sentences');
  assertSortedRanges(wordCues, 'word cues');
  const profile = decodeProfile(object.profile);
  return {
    artifactKey,
    audio: {
      channels: 1,
      mimeType: 'audio/wav',
      sampleRate: 24000,
      sha256,
      sizeBytes,
      totalSamples,
      url: url as NarrationArtifact['audio']['url'],
    },
    blocks: blocks.map(({ object: _object, ...block }) => block),
    documentHash,
    offsetEncoding: 'utf16CodeUnit',
    pronunciationPlanSha256,
    structuralTranscriptPlanSha256,
    profile,
    schemaVersion: 4,
    sentences,
    wordCues,
  };
}

function decodeProfile(value: unknown): NarrationArtifact['profile'] {
  const object = record(value, 'manifest profile');
  const reviewer = record(object.pronunciationReviewer, 'pronunciation reviewer profile');
  const transcript = record(object.structuralTranscript, 'structural transcript profile');
  return {
    phonemizer: nonempty(object.phonemizer, 'profile phonemizer'),
    plannerVersion: positiveCount(object.plannerVersion, 'profile plannerVersion'),
    pronunciationReviewer: {
      directPhoneValidatorVersion: positiveCount(
        reviewer.directPhoneValidatorVersion,
        'reviewer directPhoneValidatorVersion',
      ),
      effort: exact(reviewer.effort, 'low', 'reviewer effort'),
      kokoroVocabularySha256: digest(reviewer.kokoroVocabularySha256, 'reviewer vocabulary digest'),
      model: exact(reviewer.model, 'gpt-5.6-sol', 'reviewer model'),
      outputSchemaVersion: positiveCount(reviewer.outputSchemaVersion, 'reviewer outputSchemaVersion'),
      phoneAlphabetSha256: digest(reviewer.phoneAlphabetSha256, 'reviewer phone alphabet digest'),
      phoneAlphabetVersion: positiveCount(reviewer.phoneAlphabetVersion, 'reviewer phoneAlphabetVersion'),
      profileDigest: digest(reviewer.profileDigest, 'reviewer profileDigest'),
      promptVersion: positiveCount(reviewer.promptVersion, 'reviewer promptVersion'),
      serviceTier: exact(reviewer.serviceTier, 'priority', 'reviewer serviceTier'),
      windowPlannerVersion: positiveCount(reviewer.windowPlannerVersion, 'reviewer windowPlannerVersion'),
    },
    structuralTranscript: {
      effort: exact(transcript.effort, 'low', 'transcript effort'),
      model: exact(transcript.model, 'gpt-5.6-sol', 'transcript model'),
      outputSchemaVersion: positiveCount(transcript.outputSchemaVersion, 'transcript outputSchemaVersion'),
      profileDigest: digest(transcript.profileDigest, 'transcript profileDigest'),
      promptVersion: positiveCount(transcript.promptVersion, 'transcript promptVersion'),
      serviceTier: exact(transcript.serviceTier, 'priority', 'transcript serviceTier'),
      windowPlannerVersion: positiveCount(transcript.windowPlannerVersion, 'transcript windowPlannerVersion'),
    },
    sentenceVersion: positiveCount(object.sentenceVersion, 'profile sentenceVersion'),
    sourceMapperVersion: positiveCount(object.sourceMapperVersion, 'profile sourceMapperVersion'),
    synthesizerHash: digest(object.synthesizerHash, 'profile synthesizerHash'),
    timingVersion: positiveCount(object.timingVersion, 'profile timingVersion'),
    wordSegmenterVersion: positiveCount(object.wordSegmenterVersion, 'profile wordSegmenterVersion'),
  };
}

function decodeSampleRange(value: unknown, label: string, totalSamples: number) {
  const object = record(value, label);
  const startSample = count(object.startSample, `${label} startSample`);
  const endSample = positiveCount(object.endSample, `${label} endSample`);
  if (startSample >= endSample) fail(`${label} sample range is empty or reversed`);
  if (endSample > totalSamples) fail(`${label} exceeds total samples`);
  return { endSample, object, startSample };
}

function decodeTextRange(object: Record<string, unknown>, label: string) {
  const textStart = count(object.textStart, `${label} textStart`);
  const textEnd = positiveCount(object.textEnd, `${label} textEnd`);
  if (textStart >= textEnd) fail(`${label} text range is empty or reversed`);
  return { textEnd, textStart };
}

function assertSortedRanges(
  ranges: Array<{ endSample: number; startSample: number }>,
  label: string,
) {
  for (let index = 1; index < ranges.length; index += 1) {
    if (ranges[index].startSample < ranges[index - 1].startSample) {
      fail(`manifest ${label} are not sample ordered`);
    }
    if (ranges[index].startSample < ranges[index - 1].endSample) {
      fail(`manifest ${label} overlap`);
    }
  }
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) fail(`${label} must be an array`);
  return value;
}

function count(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    fail(`${label} must be a nonnegative integer`);
  }
  return value;
}

function positiveCount(value: unknown, label: string): number {
  const result = count(value, label);
  if (result === 0) fail(`${label} must be positive`);
  return result;
}

function boolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') fail(`${label} must be a boolean`);
  return value;
}

function nonempty(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) fail(`${label} must be a nonempty string`);
  return value;
}

function nullableString(value: unknown, label: string): string | null {
  if (value === null) return null;
  if (typeof value !== 'string') fail(`${label} must be a string or null`);
  return value;
}

function digest(value: unknown, label: string): string {
  const result = nonempty(value, label);
  if (!sha256Pattern.test(result)) fail(`${label} must be a SHA-256 digest`);
  return result;
}

function equal(actual: unknown, expected: unknown, label: string): void {
  if (actual !== expected) fail(`${label} is invalid`);
}

function exact<const T>(actual: unknown, expected: T, label: string): T {
  equal(actual, expected, label);
  return expected;
}

function oneOf<const T extends readonly string[]>(
  value: unknown,
  values: T,
  label: string,
): T[number] {
  if (typeof value !== 'string' || !values.includes(value)) fail(`${label} is invalid`);
  return value as T[number];
}

function fail(detail: string): never {
  throw new NarrationProtocolError(detail);
}
