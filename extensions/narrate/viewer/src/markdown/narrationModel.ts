import type {
  NarrationBlockKind,
  NarrationHighlightMode,
  NarrationSourceDocument,
} from '@remux/narration-client/protocol';
import type { Element, Root, RootContent, Text } from 'hast';
import remarkParse from 'remark-parse';
import remarkRehype from 'remark-rehype';
import { unified } from 'unified';

import {
  markdownRehypePlugins,
  markdownRemarkPlugins,
} from './markdownPipeline';

export type MarkdownNarrationLeaf = {
  end: number;
  kind: 'element' | 'text';
  renderKey: string;
  start: number;
  text: string;
};

export type MarkdownNarrationBlock = {
  highlightMode: NarrationHighlightMode;
  id: string;
  kind: NarrationBlockKind;
  leaves: MarkdownNarrationLeaf[];
  renderKey: string;
  text: string;
};

export type MarkdownNarrationModel = {
  blocks: MarkdownNarrationBlock[];
  document: NarrationSourceDocument;
  sourceHash: string;
};

type ProjectionContext = {
  blockquote: boolean;
  listItem: boolean;
};

type LogicalText = {
  leaves: MarkdownNarrationLeaf[];
  text: string;
};

type ProjectedBlock = Omit<MarkdownNarrationBlock, 'id'>;

const markdownNarrationProcessor = unified()
  .use(remarkParse)
  .use(markdownRemarkPlugins)
  .use(remarkRehype, { allowDangerousHtml: true })
  .use(markdownRehypePlugins);

export class MarkdownNarrationModelError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MarkdownNarrationModelError';
  }
}

export function buildMarkdownNarrationModel(markdown: string): MarkdownNarrationModel {
  const parsed = markdownNarrationProcessor.parse(markdown);
  const tree = markdownNarrationProcessor.runSync(parsed) as Root;
  const blocks = projectMarkdownNarrationTree(tree);
  const document: NarrationSourceDocument = {
    blocks: blocks.map(({ highlightMode, id, kind, text }) => ({
      highlightMode,
      id,
      kind,
      text,
    })),
    offsetEncoding: 'utf16CodeUnit',
    schemaVersion: 1,
  };
  validateMarkdownNarrationModel(blocks, document);
  return {
    blocks,
    document,
    sourceHash: narrationSourceHash(markdown),
  };
}

export function projectMarkdownNarrationTree(tree: Root): MarkdownNarrationBlock[] {
  const projected: ProjectedBlock[] = [];
  collectNarrationBlocks(tree, [], { blockquote: false, listItem: false }, projected);
  return projected.map((block, index) => ({
    ...block,
    id: `md:${index}`,
  }));
}

function collectNarrationBlocks(
  node: Root | Element,
  path: number[],
  context: ProjectionContext,
  output: ProjectedBlock[],
) {
  node.children.forEach((child, index) => {
    if (!isElement(child)) {
      return;
    }

    const childPath = [...path, index];
    if (isDisplayMath(child)) {
      pushStructuralBlock(child, childPath, 'code', displayMathText(child), output);
      return;
    }
    if (child.tagName === 'pre') {
      const code = firstElementChild(child, 'code');
      if (code) {
        const language = languageFromElement(code);
        pushStructuralBlock(
          child,
          childPath,
          language === 'mermaid' ? 'diagram' : 'code',
          stripSingleTrailingNewline(nodeText(code)),
          output,
        );
        return;
      }
    }
    if (child.tagName === 'table') {
      pushStructuralBlock(child, childPath, 'table', tableText(child), output);
      return;
    }
    if (/^h[1-6]$/u.test(child.tagName)) {
      pushTextBlock(child, childPath, 'heading', output);
      return;
    }
    if (child.tagName === 'p') {
      pushTextBlock(
        child,
        childPath,
        context.blockquote ? 'blockquote' : context.listItem ? 'listItem' : 'paragraph',
        output,
      );
      return;
    }
    if (child.tagName === 'blockquote') {
      collectNarrationBlocks(child, childPath, { ...context, blockquote: true }, output);
      return;
    }
    if (child.tagName === 'li') {
      collectListItemBlocks(child, childPath, context, output);
      return;
    }

    collectNarrationBlocks(child, childPath, context, output);
  });
}

