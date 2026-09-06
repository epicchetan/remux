import assert from 'node:assert/strict';

import { decodeSourceText, FULL_DOCUMENT_MAX_BYTES } from '../viewer/src/editor/sourceDecode.ts';

for (const size of [2_200_000, FULL_DOCUMENT_MAX_BYTES]) {
  const bytes = Buffer.alloc(size, 0x61);
  const decoded = decodeSourceText(bytes.toString('base64'), size);
  assert.equal(decoded.length, size);
}
assert.throws(() => decodeSourceText('Zh==', 1), /malformed base64/);
assert.throws(() => decodeSourceText('YQ==\n', 1), /malformed base64/);
assert.throws(() => decodeSourceText(Buffer.from([0xc0, 0x80]).toString('base64'), 2), /not valid UTF-8/);
assert.throws(() => decodeSourceText('YQ==', 2), /incomplete/);

process.stdout.write(`${JSON.stringify({ exactLimit: FULL_DOCUMENT_MAX_BYTES, ledgerSized: 2_200_000, strictBase64: true, strictUtf8: true })}\n`);
