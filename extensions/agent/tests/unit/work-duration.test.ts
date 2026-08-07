import assert from 'node:assert/strict';
import { test } from '@playwright/test';

import {
  formatRunningWorkDuration,
  formatWorkDuration,
  nextRunningWorkDurationUpdateMs,
} from '../../viewer/src/transcript/components/work/workDuration.ts';

test('formats live duration only after its first completed second', () => {
  assert.equal(formatRunningWorkDuration(999), null);
  assert.equal(formatRunningWorkDuration(1_000), '1s');
  assert.equal(formatRunningWorkDuration(65_999), '1m 5s');
  assert.equal(formatRunningWorkDuration(3_661_000), '1h 1m');
});

test('rounds authoritative completed duration to the nearest second', () => {
  assert.equal(formatWorkDuration(0), '1s');
  assert.equal(formatWorkDuration(1_499), '1s');
  assert.equal(formatWorkDuration(1_500), '2s');
});

test('schedules live updates on whole-second boundaries', () => {
  assert.equal(nextRunningWorkDurationUpdateMs(0), 1_000);
  assert.equal(nextRunningWorkDurationUpdateMs(1_250), 750);
  assert.equal(nextRunningWorkDurationUpdateMs(2_000), 1_000);
});
