import assert from 'node:assert/strict';
import test from 'node:test';

import {
  fitJsonPreview,
  jsonPreviewByteLength,
  mergeJsonPreview,
} from '../server/src/providers/preview.ts';
import { PROVIDER_RUNTIME_LIMITS, type JsonValue } from '../shared/provider-runtime.ts';

test('provider previews honor the encoded-byte contract for escaped and multibyte values', () => {
  const small = { lines: ['one', 'two'], ok: true };
  assert.deepEqual(fitJsonPreview(small), small);

  const hostile = `${'\u001b[31m"😀"\n'.repeat(20_000)}LAST-LINE`;
  const preview = fitJsonPreview({ output: hostile });
  assert.ok(jsonPreviewByteLength(preview) <= PROVIDER_RUNTIME_LIMITS.previewBytes);
  assert.match(String(preview), /output truncated/u);
  assert.match(String(preview), /LAST-LINE/u);
});

test('streamed output previews remain bounded across a megabyte of deltas and retain the tail', () => {
  let preview: JsonValue | undefined;
  for (let index = 0; index < 1_024; index += 1) {
    preview = mergeJsonPreview(preview, {
      delta: `${index.toString().padStart(4, '0')}:\u001b[2K\r"😀" ${'x'.repeat(1_000)}\n`,
    });
    assert.ok(jsonPreviewByteLength(preview) <= PROVIDER_RUNTIME_LIMITS.previewBytes);
  }
  assert.ok(preview && typeof preview === 'object' && !Array.isArray(preview));
  const previewRecord = preview as { readonly delta?: unknown };
  const delta = String(previewRecord.delta);
  assert.match(delta, /^\n… output truncated …\n/u);
  assert.match(delta, /1023:/u);
  assert.doesNotMatch(delta, /\uFFFD/u);
});
