import assert from 'node:assert/strict';
import test from 'node:test';

import {
  encodedJsonBytes,
  fitDisplayText,
  fitReasoningSummary,
} from '../server/src/providers/display-fitting.ts';

test('display fitting honors Unicode character and encoded JSON byte budgets', () => {
  const fitted = fitDisplayText({
    value: `${'😀'.repeat(100)}${'"\\\n'.repeat(100)}`,
    maxChars: 80,
    maxBytes: 120,
    build: (text, truncated) => ({ text, truncated }),
  });
  assert.equal(fitted.truncated, true);
  assert.ok([...fitted.text].length <= 80);
  assert.ok(encodedJsonBytes(fitted.value) <= 120);

  const tiny = fitDisplayText({
    value: 'abcdef',
    maxChars: 2,
    maxBytes: 32,
    build: (text) => text,
  });
  assert.ok([...tiny.text].length <= 2);
});

test('reasoning fitting bounds duplicated compatibility text and native parts', () => {
  const fitted = fitReasoningSummary(
    Array.from({ length: 300 }, (_, index) => `part-${index}-${'😀'.repeat(20)}`),
    { maxChars: 2_000, maxBytes: 4_096 },
  );
  assert.equal(fitted.truncated, true);
  assert.ok((fitted.parts?.length ?? 0) <= 256);
  assert.equal(fitted.parts?.join('\n'), fitted.text);
  assert.ok(encodedJsonBytes(fitted) <= 4_096);

  const tiny = fitReasoningSummary(['abcdef'], { maxChars: 2, maxBytes: 128 });
  assert.equal(tiny.truncated, true);
  assert.ok([...tiny.text].length <= 2);
  assert.equal(tiny.parts?.join('\n'), tiny.text);
  assert.match(fitted.text, /truncated/u, 'omitted native parts are marked in the display');
});
