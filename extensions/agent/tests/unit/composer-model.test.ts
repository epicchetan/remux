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
      { id: 'stable', text: 'one', type: 'text' },
      { id: 'discarded', text: '\ntwo', type: 'text' },
    ],
  });

  assert.deepEqual(normalized, { parts: [{ id: 'stable', text: 'one\ntwo', type: 'text' }] });
  assert.equal(createComposerSnapshot(normalized).contentKey, 'stable:one\ntwo');
});

test('distinguishes whitespace-only and sendable text', () => {
  assert.equal(createComposerSnapshot(createTextComposerDocument(' \n ')).canSend, false);
  assert.equal(createComposerSnapshot(createTextComposerDocument(' inspect ')).canSend, true);
});
