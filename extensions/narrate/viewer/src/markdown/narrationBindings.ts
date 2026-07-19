import type { Element, Root, RootContent, Text } from 'hast';
import type { Plugin } from 'unified';

import {
  projectMarkdownNarrationTree,
  type MarkdownNarrationModel,
} from './narrationModel';

export type NarrationBindingOptions = {
  model: MarkdownNarrationModel;
};

export const rehypeNarrationBindings: Plugin<[NarrationBindingOptions], Root> = ({ model }) => (
  (tree: Root) => {
    const candidate = projectMarkdownNarrationTree(tree);
    const error = candidateBindingError(candidate, model);
    if (error) {
      const firstElement = tree.children.find(isElement);
      if (firstElement) {
        firstElement.properties = {
          ...firstElement.properties,
          dataNarrationBindingError: error,
        };
      }
      return;
    }

    for (const block of model.blocks) {
      const blockNode = nodeAtRenderKey(tree, block.renderKey);
      if (!isElement(blockNode)) {
        continue;
      }
      blockNode.properties = {
        ...blockNode.properties,
        dataNarrationBlockId: block.id,
        dataNarrationSurface: block.highlightMode,
      };

      for (const leaf of block.leaves) {
        const node = nodeAtRenderKey(tree, leaf.renderKey);
        if (leaf.kind === 'element' && isElement(node)) {
          node.properties = {
            ...node.properties,
            dataNarrationLeafKind: 'element',
            dataNarrationTextEnd: leaf.end,
            dataNarrationTextStart: leaf.start,
          };
          continue;
        }
        if (leaf.kind === 'text' && isText(node)) {
          wrapTextNode(tree, leaf.renderKey, {
            end: leaf.end,
            start: leaf.start,
          });
        }
      }
    }
  }
);

function candidateBindingError(
  candidate: ReturnType<typeof projectMarkdownNarrationTree>,
  model: MarkdownNarrationModel,
) {
  if (candidate.length !== model.blocks.length) {
    return `Narration renderer produced ${candidate.length} blocks; expected ${model.blocks.length}`;
  }
  for (let index = 0; index < candidate.length; index += 1) {
    const left = candidate[index];
    const right = model.blocks[index];
    if (
      left.id !== right.id
      || left.kind !== right.kind
      || left.highlightMode !== right.highlightMode
      || left.text !== right.text
      || left.renderKey !== right.renderKey
      || JSON.stringify(left.leaves) !== JSON.stringify(right.leaves)
    ) {
      return `Narration renderer block ${index} does not match its source model`;
    }
  }
  return null;
}

function wrapTextNode(
  tree: Root,
  key: string,
  range: { end: number; start: number },
) {
  const path = pathFromRenderKey(key);
  const childIndex = path.at(-1);
  const parentPath = path.slice(0, -1);
  const parent = nodeAtPath(tree, parentPath);
  if (childIndex === undefined || !parent || !('children' in parent)) {
    return;
  }
  const node = parent.children[childIndex];
  if (!isText(node)) {
    return;
  }
  const wrapper: Element = {
    children: [node],
    properties: {
      dataNarrationLeafKind: 'text',
      dataNarrationTextEnd: range.end,
      dataNarrationTextStart: range.start,
    },
    tagName: 'span',
    type: 'element',
  };
  if (node.position) {
    wrapper.position = node.position;
  }
  parent.children[childIndex] = wrapper;
}

function nodeAtRenderKey(tree: Root, key: string) {
  return nodeAtPath(tree, pathFromRenderKey(key));
}

function pathFromRenderKey(key: string) {
  if (!key) {
    return [];
  }
  return key.split('/').map((part) => Number.parseInt(part, 10));
}

function nodeAtPath(tree: Root, path: number[]): RootContent | Root | null {
  let node: RootContent | Root = tree;
  for (const index of path) {
    if (!('children' in node) || index < 0 || index >= node.children.length) {
      return null;
    }
    node = node.children[index];
  }
  return node;
}

function isElement(node: RootContent | Root | null | undefined): node is Element {
  return node?.type === 'element';
}

function isText(node: RootContent | Root | null | undefined): node is Text {
  return node?.type === 'text';
}
