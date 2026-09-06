import assert from 'node:assert/strict';
import { test } from '@playwright/test';

import {
  cappedMarkdownLayoutDocumentHeight,
  getMarkdownLayoutDocument,
  markdownMetrics,
  parseMarkdownDocument,
} from '../../viewer/src/transcript/components/markdown/markdownModel.ts';

if (typeof globalThis.OffscreenCanvas === 'undefined') {
  globalThis.OffscreenCanvas = class {
    constructor(_width: number, _height: number) {}

    getContext() {
      return { measureText: (text: string) => ({ width: text.length * 8 }) };
    }
  } as unknown as typeof OffscreenCanvas;
}

test('keeps nested and trailing Markdown blocks structurally distinct', () => {
  const blocks = parseMarkdownDocument([
    '1. First item',
    '   - Nested item',
    '',
    'Outside the list.',
  ].join('\n'));

  assert.deepEqual(blocks.map((block) => block.type), ['list', 'paragraph']);
  const list = blocks[0];
  assert.equal(list?.type, 'list');
  if (list?.type !== 'list') return;
  assert.equal(list.renderId, 'md:0');
  assert.equal(list.ordered, true);
  assert.equal(list.items[0]?.marker, '1.');
  assert.deepEqual(list.items[0]?.blocks.map((block) => block.type), ['paragraph', 'list']);
  const nested = list.items[0]?.blocks[1];
  assert.equal(nested?.type, 'list');
  if (nested?.type === 'list') {
    assert.equal(nested.items[0]?.marker, '•');
    assert.equal(nested.items[0]?.blocks[0]?.renderId, 'md:0/list/0/1/list/0/0');
  }
});

test('classifies web links, inline code, and local file links independently', () => {
  const blocks = parseMarkdownDocument(
    'Visit https://example.com/docs, inspect `https://example.com/raw`, then open [source](src/index.ts#L12).',
  );
  const paragraph = blocks[0];
  assert.equal(paragraph?.type, 'paragraph');
  const line = paragraph?.type === 'paragraph' ? paragraph.lines[0] : [];
  assert.ok(line?.some((inline) => inline.type === 'link' && inline.href === 'https://example.com/docs'));
  assert.ok(line?.some((inline) => inline.type === 'code' && inline.text === 'https://example.com/raw'));
  assert.ok(line?.some((inline) => inline.type === 'fileLink' && inline.file.path === 'src/index.ts' && inline.file.line === 12));
});

test('preserves provider reasoning summary boundaries without changing ordinary Markdown soft breaks', () => {
  const markdown = '**Analyzing flexbox shrink behavior**\n**Reviewing button group sizing details**';
  const ordinary = parseMarkdownDocument(markdown);
  const reasoning = parseMarkdownDocument(markdown, { preserveSoftBreaks: true });
  const ordinaryParagraph = ordinary[0];
  const reasoningParagraph = reasoning[0];

  assert.equal(ordinaryParagraph?.type, 'paragraph');
  assert.equal(reasoningParagraph?.type, 'paragraph');
  if (ordinaryParagraph?.type !== 'paragraph' || reasoningParagraph?.type !== 'paragraph') return;
  assert.equal(ordinaryParagraph.lines.length, 1);
  assert.equal(reasoningParagraph.lines.length, 2);

  const layout = getMarkdownLayoutDocument(markdown, 'work', 640, { preserveSoftBreaks: true });
  assert.equal(layout.height, markdownMetrics.paragraph.lineHeight.work * 2);
});

test('lays out GFM tables and clamps tall fenced code', () => {
  const markdown = [
    '| Name | State |',
    '| --- | --- |',
    '| Agent | ready |',
    '',
    '```ts',
    ...Array.from({ length: 40 }, (_, index) => `const line${index} = ${index};`),
    '```',
  ].join('\n');
  const layout = getMarkdownLayoutDocument(markdown, 'default', 420);
  const table = layout.blocks.find((block) => block.type === 'table');
  const code = layout.blocks.find((block) => block.type === 'code');

  assert.ok(table?.type === 'table' && table.rows.length === 2);
  assert.ok(code?.type === 'code');
  assert.equal(code?.contentHeight, markdownMetrics.code.capHeight.default);
  assert.ok(cappedMarkdownLayoutDocumentHeight(layout, 3) < layout.height);
});

test('classifies only explicitly closed Mermaid fences as diagrams', () => {
  const cases = [
    ['```mermaid\n```', ''],
    ['```mermaid\n\n```', ''],
    ['```mermaid\ngraph TD\nA-->B\n```', 'graph TD\nA-->B'],
    ['```mermaid\ngraph TD\nA-->B\n\n```', 'graph TD\nA-->B\n'],
    ['~~~~mermaid\r\ngraph LR\r\nA-->B\r\n~~~~~', 'graph LR\r\nA-->B'],
    ['> ```mermaid\n> graph TD\n> A-->B\n> ```', 'graph TD\nA-->B'],
    ['- diagram:\n\n  ```mermaid\n  graph TD\n  A-->B\n  ```', 'graph TD\nA-->B'],
  ] as const;

  for (const [markdown, expectedText] of cases) {
    const findDiagram = (blocks: ReturnType<typeof parseMarkdownDocument>): Extract<(typeof blocks)[number], { type: 'diagram' }> | null => {
      for (const block of blocks) {
        if (block.type === 'diagram') return block;
        if (block.type === 'blockquote') {
          const nested = findDiagram(block.children);
          if (nested) return nested;
        }
        if (block.type === 'list') {
          for (const item of block.items) {
            const nested = findDiagram(item.blocks);
            if (nested) return nested;
          }
        }
      }
      return null;
    };
    const diagram = findDiagram(parseMarkdownDocument(markdown));
    assert.equal(diagram?.text, expectedText);
  }

  for (const markdown of [
    '```mermaid\ngraph TD\nA-->B',
    '```mermaid\ngraph TD\n> ```',
    '```mermaid\ngraph TD\n    ```',
    '```\ngraph TD\nA-->B\n```',
    '```mermaid\ngraph TD\nA-->B\n~~`',
  ]) {
    assert.equal(parseMarkdownDocument(markdown).some((block) => block.type === 'diagram'), false);
    assert.equal(parseMarkdownDocument(markdown)[0]?.type, 'code');
  }
});

test('uses stable bounded geometry and cached identity for Mermaid diagrams', () => {
  const markdown = '```mermaid\ngraph TD\nA-->B\n```';
  const narrow = getMarkdownLayoutDocument(markdown, 'default', 300);
  const wide = getMarkdownLayoutDocument(markdown, 'default', 1000);
  const cached = getMarkdownLayoutDocument(markdown, 'default', 300);
  const narrowDiagram = narrow.blocks[0];
  const wideDiagram = wide.blocks[0];

  assert.equal(narrow, cached);
  assert.equal(narrowDiagram?.type, 'diagram');
  assert.equal(wideDiagram?.type, 'diagram');
  if (narrowDiagram?.type !== 'diagram' || wideDiagram?.type !== 'diagram') return;
  assert.equal(narrowDiagram.renderId, 'md:0');
  assert.equal(narrowDiagram.contentHeight, markdownMetrics.diagram.minHeight);
  assert.equal(narrowDiagram.height, narrowDiagram.topGap + narrowDiagram.contentHeight);
  assert.equal(wideDiagram.contentHeight, markdownMetrics.diagram.maxHeight);
  assert.equal(wideDiagram.height, wideDiagram.topGap + wideDiagram.contentHeight);
});
