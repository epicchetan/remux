import { expect, test } from '@playwright/test';

import {
  formatRunningWorkDuration,
  formatWorkDuration,
  nextRunningWorkDurationUpdateMs,
} from '../viewer/transcript/components/work/workDuration';

test.describe('work duration', () => {
  test('formats live duration only after the first completed second', () => {
    expect(formatRunningWorkDuration(999)).toBeNull();
    expect(formatRunningWorkDuration(1000)).toBe('1s');
    expect(formatRunningWorkDuration(65_999)).toBe('1m 5s');
    expect(formatRunningWorkDuration(3_661_000)).toBe('1h 1m');
  });

  test('retains the authoritative completed-duration rounding', () => {
    expect(formatWorkDuration(0)).toBe('1s');
    expect(formatWorkDuration(1499)).toBe('1s');
    expect(formatWorkDuration(1500)).toBe('2s');
  });

  test('schedules the next render on a whole-second boundary', () => {
    expect(nextRunningWorkDurationUpdateMs(0)).toBe(1000);
    expect(nextRunningWorkDurationUpdateMs(1250)).toBe(750);
    expect(nextRunningWorkDurationUpdateMs(2000)).toBe(1000);
  });
});
