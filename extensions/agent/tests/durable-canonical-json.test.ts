import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import test from 'node:test';

import {
  canonicalJson,
  canonicalJsonHash,
} from '../server/src/storage/canonical-json.ts';

const execFile = promisify(execFileCallback);

test('canonical JSON sorts recursively without JavaScript integer-key reordering', () => {
  const value = {
    z: 'windows\r\nline\rbreak',
    nested: { '2': 2, '10': 10, a: 1 },
    array: [{ b: 2, a: 1 }, 3],
  };
  assert.equal(
    canonicalJson(value),
    '{"array":[{"a":1,"b":2},3],"nested":{"10":10,"2":2,"a":1},"z":"windows\\nline\\nbreak"}',
  );
  const reordered = {
    array: [{ a: 1, b: 2 }, 3],
    nested: { a: 1, '10': 10, '2': 2 },
    z: 'windows\nline\nbreak',
  };
  assert.equal(canonicalJsonHash(value), canonicalJsonHash(reordered));
  assert.equal(
    canonicalJsonHash(value),
    createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex'),
  );
});

test('canonical JSON fails closed outside its versioned value domain', () => {
  const sparse: unknown[] = [];
  sparse[1] = 1;
  const decoratedArray = [1] as unknown[] & { extra?: number };
  decoratedArray.extra = 2;
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  const symbolProperty = { accepted: true } as Record<PropertyKey, unknown>;
  symbolProperty[Symbol('hidden')] = false;
  const accessor = Object.create(null) as Record<string, unknown>;
  Object.defineProperty(accessor, 'value', { enumerable: true, get: () => 1 });
  for (const value of [
    undefined,
    () => null,
    Symbol('no'),
    1n,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    1.5,
    Number.MAX_SAFE_INTEGER + 1,
    sparse,
    decoratedArray,
    cyclic,
    symbolProperty,
    accessor,
    new Date(),
  ]) {
    assert.throws(() => canonicalJson(value));
  }
});

test('canonical JSON bytes are stable in another process', async () => {
  const moduleUrl = new URL('../server/src/storage/canonical-json.ts', import.meta.url).href;
  const value = { omega: ['é', { '20': 20, '3': 3 }], alpha: true };
  const script = [
    `import { canonicalJson } from ${JSON.stringify(moduleUrl)};`,
    `process.stdout.write(canonicalJson(${JSON.stringify(value)}));`,
  ].join('\n');
  const { stdout } = await execFile(process.execPath, [
    '--experimental-strip-types',
    '--input-type=module',
    '--eval',
    script,
  ]);
  assert.equal(stdout, canonicalJson(value));
});
