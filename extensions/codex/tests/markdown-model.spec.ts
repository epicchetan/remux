import { expect, test } from '@playwright/test';

import {
  getMarkdownLayoutDocument,
  markdownMetrics,
  parseMarkdownDocument,
} from '../viewer/transcript/components/markdown/markdownModel';

test.describe('markdownModel', () => {
  test('ends an ordered list before following unindented paragraphs', () => {
    const blocks = parseMarkdownDocument(
      [
        '1. First item',
        '2. Second item',
        '',
        'This paragraph should not be indented.',
        '',
        'Nor should this one.',
      ].join('\n'),
    );

    expect(blocks.map((block) => block.type)).toEqual(['list', 'paragraph', 'paragraph']);
    expect(blocks[0]).toMatchObject({
      items: [
        { marker: '1.', blocks: [{ type: 'paragraph' }] },
        { marker: '2.', blocks: [{ type: 'paragraph' }] },
      ],
      ordered: true,
      type: 'list',
    });
  });

  test('keeps indented loose paragraphs inside list items', () => {
    const blocks = parseMarkdownDocument(
      [
        '1. First item',
        '',
        '   Still inside the first item.',
        '',
        'Outside the list.',
      ].join('\n'),
    );

    expect(blocks.map((block) => block.type)).toEqual(['list', 'paragraph']);
    expect(blocks[0]).toMatchObject({
      items: [
        {
          blocks: [{ type: 'paragraph' }, { type: 'paragraph' }],
          marker: '1.',
        },
      ],
      type: 'list',
    });
  });

  test('preserves nested lists as child list blocks', () => {
    const blocks = parseMarkdownDocument(['- Parent', '  - Child', '', 'Next paragraph.'].join('\n'));

    expect(blocks.map((block) => block.type)).toEqual(['list', 'paragraph']);
    expect(blocks[0]).toMatchObject({
      items: [
        {
          blocks: [
            { type: 'paragraph' },
            {
              items: [{ blocks: [{ type: 'paragraph' }], marker: '•' }],
              type: 'list',
            },
          ],
          marker: '•',
        },
      ],
      type: 'list',
    });
  });

  test('autolinks plain http urls in text nodes', () => {
    const blocks = parseMarkdownDocument('Visit https://example.com/docs.');

    expect(blocks[0]).toMatchObject({
      lines: [
        [
          { text: 'Visit ', type: 'text' },
          {
            children: [{ text: 'https://example.com/docs', type: 'text' }],
            href: 'https://example.com/docs',
            type: 'link',
          },
          { text: '.', type: 'text' },
        ],
      ],
      type: 'paragraph',
    });
  });

  test('does not autolink inside existing markdown links or inline code', () => {
    const blocks = parseMarkdownDocument('[docs https://example.com](https://example.com) and `https://example.com/code`');

    expect(blocks[0]).toMatchObject({
      lines: [
        [
          {
            children: [{ text: 'docs https://example.com', type: 'text' }],
            href: 'https://example.com/',
            type: 'link',
          },
          { text: ' and ', type: 'text' },
          { text: 'https://example.com/code', type: 'code' },
        ],
      ],
      type: 'paragraph',
    });
  });

  test('classifies local markdown links as file links and preserves compact labels', () => {
    const blocks = parseMarkdownDocument(
      '[apps/web/src/styles.css](/Users/calla/Documents/remote-in/mobile/apps/web/src/styles.css:38) and ' +
        '[rollout jsonl](/Users/calla/.codex/sessions/2026/05/11/rollout-2026-05-11T16-08-33-019e18a7-d941-7940-bcc2-0f12906bbf03.jsonl:5323) and ' +
        '[docs](https://example.com/docs)',
    );

    expect(blocks[0]).toMatchObject({
      lines: [
        [
          {
            file: {
              displayName: 'styles.css (line 38)',
              extension: 'css',
              fileName: 'styles.css',
              line: 38,
              path: '/Users/calla/Documents/remote-in/mobile/apps/web/src/styles.css',
            },
            href: '/Users/calla/Documents/remote-in/mobile/apps/web/src/styles.css:38',
            type: 'fileLink',
          },
          { text: ' and ', type: 'text' },
          {
            file: {
              displayName: 'rollout jsonl (line 5323)',
              extension: 'jsonl',
              fileName: 'rollout-2026-05-11T16-08-33-019e18a7-d941-7940-bcc2-0f12906bbf03.jsonl',
              line: 5323,
              path: '/Users/calla/.codex/sessions/2026/05/11/rollout-2026-05-11T16-08-33-019e18a7-d941-7940-bcc2-0f12906bbf03.jsonl',
            },
            href: '/Users/calla/.codex/sessions/2026/05/11/rollout-2026-05-11T16-08-33-019e18a7-d941-7940-bcc2-0f12906bbf03.jsonl:5323',
            type: 'fileLink',
          },
          { text: ' and ', type: 'text' },
          {
            children: [{ text: 'docs', type: 'text' }],
            href: 'https://example.com/docs',
            type: 'link',
          },
        ],
      ],
      type: 'paragraph',
    });
  });

  test('classifies file urls and local hash line anchors as file links', () => {
    const blocks = parseMarkdownDocument(
      '[App](file:///workspace/remux/src/App.tsx#L12) and [Guide](./docs/Guide.md#line-7)',
    );

    expect(blocks[0]).toMatchObject({
      lines: [
        [
          {
            file: {
              displayName: 'App (line 12)',
              extension: 'tsx',
              fileName: 'App.tsx',
              line: 12,
              path: '/workspace/remux/src/App.tsx',
            },
            href: 'file:///workspace/remux/src/App.tsx#L12',
            type: 'fileLink',
          },
          { text: ' and ', type: 'text' },
          {
            file: {
              displayName: 'Guide (line 7)',
              extension: 'md',
              fileName: 'Guide.md',
              line: 7,
              path: 'docs/Guide.md',
            },
            href: './docs/Guide.md#line-7',
            type: 'fileLink',
          },
        ],
      ],
      type: 'paragraph',
    });
  });

  test('can keep local markdown links plain while streaming', () => {
    const blocks = parseMarkdownDocument(
      '[apps/web/src/styles.css](/Users/calla/Documents/remote-in/mobile/apps/web/src/styles.css:38)',
      { richFileLinks: false },
    );

    expect(blocks[0]).toMatchObject({
      lines: [
        [
          {
            children: [{ text: 'apps/web/src/styles.css', type: 'text' }],
            href: '/Users/calla/Documents/remote-in/mobile/apps/web/src/styles.css:38',
            type: 'link',
          },
        ],
      ],
      type: 'paragraph',
    });
  });

  test('preserves fenced code language metadata', () => {
    const blocks = parseMarkdownDocument(['```ts', 'const answer = 42;', '```'].join('\n'));

    expect(blocks[0]).toMatchObject({
      language: 'ts',
      text: 'const answer = 42;',
      type: 'code',
    });
  });

  test('lays out a long fenced code line as one logical line at narrow width', () => {
    const document = getMarkdownLayoutDocument(
      ['```ts', `const value = '${'x'.repeat(180)}';`, '```'].join('\n'),
      'default',
      120,
    );
    const codeBlock = document.blocks[0];

    expect(codeBlock).toMatchObject({ type: 'code' });
    if (codeBlock?.type !== 'code') {
      throw new Error('Expected code block');
    }
    expect(codeBlock.lines).toHaveLength(1);
    expect(codeBlock.textHeight).toBe(markdownMetrics.code.lineHeight.default);
    expect(codeBlock.contentHeight).toBe(codeBlock.naturalOuterHeight);
  });

  test('lays out multi-line fenced code from logical line count', () => {
    const document = getMarkdownLayoutDocument(['```ts', 'a();', '', 'b();', '```'].join('\n'), 'default', 360);
    const codeBlock = document.blocks[0];

    expect(codeBlock).toMatchObject({ type: 'code' });
    if (codeBlock?.type !== 'code') {
      throw new Error('Expected code block');
    }
    expect(codeBlock.lines.map((line) => line.text)).toEqual(['a();', '', 'b();']);
    expect(codeBlock.textHeight).toBe(markdownMetrics.code.lineHeight.default * 3);
    expect(codeBlock.naturalOuterHeight).toBe(
      markdownMetrics.code.lineHeight.default * 3 +
        markdownMetrics.code.paddingY * 2 +
        markdownMetrics.code.borderWidth * 2,
    );
  });

  test('renders empty fenced code as one blank logical line', () => {
    const document = getMarkdownLayoutDocument(['```', '```'].join('\n'), 'default', 360);
    const codeBlock = document.blocks[0];

    expect(codeBlock).toMatchObject({ type: 'code' });
    if (codeBlock?.type !== 'code') {
      throw new Error('Expected code block');
    }
    expect(codeBlock.lines).toEqual([{ text: '' }]);
    expect(codeBlock.textHeight).toBe(markdownMetrics.code.lineHeight.default);
  });

  test('clamps tall fenced code blocks to cap height', () => {
    const document = getMarkdownLayoutDocument(
      ['```text', ...Array.from({ length: 40 }, (_, index) => `line ${index}`), '```'].join('\n'),
      'default',
      360,
    );
    const codeBlock = document.blocks[0];

    expect(codeBlock).toMatchObject({ type: 'code' });
    if (codeBlock?.type !== 'code') {
      throw new Error('Expected code block');
    }
    expect(codeBlock.naturalOuterHeight).toBeGreaterThan(markdownMetrics.code.capHeight.default);
    expect(codeBlock.contentHeight).toBe(markdownMetrics.code.capHeight.default);
  });

});
