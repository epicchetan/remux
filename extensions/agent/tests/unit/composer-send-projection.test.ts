import assert from 'node:assert/strict';
import { test } from '@playwright/test';

import { createComposerSnapshot, createTextComposerDocument } from '../../viewer/src/composer/model/composerModel.ts';
import { buildComposerSendProjection } from '../../viewer/src/composer/model/sendProjection.ts';

test('projects only trimmed plain text', () => {
  assert.deepEqual(
    buildComposerSendProjection(createComposerSnapshot(createTextComposerDocument('  line one\nline two  '))),
    {
      displayText: 'line one\nline two',
      parts: [{ text: 'line one\nline two', type: 'text' }],
      type: 'ok',
    },
  );
});

test('rejects an empty projection', () => {
  assert.deepEqual(
    buildComposerSendProjection(createComposerSnapshot(createTextComposerDocument(' \n '))),
    { message: 'Enter a message or attach an image.', type: 'error' },
  );
});
