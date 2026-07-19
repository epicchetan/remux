import type {
  MarkdownNarrationBlock,
  MarkdownNarrationModel,
} from '../markdown/narrationModel';

export type NarrationDomLeaf = {
  element: HTMLElement;
  end: number;
  kind: 'element' | 'text';
  start: number;
};

export type NarrationDomBlock = {
  element: HTMLElement;
  leaves: NarrationDomLeaf[];
  model: MarkdownNarrationBlock;
  surface: HTMLElement;
};

export type NarrationDomSnapshot = {
  blocks: Map<string, NarrationDomBlock>;
  error: string | null;
  root: HTMLElement | null;
  sourceHash: string | null;
  status: 'idle' | 'invalid' | 'ready';
};

const subscribers = new Set<() => void>();
let snapshot: NarrationDomSnapshot = idleSnapshot();

export function getNarrationDomSnapshot() {
  return snapshot;
}

export function subscribeNarrationDom(listener: () => void) {
  subscribers.add(listener);
  return () => subscribers.delete(listener);
}

export function registerNarrationDom(
  root: HTMLElement,
  model: MarkdownNarrationModel,
) {
  const next = buildDomSnapshot(root, model);
  publish(next);

  return () => {
    if (snapshot.root === root && snapshot.sourceHash === model.sourceHash) {
      publish(idleSnapshot());
    }
  };
}

function buildDomSnapshot(
  root: HTMLElement,
  model: MarkdownNarrationModel,
): NarrationDomSnapshot {
  const bindingError = root.querySelector<HTMLElement>('[data-narration-binding-error]')
    ?.dataset.narrationBindingError;
  if (bindingError) {
    return invalidSnapshot(root, model.sourceHash, bindingError);
  }

  const elementsById = new Map<string, HTMLElement>();
  for (const element of root.querySelectorAll<HTMLElement>('[data-narration-block-id]')) {
    const id = element.dataset.narrationBlockId;
    if (!id) {
      continue;
    }
    if (elementsById.has(id)) {
      return invalidSnapshot(root, model.sourceHash, `Narration block ${id} is rendered more than once`);
    }
    elementsById.set(id, element);
  }

  const blocks = new Map<string, NarrationDomBlock>();
  for (const block of model.blocks) {
    const element = elementsById.get(block.id);
    if (!element) {
      return invalidSnapshot(root, model.sourceHash, `Narration block ${block.id} is missing from the renderer`);
    }
    const leaves = domLeavesForBlock(element, block);
    if (typeof leaves === 'string') {
      return invalidSnapshot(root, model.sourceHash, leaves);
    }
    const surface = narrationSurfaceForBlock(element, block);
    if (typeof surface === 'string') {
      return invalidSnapshot(root, model.sourceHash, surface);
    }
    blocks.set(block.id, { element, leaves, model: block, surface });
  }
  if (elementsById.size !== model.blocks.length) {
    return invalidSnapshot(root, model.sourceHash, 'The renderer exposed an unknown narration block');
  }
  return {
    blocks,
    error: null,
    root,
    sourceHash: model.sourceHash,
    status: 'ready',
  };
}

function narrationSurfaceForBlock(
  blockElement: HTMLElement,
  block: MarkdownNarrationBlock,
): HTMLElement | string {
  if (block.highlightMode !== 'block') {
    return blockElement;
  }
  const kind = block.kind === 'diagram' ? 'diagram' : block.kind;
  if (kind !== 'code' && kind !== 'table' && kind !== 'diagram') {
    return `Narration block ${block.id} has no structural surface contract`;
  }
  const selector = `[data-narration-render-surface="${kind}"]`;
  const candidates = new Set<HTMLElement>();
  if (blockElement.matches(selector)) {
    candidates.add(blockElement);
  }
  const ancestor = blockElement.parentElement?.closest<HTMLElement>(selector);
  if (ancestor) {
    candidates.add(ancestor);
  }
  for (const descendant of blockElement.querySelectorAll<HTMLElement>(selector)) {
    candidates.add(descendant);
  }
  if (candidates.size !== 1) {
    return `Narration block ${block.id} rendered ${candidates.size} structural surfaces; expected 1`;
  }
  return [...candidates][0];
}

function domLeavesForBlock(
  blockElement: HTMLElement,
  block: MarkdownNarrationBlock,
): NarrationDomLeaf[] | string {
  if (block.highlightMode === 'block') {
    return [];
  }
  const candidates = [...blockElement.querySelectorAll<HTMLElement>('[data-narration-text-start]')]
    .filter((element) => element.closest('[data-narration-block-id]') === blockElement)
    .map((element) => ({
      element,
      end: parseOffset(element.dataset.narrationTextEnd),
      kind: element.dataset.narrationLeafKind === 'element' ? 'element' as const : 'text' as const,
      start: parseOffset(element.dataset.narrationTextStart),
    }))
    .sort((left, right) => left.start - right.start || left.end - right.end);
  if (candidates.some((leaf) => leaf.start < 0 || leaf.end <= leaf.start || leaf.end > block.text.length)) {
    return `Narration block ${block.id} has invalid rendered leaf offsets`;
  }
  if (candidates.length !== block.leaves.length) {
    return `Narration block ${block.id} rendered ${candidates.length} leaves; expected ${block.leaves.length}`;
  }
  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index];
    const expected = block.leaves[index];
    if (
      candidate.start !== expected.start
      || candidate.end !== expected.end
      || candidate.kind !== expected.kind
    ) {
      return `Narration block ${block.id} rendered a mismatched text leaf`;
    }
    if (candidate.kind === 'text' && candidate.element.textContent !== expected.text) {
      return `Narration block ${block.id} rendered text that differs from its narration model`;
    }
  }
  return candidates;
}

function parseOffset(value: string | undefined) {
  if (!value || !/^\d+$/u.test(value)) {
    return -1;
  }
  return Number.parseInt(value, 10);
}

function invalidSnapshot(root: HTMLElement, sourceHash: string, error: string): NarrationDomSnapshot {
  return {
    blocks: new Map(),
    error,
    root,
    sourceHash,
    status: 'invalid',
  };
}

function idleSnapshot(): NarrationDomSnapshot {
  return {
    blocks: new Map(),
    error: null,
    root: null,
    sourceHash: null,
    status: 'idle',
  };
}

function publish(next: NarrationDomSnapshot) {
  snapshot = next;
  for (const listener of subscribers) {
    listener();
  }
}
