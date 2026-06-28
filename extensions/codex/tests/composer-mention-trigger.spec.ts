import { expect, test } from '@playwright/test';

import { detectComposerMentionTrigger } from '../viewer/composer/mentions/mentionTrigger';

test.describe('composer mention trigger', () => {
  test('detects a bare at trigger', () => {
    expect(detectComposerMentionTrigger('@', 1)).toEqual({
      endOffset: 1,
      query: '',
      startOffset: 0,
    });
  });

  test('detects a file query after whitespace', () => {
    expect(detectComposerMentionTrigger('open @fileType', 14)).toEqual({
      endOffset: 14,
      query: 'fileType',
      startOffset: 5,
    });
  });

  test('detects slash-delimited file paths', () => {
    expect(detectComposerMentionTrigger('@app/', 5)).toEqual({
      endOffset: 5,
      query: 'app/',
      startOffset: 0,
    });
    expect(detectComposerMentionTrigger('open @extensions/codex/', 23)).toEqual({
      endOffset: 23,
      query: 'extensions/codex/',
      startOffset: 5,
    });
  });

  test('does not trigger in the middle of a word', () => {
    expect(detectComposerMentionTrigger('email@test', 10)).toBe(null);
    expect(detectComposerMentionTrigger('hello@world', 11)).toBe(null);
  });

  test('does not trigger after whitespace inside the query', () => {
    expect(detectComposerMentionTrigger('@file name', 10)).toBe(null);
  });
});
