import { expect, test } from '@playwright/test';

import type { NarrationArtifact } from '../src';
import { resolveNarrationPosition } from '../src';

const artifact = {
  audio: { totalSamples: 30 },
  blocks: [
    { blockId: 'md:0', endSample: 20, startSample: 10 },
    { blockId: 'md:1', endSample: 30, startSample: 20 },
  ],
  sentences: [
    { blockId: 'md:0', endSample: 20, id: 's0', startSample: 10, textEnd: 5, textStart: 0 },
    { blockId: 'md:1', endSample: 30, id: 's1', startSample: 20, textEnd: 5, textStart: 0 },
  ],
  wordCues: [
    { blockId: 'md:0', endSample: 15, sentenceId: 's0', startSample: 11, textEnd: 5, textStart: 0 },
    { blockId: 'md:1', endSample: 25, sentenceId: 's1', startSample: 22, textEnd: 5, textStart: 0 },
  ],
} as NarrationArtifact;

test('resolves half-open ranges and leaves punctuation gaps unhighlighted', () => {
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
