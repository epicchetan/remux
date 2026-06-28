import { expect, test } from '@playwright/test';

import {
  buildUserMessageLayout,
  normalizeUserMessageTextPart,
} from '../viewer/transcript/model/userMessageContent';
import {
  normalizeTextElementSpans,
  normalizeUserTextToMarkdown,
} from '../viewer/transcript/model/userMessageMarkdown';

test.describe('userMessageMarkdown', () => {
  test('escapes text element placeholders before markdown parsing', () => {
    const markdown = normalizeUserTextToMarkdown('Preserve placeholder-source exactly.', [
      {
        byteRange: {
          start: 9,
          end: 27,
        },
        placeholder: '**literal placeholder**',
      },
    ]);

    expect(markdown).toBe('Preserve \\*\\*literal placeholder\\*\\* exactly.');
  });

  test('converts utf-8 byte ranges into js string spans', () => {
    const spans = normalizeTextElementSpans('Use café-token here.', [
      {
        byteRange: {
          start: 4,
          end: 15,
        },
        placeholder: '@cafe',
      },
    ]);

    expect(spans).toMatchObject([
      {
        jsStart: 4,
        jsEnd: 14,
        outputText: '@cafe',
      },
    ]);
  });

  test('ignores malformed and overlapping text element ranges', () => {
    const spans = normalizeTextElementSpans('alpha beta gamma', [
      {
        byteRange: {
          start: 0,
          end: 5,
        },
        placeholder: 'first',
      },
      {
        byteRange: {
          start: 2,
          end: 8,
        },
        placeholder: 'overlap',
      },
      {
        byteRange: {
          start: 100,
          end: 120,
        },
        placeholder: 'invalid',
      },
    ]);

    expect(spans).toHaveLength(1);
    expect(spans[0]).toMatchObject({ outputText: 'first' });
  });

  test('strips Codex Desktop attachment wrappers when structured attachments match', () => {
    const path = '/Users/calla/Library/Group Containers/group.com.apple.coreservices.useractivityd/shared-pasteboard/items/F0127A4C/IMG_1621.png';
    const part = {
      text:
        '\n# Files mentioned by the user:\n\n' +
        `## IMG_1621.png: ${path}\n\n` +
        '## My request for Codex:\n' +
        'Next, we are going to work on our bottom bar.\n\n' +
        'Keep this **markdown**.',
      text_elements: [],
      type: 'text' as const,
    };

    const normalized = normalizeUserMessageTextPart(part, {
      hasStructuredAttachments: true,
      structuredAttachmentPaths: [path],
    });

    expect(normalized).toMatchObject({
      strippedAttachmentPaths: [path],
      strippedWrapper: true,
      text: 'Next, we are going to work on our bottom bar.\n\nKeep this **markdown**.',
    });

    const layout = buildUserMessageLayout(
      {
        content: [part, { path, type: 'localImage' }],
        id: 'fixture-user',
        type: 'userMessage',
      },
      'topLevel',
    );

    expect(layout.bodyMarkdown).toBe('Next, we are going to work on our bottom bar.\n\nKeep this **markdown**.');
    expect(layout.railItems).toMatchObject([
      {
        path,
        type: 'localImage',
      },
    ]);
  });

  test('keeps user attachments in the rail instead of splitting body text', () => {
    const layout = buildUserMessageLayout(
      {
        content: [
          {
            text: 'First part.',
            text_elements: [],
            type: 'text',
          },
          {
            url: 'data:image/png;base64,abc',
            type: 'image',
          },
          {
            text: 'Second part.',
            text_elements: [],
            type: 'text',
          },
          {
            name: 'index.ts',
            path: '/repo/src/index.ts',
            type: 'mention',
          },
        ],
        id: 'fixture-user',
        type: 'userMessage',
      },
      'topLevel',
    );

    expect(layout.bodyMarkdown).toBe('First part.\n\nSecond part.');
    expect(layout.railItems).toMatchObject([
      {
        src: 'data:image/png;base64,abc',
        type: 'image',
      },
      {
        label: 'index.ts',
        path: '/repo/src/index.ts',
        type: 'reference',
      },
    ]);
  });

  test('keeps attachment wrapper text when parsed paths do not match structured attachments', () => {
    const normalized = normalizeUserMessageTextPart(
      {
        text:
          '# Files mentioned by the user:\n\n' +
          '## IMG_1621.png: /tmp/not-the-attachment.png\n\n' +
          '## My request for Codex:\nActual request',
        text_elements: [],
        type: 'text',
      },
      {
        hasStructuredAttachments: true,
        structuredAttachmentPaths: ['/tmp/actual-attachment.png'],
      },
    );

    expect(normalized.strippedWrapper).toBe(false);
    expect(normalized.text).toContain('# Files mentioned by the user:');
  });

  test('keeps attachment wrapper text when text element ranges would need remapping', () => {
    const normalized = normalizeUserMessageTextPart(
      {
        text:
          '# Files mentioned by the user:\n\n' +
          '## IMG_1621.png: /tmp/attachment.png\n\n' +
          '## My request for Codex:\nActual request',
        text_elements: [
          {
            byteRange: {
              start: 0,
              end: 1,
            },
            placeholder: '#',
          },
        ],
        type: 'text',
      },
      {
        hasStructuredAttachments: true,
        structuredAttachmentPaths: ['/tmp/attachment.png'],
      },
    );

    expect(normalized.strippedWrapper).toBe(false);
    expect(normalized.text).toContain('# Files mentioned by the user:');
  });
});
