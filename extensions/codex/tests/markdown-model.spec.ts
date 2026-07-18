import { expect, test } from '@playwright/test';

import {
  cappedMarkdownLayoutDocumentHeight,
  getMarkdownLayoutDocument,
  markdownMetrics,
  narrationSourceBlocks,
  narrationSourceDocument,
  parseMarkdownDocument,
} from '../viewer/transcript/components/markdown/markdownModel';

if (typeof globalThis.OffscreenCanvas === 'undefined') {
  globalThis.OffscreenCanvas = class {
    constructor(_width: number, _height: number) {}

    getContext() {
      return {
        measureText: (text: string) => ({ width: text.length * 8 }),
      };
    }
  } as unknown as typeof OffscreenCanvas;
}

test.describe('markdownModel', () => {
  test('builds stable speakable block identities for complex Markdown', () => {
    const markdown = [
      '# Overview',
      '',
      'Plain prose.',
      '',
      '- First item',
      '- Second `item`',
      '',
      '> Quoted text.',
      '',
      '```ts',
      'const value = 1;',
      '```',
      '',
      '| Name | Price |',
      '| --- | ---: |',
      '| Plan | $5 |',
    ].join('\n');

    const first = narrationSourceBlocks(markdown);
    const second = narrationSourceBlocks(markdown);

    expect(second).toEqual(first);
    expect(first.map((block) => block.id)).toEqual([
      'md:0',
      'md:1',
      'md:2/list/0/0',
      'md:2/list/1/0',
      'md:3/blockquote/0',
      'md:4',
      'md:5',
    ]);
    expect(first.map((block) => block.kind)).toEqual([
      'heading',
      'paragraph',
      'listItem',
      'listItem',
      'blockquote',
      'code',
      'table',
    ]);
    expect(first.every((block) => !('needsTransform' in block))).toBe(true);
    expect(first.at(-1)).toMatchObject({ kind: 'table' });

    const document = narrationSourceDocument(markdown);
    expect(document).toMatchObject({
      offsetEncoding: 'utf16CodeUnit',
      schemaVersion: 1,
    });
    expect(document.blocks.map((block) => block.highlightMode)).toEqual([
      'text',
      'text',
      'text',
      'text',
      'text',
      'block',
      'block',
    ]);
    expect(Object.keys(document).sort()).toEqual(['blocks', 'offsetEncoding', 'schemaVersion']);
    expect(Object.keys(document.blocks[0]).sort()).toEqual(['highlightMode', 'id', 'kind', 'text']);
  });

  test('leaves word and expression alignment to the narration artifact', () => {
    const document = narrationSourceDocument(
      '`live_transcript.rs`: filters HTTP APIs and notification-only state.',
    );
    expect(document.blocks).toEqual([{
      highlightMode: 'text',
      id: 'md:0',
      kind: 'paragraph',
      text: 'live_transcript.rs: filters HTTP APIs and notification-only state.',
    }]);
  });

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

  test('classifies remux-mention links as file chips', () => {
    const blocks = parseMarkdownDocument(
      '[App.tsx](remux-mention://viewer/App.tsx) and [notes.md](remux-mention://my%20docs/notes.md) and [docs](remux-mention://docs/)',
    );

    expect(blocks[0]).toMatchObject({
      lines: [
        [
          {
            file: {
              displayName: 'App.tsx',
              extension: 'tsx',
              fileName: 'App.tsx',
              line: null,
              path: 'viewer/App.tsx',
            },
            href: 'remux-mention://viewer/App.tsx',
            type: 'fileLink',
          },
          { text: ' and ', type: 'text' },
          {
            file: {
              displayName: 'notes.md',
              extension: 'md',
              fileName: 'notes.md',
              line: null,
              path: 'my docs/notes.md',
            },
            href: 'remux-mention://my%20docs/notes.md',
            type: 'fileLink',
          },
          { text: ' and ', type: 'text' },
          {
            file: {
              displayName: 'docs',
              extension: null,
              fileName: 'docs',
              line: null,
              path: 'docs/',
            },
            href: 'remux-mention://docs/',
            type: 'fileLink',
          },
        ],
      ],
      type: 'paragraph',
    });
  });

  test('renders mention chips even when rich file links are disabled', () => {
    const blocks = parseMarkdownDocument('[App.tsx](remux-mention://viewer/App.tsx)', {
      richFileLinks: false,
    });

    expect(blocks[0]).toMatchObject({
      lines: [
        [
          {
            file: { path: 'viewer/App.tsx' },
            type: 'fileLink',
          },
        ],
      ],
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

  test('parses GFM tables into rows and cells with inline formatting', () => {
    const blocks = parseMarkdownDocument(gfmTableMarkdown());

    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({
      align: ['left', 'center', 'right'],
      rows: [
        {
          cells: [
            { lines: [[{ text: 'Projection shape', type: 'text' }]] },
            { lines: [[{ text: 'Cache representation', type: 'text' }]] },
            { lines: [[{ text: 'Delivery read', type: 'text' }]] },
          ],
          header: true,
        },
        {
          cells: [
            { lines: [[{ text: 'Bars', type: 'text' }]] },
            { lines: [[{ text: 'Append-only array + live value + status', type: 'text' }]] },
            { lines: [[{ text: 'Read only unseen bar suffix and latest live bar', type: 'text' }]] },
          ],
          header: false,
        },
        {
          cells: [
            { lines: [[{ text: 'Depth/DOM', type: 'text' }]] },
            { lines: [[{ text: 'Replaceable snapshot', type: 'text' }]] },
            {
              lines: [[
                { text: 'Clone an ', type: 'text' },
                { text: 'Arc<DepthSnapshot>', type: 'code' },
              ]],
            },
          ],
          header: false,
        },
      ],
      type: 'table',
    });
  });

  test('lays out table cells with deterministic PreText row heights', () => {
    const document = getMarkdownLayoutDocument(gfmTableMarkdown(), 'default', 360);
    const table = document.blocks[0];

    expect(table).toMatchObject({ type: 'table' });
    if (table?.type !== 'table') {
      throw new Error('Expected table block');
    }

    expect(table.tableWidth).toBeCloseTo(360, 5);
    expect(table.columnWidths).toHaveLength(3);
    expect(table.rows).toHaveLength(3);
    expect(table.rows.some((row) => row.lineCount > 1)).toBe(true);
    for (const row of table.rows) {
      expect(row.lineCount).toBe(Math.max(1, ...row.cells.map((cell) => cell.lines.length)));
      expect(row.height).toBe(
        row.lineCount * table.lineHeight +
          markdownMetrics.table.cellPaddingY * 2 +
          (row === table.rows.at(-1) ? 0 : markdownMetrics.table.borderWidth),
      );
    }
    expect(table.contentHeight).toBe(
      markdownMetrics.table.borderWidth * 2 +
        table.rows.reduce((total, row) => total + row.height, 0),
    );
    expect(document.height).toBe(table.contentHeight);
    expect(cappedMarkdownLayoutDocumentHeight(document, 1)).toBe(
      markdownMetrics.table.borderWidth +
        markdownMetrics.table.cellPaddingY +
        table.lineHeight,
    );
    expect(cappedMarkdownLayoutDocumentHeight(document, 2)).toBeLessThan(document.height);
  });

  test('uses horizontal overflow when minimum table columns exceed the content width', () => {
    const document = getMarkdownLayoutDocument(gfmTableMarkdown(), 'default', 220);
    const table = document.blocks[0];

    expect(table).toMatchObject({ type: 'table' });
    if (table?.type !== 'table') {
      throw new Error('Expected table block');
    }

    expect(table.columnWidths).toEqual([
      markdownMetrics.table.minColumnWidth,
      markdownMetrics.table.minColumnWidth,
      markdownMetrics.table.minColumnWidth,
    ]);
    expect(table.tableWidth).toBeGreaterThan(document.width);
  });

  test('measures long file chips at the same capped width used by the renderer', () => {
    const label = `RPC concurrency and mobile transport resilience ${'details '.repeat(8).trim()}`;
    const document = getMarkdownLayoutDocument(
      `[${label}](/tmp/specs/rpc-concurrency.md) then`,
      'default',
      340,
    );
    const paragraph = document.blocks[0];

    expect(paragraph).toMatchObject({ type: 'paragraph' });
    if (paragraph?.type !== 'paragraph') {
      throw new Error('Expected paragraph block');
    }

    expect(paragraph.lines).toHaveLength(1);
    expect(paragraph.lines[0]?.width).toBeGreaterThan(markdownMetrics.fileLink.maxWidth);
    expect(paragraph.lines[0]?.width).toBeLessThan(340);
    expect(paragraph.lines[0]?.fragments[0]).toMatchObject({
      source: { kind: 'fileLink' },
      text: label,
    });
  });

  test('keeps rendered fragment ranges aligned with display text across collapsed whitespace', () => {
    const fixtures = [
      '**Bold** next word after emphasis',
      '[Linked](https://example.com) next word after link',
      '`inlineCode` next word after code',
      '[app.ts](src/app.ts) next word after file chip',
      'alpha    beta\tgamma delta',
      'café 😀alpha beta repeated beta',
    ];

    for (const markdown of fixtures) {
      for (const width of [110, 170, 280]) {
        const document = getMarkdownLayoutDocument(markdown, 'default', width);
        const sourceById = new Map(narrationSourceBlocks(markdown).map((block) => [block.id, block]));
        for (const block of document.blocks) {
          if (block.type !== 'paragraph' && block.type !== 'heading') continue;
          const sourceText = sourceById.get(block.narrationId)?.text;
          expect(sourceText).toBeDefined();
          for (const line of block.lines) {
            for (const fragment of line.fragments) {
              expect(
                sourceText!.slice(fragment.displayStart, fragment.displayEnd),
                `${JSON.stringify(markdown)} at ${width}px range ${fragment.displayStart}-${fragment.displayEnd}`,
              ).toBe(fragment.text);
            }
          }
        }
      }
    }
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

function gfmTableMarkdown() {
  return [
    '| Projection shape | Cache representation | Delivery read |',
    '| :--- | :---: | ---: |',
    '| Bars | Append-only array + live value + status | Read only unseen bar suffix and latest live bar |',
    '| Depth/DOM | Replaceable snapshot | Clone an `Arc<DepthSnapshot>` |',
  ].join('\n');
}