function collectListItemBlocks(
  item: Element,
  path: number[],
  context: ProjectionContext,
  output: ProjectedBlock[],
) {
  const hasDirectParagraph = item.children.some((child) => isElement(child) && child.tagName === 'p');
  if (!hasDirectParagraph) {
    const directPhrasing = item.children
      .map((node, index) => ({ node, path: [...path, index] }))
      .filter(({ node }) => !isListItemBlockChild(node));
    const logical = logicalTextFromNodes(directPhrasing);
    if (logical.text.trim()) {
      output.push({
        highlightMode: 'text',
        kind: context.blockquote ? 'blockquote' : 'listItem',
        leaves: logical.leaves,
        renderKey: renderKey(path),
        text: logical.text,
      });
    }
  }

  collectNarrationBlocks(item, path, { ...context, listItem: true }, output);
}

function isListItemBlockChild(node: RootContent) {
  if (!isElement(node)) {
    return false;
  }
  return node.tagName === 'p'
    || node.tagName === 'ul'
    || node.tagName === 'ol'
    || node.tagName === 'blockquote'
    || node.tagName === 'pre'
    || node.tagName === 'table'
    || isDisplayMath(node);
}

function pushTextBlock(
  element: Element,
  path: number[],
  kind: Extract<NarrationBlockKind, 'blockquote' | 'heading' | 'listItem' | 'paragraph'>,
  output: ProjectedBlock[],
) {
  const logical = logicalTextFromNodes(element.children.map((node, index) => ({
    node,
    path: [...path, index],
  })));
  if (!logical.text.trim()) {
    return;
  }
  output.push({
    highlightMode: 'text',
    kind,
    leaves: logical.leaves,
    renderKey: renderKey(path),
    text: logical.text,
  });
}

function pushStructuralBlock(
  element: Element,
  path: number[],
  kind: Extract<NarrationBlockKind, 'code' | 'diagram' | 'table'>,
  text: string,
  output: ProjectedBlock[],
) {
  if (!text.trim()) {
    return;
  }
  output.push({
    highlightMode: 'block',
    kind,
    leaves: [],
    renderKey: renderKey(path),
    text,
  });
}

function logicalTextFromNodes(entries: Array<{ node: RootContent; path: number[] }>): LogicalText {
  let text = '';
  const leaves: MarkdownNarrationLeaf[] = [];

  const append = (value: string, kind: MarkdownNarrationLeaf['kind'], path: number[]) => {
    if (!value) {
      return;
    }
    const start = text.length;
    text += value;
    leaves.push({
      end: text.length,
      kind,
      renderKey: renderKey(path),
      start,
      text: value,
    });
  };

  const walk = (node: RootContent, path: number[]) => {
    if (isText(node)) {
      append(node.value, 'text', path);
      return;
    }
    if (!isElement(node) || shouldIgnoreInlineElement(node)) {
      return;
    }
    if (node.tagName === 'br') {
      text += '\n';
      return;
    }
    if (hasClass(node, 'katex')) {
      const tex = katexAnnotation(node);
      if (tex) {
        append(tex, 'element', path);
      }
      return;
    }
    node.children.forEach((child, index) => walk(child, [...path, index]));
  };

  entries.forEach(({ node, path }) => walk(node, path));
  return { leaves, text };
}

function shouldIgnoreInlineElement(element: Element) {
  if (element.tagName === 'img' || element.tagName === 'input') {
    return true;
  }
  if (element.properties?.ariaHidden === true || element.properties?.ariaHidden === 'true') {
    return true;
  }
  return Boolean(element.properties?.dataFootnoteBackref)
    || hasClass(element, 'data-footnote-backref');
}

