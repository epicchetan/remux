import type { BenchmarkScenario } from './contracts.ts';

const FEED_CORRECTION = `There is one focused FIFO regression to fix in crates/ledger/src/feed/es_replay/feed.rs. FeedState::regress currently derives kept from the applied batches array but recomputes next_idx from the event store. Because the external-write channel is a shared FIFO, a backward-seek clock write can apply between the feed's already queued emissions; the subsequent replace can drop those emissions while the event-store-derived index still counts them.

Make the truncated batches array the source of truth: continue from the last kept batch index, or zero when none remains. Add the short invariant comment explaining why. Extend the existing backward-seek test so the applied batches length must equal cursor.batch_idx after regression. Keep this correction narrow, run formatting and the full workspace tests, and do not commit.`;

export const LEDGER_FEED_SESSION_SCENARIO: BenchmarkScenario = {
  version: 1,
  fixtureId: 'ledger-feed-session-collaboration-v1',
  title: 'Ledger feed/session implementation with FIFO correction',
  sourceRepository: '/home/ubuntu/ledger',
  baseCommit: 'd92c6020b7729b22e709a31b2da9d7923cfc1923',
  acceptedSpecPath: 'docs/ledger_feed_system_implementation_spec.md',
  hiddenTargetCommit: '9f56c93a0bbfa7197b0f27a10fc0d1644b629f8b',
  sourceRollouts: [
    '/home/ubuntu/.codex/sessions/2026/07/07/rollout-2026-07-07T16-13-49-019f3d5b-6ccf-7010-9f9f-3af945998960.jsonl',
  ],
  sourceTurnIds: [
    '019f3d5b-6d05-72b3-82ce-52472ada36e5',
    '019f3d7c-8d59-7b93-aff2-8e6cda1dc62d',
  ],
  maxUserTurns: 6,
  forbiddenPaths: [
    'Cargo.toml',
    'crates/cache/',
    'crates/runtime/',
  ],
  hiddenValidationPaths: [
    'crates/ledger/Cargo.toml',
    'crates/ledger/tests/clock.rs',
    'crates/ledger/tests/es_replay_feed.rs',
    'crates/ledger/tests/session.rs',
    'crates/ledger/tests/support/mod.rs',
    'crates/store/Cargo.toml',
    'crates/store/src/lib.rs',
    'crates/store/src/test_util.rs',
  ],
  requiredCommands: [
    'cargo fmt --all -- --check',
    'cargo test --workspace',
  ],
  stages: [
    {
      id: 'audit',
      title: 'Audit the accepted specification without editing',
      ownerIntent: [
        'Read the accepted feed-system specification first.',
        'Ground the proposed implementation in the current repository.',
        'Explain risks and validation before any write authorization.',
      ],
      defaultPrompt: [
        'Please read docs/ledger_feed_system_implementation_spec.md first and audit it against the current implementation.',
        'Walk me through how you would implement it, including the important lifecycle and validation risks.',
        'Do not change any files yet.',
      ].join(' '),
      permissions: { mayWrite: false, mayCommit: false, mayPush: false },
    },
    {
      id: 'implement',
      title: 'Authorize the accepted implementation',
      ownerIntent: [
        'Accept the grounded proposal from the preceding turn.',
        'Authorize implementation without restating the spec.',
        'Keep commit and push unauthorized.',
      ],
      defaultPrompt: 'This looks good. Let\'s proceed with the implementation. Do not commit or push anything.',
      permissions: { mayWrite: true, mayCommit: false, mayPush: false },
    },
    {
      id: 'fifo-correction',
      title: 'Apply the historical FIFO correction',
      ownerIntent: [
        'Correct the precise backward-seek FIFO race discovered after implementation.',
        'Keep the change narrow and add its invariant test.',
      ],
      defaultPrompt: FEED_CORRECTION,
      permissions: { mayWrite: true, mayCommit: false, mayPush: false },
    },
    {
      id: 'final-audit',
      title: 'Audit and validate the completed implementation',
      ownerIntent: [
        'Audit the working tree against the exact accepted spec.',
        'Fix only genuine remaining issues.',
        'Run independent final validation and report honestly.',
      ],
      defaultPrompt: [
        'Please audit the completed implementation against the accepted spec, fix anything you find, and run the full validation.',
        'Do not commit or push.',
      ].join(' '),
      permissions: { mayWrite: true, mayCommit: false, mayPush: false },
    },
  ],
};

const SCENARIOS = new Map([[LEDGER_FEED_SESSION_SCENARIO.fixtureId, LEDGER_FEED_SESSION_SCENARIO]]);

export function benchmarkScenario(fixtureId: string) {
  const scenario = SCENARIOS.get(fixtureId);
  if (!scenario) throw new Error(`Unknown benchmark scenario: ${fixtureId}`);
  return scenario;
}

export function benchmarkScenarios() {
  return [...SCENARIOS.values()];
}
