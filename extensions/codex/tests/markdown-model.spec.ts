import { expect, test } from '@playwright/test';

import {
  cappedMarkdownLayoutDocumentHeight,
  getMarkdownLayoutDocument,
  markdownMetrics,
  narrationSourceBlocks,
  narrationSourceDocument,
  parseMarkdownDocument,
  type MarkdownInline,
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

  test('parses backslash and dollar display math as measured structural blocks', () => {
    const observedPrice = [
      'Before.',
      '',
      '\\[',
      '\\text{observed price} = \\text{slow reference} + \\text{temporary',
      'impact} + \\text{new information}',
      '\\]',
      '',
      'After.',
      '',
      '$$E = mc^2$$',
    ].join('\n');
    const blocks = parseMarkdownDocument(observedPrice);

    expect(blocks.map((block) => block.type)).toEqual([
      'paragraph',
      'mathDisplay',
      'paragraph',
      'mathDisplay',
    ]);
    expect(blocks[1]).toMatchObject({
      math: {
        delimiter: 'backslashDisplay',
        tex: expect.stringContaining('\\text{temporary\nimpact}'),
      },
      type: 'mathDisplay',
    });
    expect(blocks[3]).toMatchObject({
      math: { delimiter: 'dollarDisplay', tex: 'E = mc^2' },
      type: 'mathDisplay',
    });

    const narration = narrationSourceBlocks(observedPrice);
    expect(narration.map((block) => block.kind)).toEqual([
      'paragraph',
      'code',
      'paragraph',
      'code',
    ]);
    expect(narration[1]?.text).toContain('\\text{observed price}');

    const layout = getMarkdownLayoutDocument(observedPrice, 'default', 360);
    const displayBlocks = layout.blocks.filter((block) => block.type === 'mathDisplay');
    expect(displayBlocks).toHaveLength(2);
    expect(displayBlocks.every((block) => block.html !== null)).toBe(true);
    expect(displayBlocks.every((block) => block.contentHeight > 0)).toBe(true);
  });

  test('parses conservative inline math without claiming currency, shell, code, or link destinations', () => {
    const markdown = [
      'Use \\(p_t\\), $O(n^2)$, and $5x$.',
      'Pay $5.00 or $5.00 and $10.00; inspect $HOME and $(command).',
      'Keep \x60\\(code\\)\x60, https://example.com/$plain$, and [destination](https://example.com/$x$) literal.',
    ].join('\n');
    const blocks = parseMarkdownDocument(markdown);
    expect(blocks).toHaveLength(1);
    const paragraph = blocks[0];
    expect(paragraph?.type).toBe('paragraph');
    if (paragraph?.type !== 'paragraph') throw new Error('Expected paragraph');

    const inlines = paragraph.lines.flatMap((line) => flattenMarkdownInlines(line));
    expect(inlines.filter((inline) => inline.type === 'math').map((inline) => (
      inline.type === 'math' ? inline.math.tex : ''
    ))).toEqual(['p_t', 'O(n^2)', '5x']);
    expect(narrationSourceBlocks(markdown)[0]?.text).toContain(
      'Pay $5.00 or $5.00 and $10.00; inspect $HOME and $(command).',
    );
    expect(narrationSourceBlocks(markdown)[0]?.text).toContain('https://example.com/$plain$');
    expect(inlines.some((inline) => inline.type === 'code' && inline.text === '\\(code\\)')).toBe(true);
  });

  test('keeps math syntax literal in fenced code, raw HTML, and display-unsupported table cells', () => {
    const markdown = [
      '\x60\x60\x60tex',
      '\\[code equation\\]',
      '\x60\x60\x60',
      '',
      '<div>\\(html equation\\)</div>',
      '',
      '| Inline | Display |',
      '| --- | --- |',
      '| \\(x^2\\) | \\[y^2\\] |',
    ].join('\n');
    const blocks = parseMarkdownDocument(markdown);

    expect(blocks.map((block) => block.type)).toEqual(['code', 'paragraph', 'table']);
    expect(blocks[0]).toMatchObject({ text: '\\[code equation\\]', type: 'code' });
    expect(narrationSourceBlocks(markdown)[1]?.text).toContain('\\(html equation\\)');
    const table = blocks[2];
    expect(table?.type).toBe('table');
    if (table?.type !== 'table') throw new Error('Expected table');
    const inlineCell = table.rows[1]?.cells[0]?.lines[0] ?? [];
    const displayCell = table.rows[1]?.cells[1]?.lines[0] ?? [];
    expect(flattenMarkdownInlines(inlineCell).some((inline) => inline.type === 'math')).toBe(true);
    expect(flattenMarkdownInlines(displayCell)).toEqual([
      { text: '\\[y^2\\]', type: 'text' },
    ]);
  });

  test('uses Markdown block context for display math and indented code', () => {
    const markdown = [
      'Before \\[a = b\\] after.',
      '',
      '    \\[indented code stays literal\\]',
      '',
      '> \\[q = r\\]',
      '',
      '- item',
      '',
      '    \\[s = t\\]',
      '',
      '# Heading \\[u = v\\]',
      '',
      '[Label \\[w = z\\]](https://example.com)',
    ].join('\n');
    const blocks = parseMarkdownDocument(markdown);

    expect(blocks.slice(0, 3).map((block) => block.type)).toEqual([
      'paragraph',
      'mathDisplay',
      'paragraph',
    ]);
    expect(blocks[3]).toMatchObject({
      text: '\\[indented code stays literal\\]',
      type: 'code',
    });
    expect(blocks[4]).toMatchObject({
      children: [expect.objectContaining({ type: 'mathDisplay' })],
      type: 'blockquote',
    });
    expect(blocks[5]).toMatchObject({
      items: [{
        blocks: [
          expect.objectContaining({ type: 'paragraph' }),
          expect.objectContaining({ type: 'mathDisplay' }),
        ],
      }],
      type: 'list',
    });
    expect(blocks[6]).toMatchObject({ type: 'heading' });
    expect(blocks[7]).toMatchObject({ type: 'paragraph' });
    expect(narrationSourceBlocks(markdown).map((block) => block.text)).toEqual(
      expect.arrayContaining([
        expect.stringContaining('Heading \\[u = v\\]'),
        expect.stringContaining('Label \\[w = z\\]'),
      ]),
    );
  });

  test('bounds formula count and source length with exact literal recovery', () => {
    const many = Array.from({ length: 129 }, (_, index) => `\\(x_${index}\\)`).join(' ');
    const manyBlock = parseMarkdownDocument(many)[0];
    expect(manyBlock?.type).toBe('paragraph');
    if (manyBlock?.type !== 'paragraph') throw new Error('Expected paragraph');
    const manyInlines = manyBlock.lines.flatMap((line) => flattenMarkdownInlines(line));
    expect(manyInlines.filter((inline) => inline.type === 'math')).toHaveLength(128);
    expect(manyInlines.at(-1)).toEqual({ text: ' \\(x_128\\)', type: 'text' });

    const long = `\\(${`x`.repeat(16_385)}\\)`;
    const longBlock = parseMarkdownDocument(long)[0];
    expect(longBlock?.type).toBe('paragraph');
    if (longBlock?.type !== 'paragraph') throw new Error('Expected paragraph');
    expect(flattenMarkdownInlines(longBlock.lines[0] ?? [])).toEqual([
      { text: long, type: 'text' },
    ]);
  });

  test('keeps incomplete and invalid math readable while streaming', () => {
    const complete = '\\[\\frac{\\text{😀}}{y}\\]';
    for (let end = 1; end <= complete.length; end += 1) {
      const prefix = complete.slice(0, end);
      expect(() => parseMarkdownDocument(prefix, {
        cacheScope: { key: 'streaming-math', kind: 'streaming' },
      })).not.toThrow();
    }
    expect(parseMarkdownDocument(complete, {
      cacheScope: { key: 'streaming-math', kind: 'streaming' },
    })[0]).toMatchObject({ type: 'mathDisplay' });

    const invalid = getMarkdownLayoutDocument(
      'Before \\(\\notARealCommand{x}\\) after.',
      'default',
      360,
    );
    const paragraph = invalid.blocks[0];
    expect(paragraph?.type).toBe('paragraph');
    if (paragraph?.type !== 'paragraph') throw new Error('Expected paragraph');
    expect(paragraph.lines.flatMap((line) => line.fragments).map((fragment) => fragment.text).join(''))
      .toContain('\\(\\notARealCommand{x}\\)');

    const untrusted = getMarkdownLayoutDocument(
      'Do not navigate: \\(\\href{javascript:alert(1)}{x}\\).',
      'default',
      360,
    );
    const untrustedParagraph = untrusted.blocks[0];
    expect(untrustedParagraph?.type).toBe('paragraph');
    if (untrustedParagraph?.type !== 'paragraph') throw new Error('Expected paragraph');
    const untrustedFragments = untrustedParagraph.lines.flatMap((line) => line.fragments);
    expect(untrustedFragments.every((fragment) => fragment.source.kind === 'text')).toBe(true);
    expect(untrustedFragments.map((fragment) => fragment.text).join(''))
      .toContain('\\(\\href{javascript:alert(1)}{x}\\)');
  });

  test('keeps mutable streaming prefixes out of the durable Markdown layout cache', () => {
    const completed = getMarkdownLayoutDocument(
      'A durable completed response with \\(x^2\\).',
      'default',
      360,
    );
    const streamingSource = '\\[' + 'x + '.repeat(420) + 'y\\]';
    for (let end = 1; end <= streamingSource.length; end += 7) {
      getMarkdownLayoutDocument(streamingSource.slice(0, end), 'default', 360, {
        cacheScope: { key: 'one-mutable-tail', kind: 'streaming' },
      });
    }
    expect(getMarkdownLayoutDocument(
      'A durable completed response with \\(x^2\\).',
      'default',
      360,
    )).toBe(completed);
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
      'Value \\(x^2\\) next word after math',
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

function flattenMarkdownInlines(inlines: MarkdownInline[]): MarkdownInline[] {
  return inlines.flatMap((inline) => {
    if (inline.type === 'link' || inline.type === 'strong' || inline.type === 'emphasis') {
      return flattenMarkdownInlines(inline.children);
    }
    return [inline];
  });
}

function gfmTableMarkdown() {
  return [
    '| Projection shape | Cache representation | Delivery read |',
    '| :--- | :---: | ---: |',
    '| Bars | Append-only array + live value + status | Read only unseen bar suffix and latest live bar |',
    '| Depth/DOM | Replaceable snapshot | Clone an `Arc<DepthSnapshot>` |',
  ].join('\n');
}
