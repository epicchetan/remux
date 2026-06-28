import { expect, test } from '@playwright/test';

import { fileExtension, parseComposerMentionQuery } from '../viewer/composer/mentions/mentionSearch';

test.describe('composer mention search', () => {
  test('normalizes mention queries for file search', () => {
    expect(parseComposerMentionQuery('')).toEqual({ normalizedQuery: '' });
    expect(parseComposerMentionQuery('@')).toEqual({ normalizedQuery: '' });
    expect(parseComposerMentionQuery('index')).toEqual({ normalizedQuery: 'index' });
    expect(parseComposerMentionQuery('@extensions\\codex')).toEqual({
      normalizedQuery: 'extensions/codex',
    });
    expect(parseComposerMentionQuery('/extensions/codex/')).toEqual({
      normalizedQuery: 'extensions/codex/',
    });
  });

  test('derives file extensions for icon lookup', () => {
    expect(fileExtension('ComposerEditor.tsx')).toBe('tsx');
    expect(fileExtension('README')).toBe(null);
    expect(fileExtension('.gitignore')).toBe(null);
  });
});
