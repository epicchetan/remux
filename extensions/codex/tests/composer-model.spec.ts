import { expect, test } from '@playwright/test';

import {
  composerDocumentPlainText,
  type ComposerAttachmentResource,
  createComposerSnapshot,
  normalizeComposerDocument,
} from '../viewer/composer/model/composerModel';
import {
  maxComposerImageAttachments,
  validateComposerImages,
} from '../viewer/composer/attachments/imageAttachments';
import {
  composerDocumentFromUserInput,
  composerUserInputCanLoad,
  composerUserInputCanStartEdit,
  plainTextFromUserInput,
} from '../viewer/composer/model/userInputInterop';

test.describe('composerModel', () => {
  test('merges adjacent text parts', () => {
    expect(
      normalizeComposerDocument({
        parts: [
          { text: 'Hello', type: 'text' },
          { text: ' ', type: 'text' },
          { text: 'world', type: 'text' },
        ],
      }),
    ).toEqual({
      parts: [{ text: 'Hello world', type: 'text' }],
    });
  });

  test('omits mention chips from plain text while preserving surrounding text', () => {
    expect(
      composerDocumentPlainText({
        parts: [
          { text: 'Check ', type: 'text' },
          { id: 'mention-1', kind: 'file', name: 'app.tsx', path: '/repo/app.tsx', type: 'mention' },
          { text: ' please', type: 'text' },
        ],
      }),
    ).toBe('Check  please');
  });

  test('keeps mention order in the local document model', () => {
    const document = normalizeComposerDocument({
      parts: [
        { text: 'A ', type: 'text' },
        { id: 'mention-1', kind: 'file', name: 'one.ts', path: '/repo/one.ts', type: 'mention' },
        { text: ' B ', type: 'text' },
        { id: 'mention-2', kind: 'file', name: 'two.ts', path: '/repo/two.ts', type: 'mention' },
      ],
    });

    expect(document.parts.map((part) => part.type === 'mention' ? part.name : part.type)).toEqual([
      'text',
      'one.ts',
      'text',
      'two.ts',
    ]);
  });

  test('empty and whitespace-only documents cannot send text', () => {
    expect(createComposerSnapshot({ parts: [] }).canSendText).toBe(false);
    expect(createComposerSnapshot({ parts: [{ text: '   \n', type: 'text' }] }).canSendText).toBe(false);
  });

  test('attachment-only document can send once the image data URL is ready', () => {
    const snapshot = createComposerSnapshot({
      parts: [{ id: 'attachment-1', mimeType: 'image/png', name: 'image.png', type: 'attachment' }],
    }, new Map([['attachment-1', imageResource({ id: 'attachment-1' })]]));

    expect(snapshot.attachments).toHaveLength(1);
    expect(snapshot.plainText).toBe('');
    expect(snapshot.canSend).toBe(true);
    expect(snapshot.canSendText).toBe(false);
  });

  test('attachment document cannot send while image data URL is missing', () => {
    const snapshot = createComposerSnapshot({
      parts: [{ id: 'attachment-1', mimeType: 'image/png', name: 'image.png', type: 'attachment' }],
    }, new Map([['attachment-1', imageResource({ dataUrl: null, digest: null, id: 'attachment-1' })]]));

    expect(snapshot.canSend).toBe(false);
    expect(snapshot.isReadingImages).toBe(true);
  });

  test('attachment document cannot send when image has an error', () => {
    const snapshot = createComposerSnapshot({
      parts: [{ id: 'attachment-1', mimeType: 'image/png', name: 'image.png', type: 'attachment' }],
    }, new Map([['attachment-1', imageResource({
      dataUrl: null,
      digest: null,
      error: 'Could not read image.',
      id: 'attachment-1',
    })]]));

    expect(snapshot.canSend).toBe(false);
    expect(snapshot.attachments[0].error).toBe('Could not read image.');
  });

  test('text plus ready attachment can send as a structured composer document', () => {
    const snapshot = createComposerSnapshot({
      parts: [
        { text: 'Use this context', type: 'text' },
        { id: 'attachment-1', mimeType: 'image/png', name: 'image.png', type: 'attachment' },
      ],
    }, new Map([['attachment-1', imageResource({ id: 'attachment-1' })]]));

    expect(snapshot.plainText).toBe('Use this context');
    expect(snapshot.canSend).toBe(true);
    expect(snapshot.canSendText).toBe(true);
  });

  test('content key changes when image digest changes', () => {
    const document = {
      parts: [{ id: 'attachment-1', mimeType: 'image/png', name: 'image.png', type: 'attachment' as const }],
    };
    const first = createComposerSnapshot(document, new Map([['attachment-1', imageResource({
      digest: 'digest-a',
      id: 'attachment-1',
    })]]));
    const second = createComposerSnapshot(document, new Map([['attachment-1', imageResource({
      digest: 'digest-b',
      id: 'attachment-1',
    })]]));

    expect(first.contentKey).not.toBe(second.contentKey);
  });

  test('validates image attachments narrowly', () => {
    expect(validateComposerImages([file('photo.png', 'image/png')], 0).images).toHaveLength(1);
    expect(validateComposerImages([file('photo.jpg', '')], 0).images).toHaveLength(1);
    expect(validateComposerImages([file('vector.svg', 'image/svg+xml')], 0).message).toBe(
      'Only images can be attached.',
    );
    expect(validateComposerImages([file('notes.md', 'text/markdown')], 0).message).toBe('Only images can be attached.');
    expect(validateComposerImages([file('huge.png', 'image/png', 7 * 1024 * 1024)], 0).message).toBe(
      'Image is larger than 6 MB.',
    );
  });

  test('validates the maximum image count', () => {
    const files = Array.from({ length: maxComposerImageAttachments + 1 }, (_, index) =>
      file(`photo-${index}.png`, 'image/png'));

    expect(validateComposerImages(files, 0).message).toBe('You can attach up to 4 images.');
  });

  test('loads editable user input into a composer document', () => {
    const load = composerDocumentFromUserInput([
      { text: 'Review ', text_elements: [], type: 'text' },
      { name: 'ComposerEditor.tsx', path: 'extensions/codex/viewer/composer/ComposerEditor.tsx', type: 'mention' },
      { text: ' please', text_elements: [], type: 'text' },
      { type: 'image', url: 'data:image/png;base64,aGVsbG8=' },
    ]);

    expect(load.document.parts.map((part) => part.type)).toEqual(['text', 'mention', 'text', 'attachment']);
    expect(load.resources).toMatchObject([{
      dataUrl: 'data:image/png;base64,aGVsbG8=',
      digest: expect.any(String),
      mimeType: 'image/png',
      name: 'image.png',
    }]);
    expect(composerUserInputCanLoad([
      { text: 'Review ', text_elements: [], type: 'text' },
      { name: 'ComposerEditor.tsx', path: 'extensions/codex/viewer/composer/ComposerEditor.tsx', type: 'mention' },
    ])).toBe(true);
  });

  test('normalizes user input text for copy and falls back for unsupported edit inputs', () => {
    expect(plainTextFromUserInput([
      { text: 'Open ', text_elements: [], type: 'text' },
      { name: 'package.json', path: 'package.json', type: 'mention' },
    ])).toBe('Open @package.json');
    expect(composerUserInputCanLoad([{ path: '/tmp/photo.png', type: 'localImage' }])).toBe(false);
    expect(composerUserInputCanLoad([{ name: 'skill', path: 'skills/skill.md', type: 'skill' }])).toBe(false);
    expect(composerUserInputCanStartEdit([
      { text: 'Edit this', text_elements: [], type: 'text' },
      { path: '/tmp/photo.png', type: 'localImage' },
    ])).toBe(true);
    expect(composerUserInputCanStartEdit([{ path: '/tmp/photo.png', type: 'localImage' }])).toBe(true);
    expect(composerDocumentFromUserInput([{ path: '/tmp/photo.png', type: 'localImage' }]).document.parts).toEqual([
      { text: '/tmp/photo.png', type: 'text' },
    ]);
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

function file(name: string, type: string, size = 5) {
  return new File([new Uint8Array(size)], name, { type });
}
