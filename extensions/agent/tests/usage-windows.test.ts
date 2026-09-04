import assert from 'node:assert/strict';
import test from 'node:test';

import type { AccountUsageWindow } from '../shared/provider-runtime.ts';
import { visibleAccountUsageWindows } from '../viewer/src/composer/usage/usageWindows.ts';

const windows: AccountUsageWindow[] = [
  usageWindow('codex:primary', null),
  usageWindow('codex:secondary', null),
  usageWindow('codex_bengalfox:primary', 'GPT-5.3-Codex-Spark'),
  usageWindow('future-spark:secondary', 'GPT-5.4-Codex-Spark'),
];

test('the usage tray intentionally omits Codex Spark limits without hiding normal Codex limits', () => {
  assert.deepEqual(
    visibleAccountUsageWindows('codex', windows).map(({ id }) => id),
    ['codex:primary', 'codex:secondary'],
  );
});

test('provider-specific filtering does not hide similarly named non-Codex usage', () => {
  assert.deepEqual(visibleAccountUsageWindows('claude-code', windows), windows);
  assert.deepEqual(visibleAccountUsageWindows('fixture', windows), windows);
});

function usageWindow(id: string, model: string | null): AccountUsageWindow {
  return {
    id,
    label: id.endsWith('primary') ? '5 hours' : 'Weekly',
    kind: id.endsWith('primary') ? 'rolling' : 'weekly',
    model,
    usedPercent: 10,
    resetsAt: null,
  };
}
