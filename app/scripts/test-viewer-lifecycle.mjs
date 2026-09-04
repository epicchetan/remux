import assert from 'node:assert/strict';

import { HostLifecycleEvidenceClock } from '../src/surfaces/viewer/lifecycleEvidence.ts';

const clock = new HostLifecycleEvidenceClock('active', 0);
assert.deepEqual(clock.sample('active', 'connect', 50), {
  epoch: 0,
  inactiveForMs: null,
  reason: 'connect',
  state: 'active',
});
assert.equal(clock.sample('background', 'appState', 100).epoch, 1);
assert.equal(clock.sample('inactive', 'tabActive', 200).epoch, 2);
assert.deepEqual(clock.sample('active', 'tabActive', 600), {
  epoch: 3,
  inactiveForMs: 500,
  reason: 'tabActive',
  state: 'active',
});
assert.deepEqual(clock.sample('active', 'connect', 700), {
  epoch: 3,
  inactiveForMs: null,
  reason: 'connect',
  state: 'active',
});

const unknown = new HostLifecycleEvidenceClock('active', 0);
unknown.sample('background', 'appState', null);
unknown.sample('inactive', 'appState', 500);
assert.equal(unknown.sample('active', 'appState', 1_000).inactiveForMs, null);

const initiallyInactive = new HostLifecycleEvidenceClock('inactive', 5_000);
assert.equal(
  initiallyInactive.sample('active', 'appState', 7_500).inactiveForMs,
  2_500,
);

process.stdout.write(
  `${JSON.stringify({ ok: true, epochTransitions: true, monotonicInactiveDuration: true })}\n`,
);
