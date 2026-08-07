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
