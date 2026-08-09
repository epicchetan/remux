import assert from 'node:assert/strict';
import { test } from '@playwright/test';

import {
  createComposerSnapshot,
  createTextComposerDocument,
  normalizeComposerDocument,
} from '../../viewer/src/composer/model/composerModel.ts';

test('normalizes text into one stable document part', () => {
  const normalized = normalizeComposerDocument({
    parts: [
      { text: 'one', type: 'text' },
      { text: '\ntwo', type: 'text' },
    ],
  });

  assert.deepEqual(normalized, { parts: [{ text: 'one\ntwo', type: 'text' }] });
  assert.equal(createComposerSnapshot(normalized).contentKey, 'text:one\ntwo');
});

test('distinguishes whitespace-only and sendable text', () => {
  assert.equal(createComposerSnapshot(createTextComposerDocument(' \n ')).canSend, false);
  assert.equal(createComposerSnapshot(createTextComposerDocument(' inspect ')).canSend, true);
});
