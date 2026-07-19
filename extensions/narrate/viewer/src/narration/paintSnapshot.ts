export type NarrationPaintSnapshot = {
  blockId: string | null;
  sentenceId: string | null;
  wordRange: string | null;
};

let paintSnapshot: NarrationPaintSnapshot = {
  blockId: null,
  sentenceId: null,
  wordRange: null,
};

export function getNarrationPaintSnapshot() {
  return paintSnapshot;
}

export function setNarrationPaintSnapshot(next: NarrationPaintSnapshot) {
  paintSnapshot = next;
}