function tableText(table: Element) {
  const rows: string[] = [];
  walkElements(table, (element) => {
    if (element.tagName !== 'tr') {
      return;
    }
    const cells = element.children
      .filter((child): child is Element => isElement(child) && (child.tagName === 'th' || child.tagName === 'td'))
      .map((cell) => logicalTextFromNodes(cell.children.map((node, index) => ({
        node,
        path: [index],
      }))).text);
    if (cells.length > 0) {
      rows.push(cells.join(' | '));
    }
  });
  return rows.join('\n');
}

function displayMathText(element: Element) {
  return katexAnnotation(element) || nodeText(element).trim();
}

function katexAnnotation(element: Element) {
  let annotation = '';
  walkElements(element, (candidate) => {
    if (!annotation && candidate.tagName === 'annotation') {
      annotation = nodeText(candidate);
    }
  });
  return annotation;
}

function isDisplayMath(element: Element) {
  return hasClass(element, 'math-display') || hasClass(element, 'katex-display');
}

function languageFromElement(element: Element) {
  for (const className of classNames(element)) {
    const match = /^language-([\w-]+)$/u.exec(className);
    if (match) {
      return match[1].toLowerCase();
    }
  }
  return null;
}

function classNames(element: Element) {
  const value = element.properties?.className;
  if (Array.isArray(value)) {
    return value.map(String);
  }
  return typeof value === 'string' ? value.split(/\s+/u) : [];
}

function hasClass(element: Element, className: string) {
  return classNames(element).includes(className);
}

function firstElementChild(element: Element, tagName: string) {
  return element.children.find((child): child is Element => isElement(child) && child.tagName === tagName) ?? null;
}

function walkElements(element: Element, visit: (element: Element) => void) {
  visit(element);
  for (const child of element.children) {
    if (isElement(child)) {
      walkElements(child, visit);
    }
  }
}

function nodeText(node: RootContent | Root): string {
  if (isText(node)) {
    return node.value;
  }
  if ('children' in node) {
    return node.children.map(nodeText).join('');
  }
  return '';
}

function renderKey(path: number[]) {
  return path.join('/');
}

function isElement(node: RootContent): node is Element {
  return node.type === 'element';
}

function isText(node: RootContent | Root): node is Text {
  return node.type === 'text';
}

function stripSingleTrailingNewline(value: string) {
  return value.replace(/\n$/u, '');
}

function validateMarkdownNarrationModel(
  blocks: MarkdownNarrationBlock[],
  document: NarrationSourceDocument,
) {
  if (document.schemaVersion !== 1 || document.offsetEncoding !== 'utf16CodeUnit') {
    throw new MarkdownNarrationModelError('Narration document uses an unsupported schema');
  }
  const ids = new Set<string>();
  for (const block of blocks) {
    if (!block.id || ids.has(block.id)) {
      throw new MarkdownNarrationModelError(`Narration block id is invalid: ${block.id || '<empty>'}`);
    }
    ids.add(block.id);
    if (!block.text.trim()) {
      throw new MarkdownNarrationModelError(`Narration block ${block.id} is empty`);
    }
    let cursor = 0;
    for (const leaf of block.leaves) {
      if (
        leaf.start < cursor
        || leaf.end <= leaf.start
        || leaf.end > block.text.length
        || block.text.slice(leaf.start, leaf.end) !== leaf.text
      ) {
        throw new MarkdownNarrationModelError(`Narration block ${block.id} has an invalid text leaf`);
      }
      cursor = leaf.end;
    }
    if (block.highlightMode === 'text') {
      for (let index = 0; index < block.text.length; index += 1) {
        if (!/[\p{Letter}\p{Number}]/u.test(block.text[index])) {
          continue;
        }
        if (!block.leaves.some((leaf) => leaf.start <= index && index < leaf.end)) {
          throw new MarkdownNarrationModelError(
            `Narration block ${block.id} has unbound logical text at offset ${index}`,
          );
        }
      }
    }
  }
}

export function narrationSourceHash(text: string) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}
