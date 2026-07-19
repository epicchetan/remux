import { expect, test } from '@playwright/test';

import { buildMarkdownNarrationModel } from '../viewer/src/markdown/narrationModel';

test('projects prose, nested containers, and structural blocks in reading order', () => {
  const model = buildMarkdownNarrationModel([
    '# Narration model',
    '',
    'Use **Misaki** with `Kokoro`.',
    '',
    '- Tight list item',
    '',
    '> Quoted *context*.',
    '',
    '| Name | Role |',
    '| --- | --- |',
    '| Sol | Review |',
    '',
    '```ts',
    'const voice = "af_heart";',
    '```',
    '',
    '```mermaid',
    'graph TD; A-->B;',
    '```',
  ].join('\n'));

  expect(model.document.blocks).toEqual([
    { highlightMode: 'text', id: 'md:0', kind: 'heading', text: 'Narration model' },
    { highlightMode: 'text', id: 'md:1', kind: 'paragraph', text: 'Use Misaki with Kokoro.' },
    { highlightMode: 'text', id: 'md:2', kind: 'listItem', text: 'Tight list item' },
    { highlightMode: 'text', id: 'md:3', kind: 'blockquote', text: 'Quoted context.' },
    { highlightMode: 'block', id: 'md:4', kind: 'table', text: 'Name | Role\nSol | Review' },
    { highlightMode: 'block', id: 'md:5', kind: 'code', text: 'const voice = "af_heart";' },
    { highlightMode: 'block', id: 'md:6', kind: 'diagram', text: 'graph TD; A-->B;' },
  ]);
  expect(model.blocks.filter((block) => block.highlightMode === 'text').every((block) => (
    block.leaves.every((leaf) => block.text.slice(leaf.start, leaf.end) === leaf.text)
  ))).toBe(true);
});

test('uses UTF-16 offsets and keeps inline math indivisible', () => {
  const model = buildMarkdownNarrationModel('A 😀 value uses $x^2 + \\alpha$.');
  const block = model.blocks[0];
  expect(block.text).toBe('A 😀 value uses x^2 + \\alpha.');
  const math = block.leaves.find((leaf) => leaf.kind === 'element');
  expect(math).toBeTruthy();
  expect(math?.text).toBe('x^2 + \\alpha');
  expect(math?.start).toBe('A 😀 value uses '.length);
  expect(math?.end).toBe(math!.start + 'x^2 + \\alpha'.length);
});

test('removes alert markers and omits non-text media', () => {
  const model = buildMarkdownNarrationModel([
    '> [!NOTE]',
    '> The **voice** is ready.',
    '',
    '![diagram](diagram.png)',
    '',
    '---',
  ].join('\n'));

  expect(model.document.blocks).toEqual([
    { highlightMode: 'text', id: 'md:0', kind: 'blockquote', text: 'The voice is ready.' },
  ]);
});

test('maps display math through the structural transcript path', () => {
  const model = buildMarkdownNarrationModel('$$\nE = mc^2\n$$');
  expect(model.document.blocks).toEqual([
    { highlightMode: 'block', id: 'md:0', kind: 'code', text: 'E = mc^2' },
  ]);
});

test('normalizes Markdown hard and soft breaks to one logical newline', () => {
  const hard = buildMarkdownNarrationModel('first line  \nsecond line');
  const soft = buildMarkdownNarrationModel('first line\nsecond line');

  expect(hard.document.blocks[0]?.text).toBe('first line\nsecond line');
  expect(soft.document.blocks[0]?.text).toBe('first line\nsecond line');
});

test('projects inline formatting as visible text with exact paintable slices', () => {
  const model = buildMarkdownNarrationModel([
    'Use *emphasis*, **strong**, ~~deleted~~, [a link](https://example.test), and `inlineCode()`.',
    '',
    'A combining mark e\u0301 and emoji 👩🏽‍💻 remain UTF-16 exact.',
  ].join('\n'));

  expect(model.document.blocks.map((block) => block.text)).toEqual([
    'Use emphasis, strong, deleted, a link, and inlineCode().',
    'A combining mark e\u0301 and emoji 👩🏽‍💻 remain UTF-16 exact.',
  ]);
  for (const block of model.blocks) {
    for (const leaf of block.leaves) {
      expect(block.text.slice(leaf.start, leaf.end)).toBe(leaf.text);
    }
  }
  const emojiBlock = model.blocks[1];
  expect(emojiBlock.leaves.at(-1)?.end).toBe(emojiBlock.text.length);
});

test('keeps tight, loose, nested, and quoted list prose as ordered leaf blocks', () => {
  const model = buildMarkdownNarrationModel([
    '- Tight item',
    '  - Nested item',
    '',
    '- Loose item',
    '',
    '  Continued paragraph.',
    '',
    '> - Quoted list item',
  ].join('\n'));

  expect(model.document.blocks.map(({ kind, text }) => ({ kind, text }))).toEqual([
    { kind: 'listItem', text: 'Tight item' },
    { kind: 'listItem', text: 'Nested item' },
    { kind: 'listItem', text: 'Loose item' },
    { kind: 'listItem', text: 'Continued paragraph.' },
    { kind: 'blockquote', text: 'Quoted list item' },
  ]);
});

test('narrates only supported semantic blocks from sanitized raw HTML', () => {
  const model = buildMarkdownNarrationModel([
    '<div>Unclassified text is omitted.</div>',
    '',
    '<div><p>Supported <strong>HTML</strong> prose.</p></div>',
  ].join('\n'));

  expect(model.document.blocks.map(({ kind, text }) => ({ kind, text }))).toEqual([
    { kind: 'paragraph', text: 'Supported HTML prose.' },
  ]);
});

test('removes exactly one code terminator and permits an empty narration document', () => {
  const code = buildMarkdownNarrationModel('```text\nfirst\n\n```');
  const empty = buildMarkdownNarrationModel([
    '![ignored image](image.png)',
    '',
    '---',
    '',
    '<div>Unclassified text.</div>',
  ].join('\n'));

  expect(code.document.blocks).toEqual([
    { highlightMode: 'block', id: 'md:0', kind: 'code', text: 'first\n' },
  ]);
  expect(empty.document.blocks).toEqual([]);
});
