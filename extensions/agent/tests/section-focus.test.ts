import assert from 'node:assert/strict';
import test from 'node:test';
import { decodeAgentSectionFocus, encodeAgentSectionFocus } from '../shared/section-focus.ts';

test('section focus round trips opaque turn and segment identifiers', () => {
  const focus = { turnId: 'turn:"a:1', segmentId: 'notice:child/finished:2' };
  assert.deepEqual(decodeAgentSectionFocus(encodeAgentSectionFocus(focus)), focus);
});

test('section focus rejects malformed and incomplete addresses', () => {
  for (const value of [null, '', 'turn-1', '{}', '[]', '["turn"]', '["", "notice"]',
    '["turn", 1]', '["turn", "notice", "extra"]']) {
    assert.equal(decodeAgentSectionFocus(value), null);
  }
});
