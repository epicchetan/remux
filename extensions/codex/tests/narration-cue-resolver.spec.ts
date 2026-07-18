import { expect, test } from '@playwright/test';

import type { CodexNarrationArtifact } from '../shared/narration';
import { resolveNarrationPosition } from '../viewer/narration/cueResolver';

const artifact: CodexNarrationArtifact = {
  artifactKey: 'sha256-fixture',
  audio: {
    channels: 1,
    mimeType: 'audio/wav',
    sampleRate: 24000,
    sha256: 'sha256-fixture',
    sizeBytes: 104,
    totalSamples: 30,
    url: '/remux/media/sha256/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  },
  blocks: [
    { blockId: 'md:0', endSample: 20, startSample: 10 },
    { blockId: 'md:1', endSample: 30, startSample: 20 },
  ],
  documentHash: 'sha256-fixture',
  offsetEncoding: 'utf16CodeUnit',
  pronunciationPlanSha256: 'sha256-plan',
  structuralTranscriptPlanSha256: 'sha256-structural-plan',
  profile: {
    phonemizer: 'fixture',
    plannerVersion: 1,
    pronunciationReviewer: {
      directPhoneValidatorVersion: 1,
      effort: 'low',
      kokoroVocabularySha256: 'sha256-vocabulary',
      model: 'gpt-5.6-sol',
      outputSchemaVersion: 4,
      phoneAlphabetSha256: 'sha256-alphabet',
      phoneAlphabetVersion: 1,
      profileDigest: 'sha256-profile',
      promptVersion: 4,
      serviceTier: 'priority',
      windowPlannerVersion: 3,
    },
    structuralTranscript: {
      effort: 'low',
      model: 'gpt-5.6-sol',
      outputSchemaVersion: 2,
      profileDigest: 'sha256-profile',
      promptVersion: 2,
      serviceTier: 'priority',
      windowPlannerVersion: 1,
    },
    sentenceVersion: 1,
    sourceMapperVersion: 1,
    synthesizerHash: 'sha256-fixture',
    timingVersion: 2,
    wordSegmenterVersion: 1,
  },
  schemaVersion: 4,
  sentences: [
    { blockId: 'md:0', endSample: 20, id: 's0', startSample: 10, textEnd: 5, textStart: 0 },
    { blockId: 'md:1', endSample: 30, id: 's1', startSample: 20, textEnd: 5, textStart: 0 },
  ],
  wordCues: [
    { blockId: 'md:0', endSample: 15, sentenceId: 's0', startSample: 11, textEnd: 5, textStart: 0 },
    { blockId: 'md:1', endSample: 25, sentenceId: 's1', startSample: 22, textEnd: 5, textStart: 0 },
  ],
};

test('resolves sample ranges as half-open and leaves punctuation gaps unhighlighted', () => {
  expect(resolveNarrationPosition(artifact, 14)).toMatchObject({
    blockIndex: 0,
    sentenceIndex: 0,
    wordCueIndex: 0,
  });
  expect(resolveNarrationPosition(artifact, 15)).toMatchObject({
    blockIndex: 0,
    sentenceIndex: 0,
    wordCueIndex: -1,
  });
  expect(resolveNarrationPosition(artifact, 20)).toMatchObject({
    blockIndex: 1,
    sentenceIndex: 1,
    wordCueIndex: -1,
  });
  expect(resolveNarrationPosition(artifact, 30)).toMatchObject({
    blockIndex: -1,
    sentenceIndex: -1,
    wordCueIndex: -1,
  });
});
