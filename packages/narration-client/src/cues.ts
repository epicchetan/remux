import type {
  NarrationArtifact,
  NarrationBlockTiming,
  NarrationSentence,
  NarrationWordCue,
} from './protocol';

export type NarrationResolvedPosition = {
  block: NarrationBlockTiming | null;
  blockIndex: number;
  sentence: NarrationSentence | null;
  sentenceIndex: number;
  wordCue: NarrationWordCue | null;
  wordCueIndex: number;
};

export function resolveNarrationPosition(
  artifact: NarrationArtifact,
  sample: number,
): NarrationResolvedPosition {
  const blockIndex = findHalfOpenSampleRange(artifact.blocks, sample);
  const sentenceIndex = findHalfOpenSampleRange(artifact.sentences, sample);
  const wordCueIndex = findHalfOpenSampleRange(artifact.wordCues, sample);
  return {
    block: blockIndex >= 0 ? artifact.blocks[blockIndex] ?? null : null,
    blockIndex,
    sentence: sentenceIndex >= 0 ? artifact.sentences[sentenceIndex] ?? null : null,
    sentenceIndex,
    wordCue: wordCueIndex >= 0 ? artifact.wordCues[wordCueIndex] ?? null : null,
    wordCueIndex,
  };
}

function findHalfOpenSampleRange<T extends { endSample: number; startSample: number }>(
  items: T[],
  sample: number,
) {
  let low = 0;
  let high = items.length - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const item = items[middle];
    if (sample < item.startSample) high = middle - 1;
    else if (sample >= item.endSample) low = middle + 1;
    else return middle;
  }
  return -1;
}
