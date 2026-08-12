import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import type { BenchmarkScenario } from './contracts.ts';

const SCENARIO_ROOT = resolve(import.meta.dirname, 'scenarios');

function scenarioText(path: string) {
  return readFileSync(resolve(SCENARIO_ROOT, path), 'utf8').trim();
}

export const LEDGER_PROJECTION_TIME_BARS_SCENARIO: BenchmarkScenario = {
  version: 3,
  suite: 'parity',
  fixtureId: 'ledger-projection-time-bars-strict-v1',
  title: 'Strict Ledger projection/time-bars implementation parity',
  sourceRepository: '/home/ubuntu/ledger',
  baseCommit: '9f56c93a0bbfa7197b0f27a10fc0d1644b629f8b',
  referenceCommit: 'b8512c9',
  sourceRollouts: [
    '/home/ubuntu/.codex/sessions/2026/07/08/rollout-2026-07-08T02-01-24-019f3f75-6062-7b22-a7d4-288dadb9ce48.jsonl',
  ],
  sourceTurnIds: ['019f3f75-6098-7cb1-9f15-0c873f46c638'],
  visibleInputs: [{
    path: 'docs/ledger_projection_system_implementation_spec.md',
    sourceRef: 'b8512c9',
    sourcePath: 'docs/ledger_projection_system_implementation_spec.md',
  }],
  governingPaths: ['docs/ledger_projection_system_implementation_spec.md'],
  fixedPrompt: scenarioText('projection-parity/prompt.md'),
  driverCardPath: null,
  driverBrief: {
    goal: 'Implement the final Ledger projection/time-bars specification exactly for an Agent-versus-Codex parity comparison.',
    background: [
      'The checked-in projection implementation specification is the governing contract.',
      'The checked-in projection implementation specification is final and authoritative.',
      'Correct deterministic replay, seek regression, cell ownership, public compatibility, session wiring, and validation are acceptance-critical.',
    ],
    constraints: [
      'Do not expose the historical reference implementation or evaluator-only tests.',
      'Do not commit or push.',
      'Preserve unrelated work and keep changes within the projection/session/CLI surface authorized by the governing specification.',
    ],
    defaultAuthority: { mayWrite: true, mayCommit: false, mayPush: false },
  },
  maxUserTurns: 1,
  maxDurationMs: 90 * 60_000,
  forbiddenPaths: [
    'Cargo.toml',
    'crates/cache/',
    'crates/runtime/',
    'crates/store/',
    'crates/remux/',
    'lens/',
  ],
  evaluator: {
    overlayPaths: [
      'crates/ledger/tests/projection_bars.rs',
      'crates/ledger/tests/projection_spec.rs',
      'crates/ledger/tests/support/mod.rs',
    ],
    overlayRewrites: [
      {
        path: 'crates/ledger/tests/projection_bars.rs',
        from: 'use ledger::projection::{Bar, BarsCells, BarsParams, BarsStatus};',
        to: 'use ledger::projection::bars::{Bar, BarsCells, BarsParams, BarsStatus};',
      },
      {
        path: 'crates/ledger/tests/projection_spec.rs',
        from: 'use ledger::projection::{BarsParams, ProjectionSpec};',
        to: 'use ledger::projection::bars::BarsParams;\nuse ledger::projection::ProjectionSpec;',
      },
    ],
    formatCommand: {
      id: 'cargo-fmt',
      file: 'cargo',
      args: ['fmt', '--all', '--', '--check'],
    },
    behavioralCommand: {
      id: 'workspace-behavior',
      file: 'cargo',
      args: ['test', '--workspace'],
      heavy: true,
    },
  },
};

export const LEDGER_FEED_SESSION_WORKFLOW_SCENARIO: BenchmarkScenario = {
  version: 3,
  suite: 'workflow',
  fixtureId: 'ledger-feed-session-workflow-v1',
  title: 'Collaborative Ledger feed/session implementation workflow',
  sourceRepository: '/home/ubuntu/ledger',
  baseCommit: 'd92c6020b7729b22e709a31b2da9d7923cfc1923',
  referenceCommit: '9f56c93a0bbfa7197b0f27a10fc0d1644b629f8b',
  sourceRollouts: [
    '/home/ubuntu/.codex/sessions/2026/07/07/rollout-2026-07-07T16-13-49-019f3d5b-6ccf-7010-9f9f-3af945998960.jsonl',
  ],
  sourceTurnIds: [
    '019f3d5b-6d05-72b3-82ce-52472ada36e5',
    '019f3d7c-8d59-7b93-aff2-8e6cda1dc62d',
  ],
  visibleInputs: [{
    path: 'docs/ledger_feed_system_implementation_spec.md',
    sourceRef: 'd92c6020b7729b22e709a31b2da9d7923cfc1923',
    sourcePath: 'docs/ledger_feed_system_implementation_spec.md',
  }],
  governingPaths: ['docs/ledger_feed_system_implementation_spec.md'],
  fixedPrompt: null,
  driverCardPath: resolve(SCENARIO_ROOT, 'feed-workflow/driver-card.md'),
  driverBrief: {
    goal: 'Explore, decide, implement, and skeptically validate the Ledger feed/session system across a natural multi-turn collaboration.',
    background: [
      'The checked-in feed-system specification is the governing authority.',
      'The owner wants a repository-grounded discussion before implementation and may add constraints after seeing the design.',
      'The final implementation must preserve deterministic replay and the accepted public compatibility contract.',
    ],
    constraints: [
      'Do not expose the historical reference implementation, source rollout, or evaluator tests.',
      'Do not commit or push.',
      'Cache and runtime internals, Remux, and Lens are out of scope.',
    ],
    defaultAuthority: { mayWrite: false, mayCommit: false, mayPush: false },
  },
  maxUserTurns: 6,
  maxDurationMs: 90 * 60_000,
  forbiddenPaths: [
    'crates/cache/',
    'crates/runtime/',
    'crates/remux/',
    'lens/',
  ],
  evaluator: {
    overlayPaths: [
      'crates/ledger/tests/clock.rs',
      'crates/ledger/tests/es_replay_feed.rs',
      'crates/ledger/tests/session.rs',
      'crates/ledger/tests/support/mod.rs',
      // The reference acceptance tests share Store's test-only in-memory
      // remote. Overlay the helper and its feature declaration with the tests
      // so candidates are not required to infer evaluator infrastructure that
      // is absent from the governing specification.
      'crates/store/Cargo.toml',
      'crates/store/src/lib.rs',
      'crates/store/src/test_util.rs',
    ],
    overlayRewrites: [],
    formatCommand: {
      id: 'cargo-fmt',
      file: 'cargo',
      args: ['fmt', '--all', '--', '--check'],
    },
    behavioralCommand: {
      id: 'workspace-behavior',
      file: 'cargo',
      args: ['test', '--workspace'],
      heavy: true,
    },
  },
};

const SCENARIOS = new Map([
  [LEDGER_PROJECTION_TIME_BARS_SCENARIO.fixtureId, LEDGER_PROJECTION_TIME_BARS_SCENARIO],
  [LEDGER_FEED_SESSION_WORKFLOW_SCENARIO.fixtureId, LEDGER_FEED_SESSION_WORKFLOW_SCENARIO],
]);

export function benchmarkScenario(fixtureId: string) {
  const scenario = SCENARIOS.get(fixtureId);
  if (!scenario) throw new Error(`Unknown benchmark scenario: ${fixtureId}`);
  return scenario;
}

export function benchmarkScenarios() {
  return [...SCENARIOS.values()];
}
