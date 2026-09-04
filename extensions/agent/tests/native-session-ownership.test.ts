import assert from 'node:assert/strict';
import test from 'node:test';

import { NativeSessionOwnershipRegistry } from '../server/src/native-runtime/native-session-ownership.ts';

test('native session ownership permits one controller and releases by lease identity', () => {
  const registry = new NativeSessionOwnershipRegistry(() => 123);
  const lease = registry.acquire({
    provider: 'codex',
    providerInstanceId: 'codex-local',
    sessionId: 'thread-1',
    executionId: 'execution-1',
  });

  assert.deepEqual(registry.snapshot(), [{
    provider: 'codex',
    providerInstanceId: 'codex-local',
    sessionId: 'thread-1',
    executionId: 'execution-1',
    acquiredAt: 123,
  }]);
  assert.throws(() => registry.acquire({
    provider: 'codex',
    providerInstanceId: 'codex-local',
    sessionId: 'thread-1',
    executionId: 'execution-2',
  }), /already controlled by execution "execution-1"/u);

  lease.release();
  lease.release();
  const replacement = registry.acquire({
    provider: 'codex',
    providerInstanceId: 'codex-local',
    sessionId: 'thread-1',
    executionId: 'execution-2',
  });
  assert.equal(registry.snapshot()[0]?.executionId, 'execution-2');
  replacement.release();
  assert.deepEqual(registry.snapshot(), []);
});

test('native session ownership keys include provider instance and provider kind', () => {
  const registry = new NativeSessionOwnershipRegistry();
  const leases = [
    registry.acquire({
      provider: 'codex',
      providerInstanceId: 'codex-local',
      sessionId: 'same-id',
      executionId: 'codex-1',
    }),
    registry.acquire({
      provider: 'codex',
      providerInstanceId: 'codex-work',
      sessionId: 'same-id',
      executionId: 'codex-2',
    }),
    registry.acquire({
      provider: 'claude-code',
      providerInstanceId: 'claude-local',
      sessionId: 'same-id',
      executionId: 'claude-1',
    }),
  ];
  assert.equal(registry.snapshot().length, 3);
  for (const lease of leases) lease.release();
});
