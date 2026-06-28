import { expect, test } from '@playwright/test';

import { buildComposerSendParts } from '../viewer/composer/model/sendProjection';
import {
  createComposerSnapshot,
  type ComposerAttachmentResource,
} from '../viewer/composer/model/composerModel';

test.describe('composer send projection', () => {
  test('projects text only input', () => {
    const projection = buildComposerSendParts(createComposerSnapshot({
      parts: [{ text: '  Hello Codex  ', type: 'text' }],
    }));

    expect(projection).toMatchObject({
      displayText: 'Hello Codex',
      parts: [{ text: 'Hello Codex', type: 'text' }],
      type: 'ok',
    });
  });

  test('projects mentions and images in document order', () => {
    const projection = buildComposerSendParts(createComposerSnapshot({
      parts: [
        { text: 'Use ', type: 'text' },
        { id: 'mention-1', kind: 'file', name: 'app.tsx', path: 'app.tsx', type: 'mention' },
        { text: ' with ', type: 'text' },
        { id: 'attachment-1', mimeType: 'image/png', name: 'image.png', type: 'attachment' },
      ],
    }, new Map([['attachment-1', imageResource({ id: 'attachment-1' })]])));

    expect(projection).toMatchObject({
      displayText: 'Use \napp.tsx\n with\nimage.png',
      parts: [
        { text: 'Use ', type: 'text' },
        { name: 'app.tsx', path: 'app.tsx', type: 'mention' },
        { text: ' with', type: 'text' },
        { dataUrl: 'data:image/png;base64,aGVsbG8=', mimeType: 'image/png', name: 'image.png', type: 'image' },
      ],
      type: 'ok',
    });
  });

  test('projects image-only input without putting base64 in summary text', () => {
    const projection = buildComposerSendParts(createComposerSnapshot({
      parts: [{ id: 'attachment-1', mimeType: 'image/png', name: 'image.png', type: 'attachment' }],
    }, new Map([['attachment-1', imageResource({ id: 'attachment-1' })]])));

    expect(projection).toMatchObject({
      displayText: 'image.png',
      parts: [{ dataUrl: 'data:image/png;base64,aGVsbG8=', mimeType: 'image/png', name: 'image.png', type: 'image' }],
      type: 'ok',
    });
    expect(JSON.stringify(projection).replace('"data:image/png;base64,aGVsbG8="', '')).not.toContain('base64');
  });

  test('fails when image is not ready', () => {
    const projection = buildComposerSendParts(createComposerSnapshot({
      parts: [{ id: 'attachment-1', mimeType: 'image/png', name: 'image.png', type: 'attachment' }],
    }, new Map([['attachment-1', imageResource({
      dataUrl: null,
      digest: null,
      id: 'attachment-1',
    })]])));

    expect(projection).toEqual({
      message: 'Image image.png is still loading.',
      type: 'error',
    });
  });

  test('fails when image has an error', () => {
    const projection = buildComposerSendParts(createComposerSnapshot({
      parts: [{ id: 'attachment-1', mimeType: 'image/png', name: 'image.png', type: 'attachment' }],
    }, new Map([['attachment-1', imageResource({
      dataUrl: null,
      digest: null,
      error: 'Could not read image.',
      id: 'attachment-1',
    })]])));

    expect(projection).toEqual({
      message: 'Could not read image.',
      type: 'error',
    });
  });
});

function imageResource({
  dataUrl = 'data:image/png;base64,aGVsbG8=',
  digest = 'digest',
  error = null,
  id,
}: {
  dataUrl?: string | null;
  digest?: string | null;
  error?: string | null;
  id: string;
}): ComposerAttachmentResource {
  return {
    dataUrl,
    digest,
    error,
    file: null,
    id,
    mimeType: 'image/png',
    name: 'image.png',
    previewUrl: null,
    sizeBytes: 5,
  };
}
