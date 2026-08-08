import assert from 'node:assert/strict';
import test from 'node:test';

import {
  compileProjectContext,
  renderCompiledProjectContext,
} from '../server/src/project-state/context.ts';
import {
  applyProjectTransaction,
  projectStateBytes,
  projectStateHash,
  ProjectStateError,
  rebaseProjectTransaction,
} from '../server/src/project-state/kernel.ts';
import {
  createProjectState,
  type ProjectState,
  type ProjectTransaction,
} from '../server/src/project-state/model.ts';

const projectId = 'project:remux';
const rootSpaceId = 'space:remux';

test('context spaces share ancestor state without leaking sibling work', () => {
  const state = createRemuxFixture();
  const contextCompiler = compileProjectContext(state, 'space:context-compiler');
  const providerPreflight = compileProjectContext(state, 'space:provider-preflight');
  const ledger = compileProjectContext(state, 'space:ledger');

  assert.deepEqual(contextCompiler.chain.map(({ id }) => id), [
    rootSpaceId,
    'space:harness',
    'space:context-compiler',
  ]);
  assert.deepEqual(providerPreflight.chain.map(({ id }) => id), [
    rootSpaceId,
    'space:harness',
    'space:provider-preflight',
  ]);
  assert.deepEqual(ledger.chain.map(({ id }) => id), [rootSpaceId, 'space:ledger']);

  for (const compiled of [contextCompiler, providerPreflight, ledger]) {
    assert.ok(effectiveIds(compiled).has('primary:root-instructions'));
  }
  for (const compiled of [contextCompiler, providerPreflight]) {
    assert.ok(effectiveIds(compiled).has('primary:architecture'));
  }
  assert.ok(!effectiveIds(ledger).has('primary:architecture'));
  assert.ok(effectiveIds(contextCompiler).has('primary:context-goal'));
  assert.ok(!effectiveIds(providerPreflight).has('primary:context-goal'));
  assert.ok(!effectiveIds(ledger).has('primary:context-goal'));
  assert.ok(effectiveIds(providerPreflight).has('primary:provider-goal'));
  assert.ok(!effectiveIds(contextCompiler).has('primary:provider-goal'));
  assert.ok(effectiveIds(ledger).has('primary:ledger-goal'));
  assert.ok(!effectiveIds(contextCompiler).has('primary:ledger-goal'));

  const contextDecision = contextCompiler.effective.find(
    ({ primaryId }) => primaryId === 'primary:accepted-design',
  );
  assert.deepEqual(contextDecision, {
    primaryId: 'primary:accepted-design',
    mode: 'inline',
    sourceSpaceIds: ['space:harness', 'space:context-compiler'],
  });
  assert.deepEqual(
    providerPreflight.effective.find(({ primaryId }) => primaryId === 'primary:accepted-design'),
    {
      primaryId: 'primary:accepted-design',
      mode: 'index',
      sourceSpaceIds: ['space:harness'],
    },
  );
  assert.ok(!effectiveIds(providerPreflight).has('primary:transport-decision'));
  assert.ok(effectiveIds(contextCompiler).has('primary:transport-decision'));
  assert.deepEqual(
    providerPreflight.layers.at(-1)?.masked.map(({ primary }) => primary.id),
    ['primary:transport-decision'],
  );

  assert.equal(state.primaries.size, 7);
  assert.equal(
    [...state.bindings.values()].filter(
      ({ primaryId }) => primaryId === 'primary:accepted-design',
    ).length,
    2,
  );
  assert.equal(state.relations.size, 1);
});

test('the Remux hierarchy has a stable, inspectable context rendering', () => {
  const rendered = renderCompiledProjectContext(
    compileProjectContext(createRemuxFixture(), 'space:provider-preflight'),
  );
  assert.equal(rendered, `<project-context project="project:remux">
<space key="remux" id="space:remux">
  <primary mode="inline" key="root-instructions" kind="instruction">
    {"text":"Work directly on main and preserve user changes."}
  </primary>
</space>
<space key="harness" id="space:harness">
  <primary mode="index" key="accepted-design" kind="decision">
    {"summary":"Use bindings to promote without copying.","title":"Layered context"}
  </primary>
  <primary mode="inline" key="architecture" kind="model">
    {"text":"Journal evidence feeds layered project context."}
  </primary>
</space>
<space key="provider-preflight" id="space:provider-preflight">
  <primary mode="inline" key="provider-goal" kind="goal">
    {"text":"Keep provider preflight subscription-safe."}
  </primary>
  <primary mode="masked" id="primary:transport-decision" />
</space>
</project-context>
`);
});

test('independent stale transactions rebase while conflicting primary updates do not', () => {
  const base = createRemuxFixture();
  const contextTransaction: ProjectTransaction = {
    operationId: 'operation:context-note',
    projectId,
    basisRevision: base.revision,
    operations: [
      {
        type: 'create_primary',
        primary: {
          id: 'primary:context-note',
          homeSpaceId: 'space:context-compiler',
          key: 'context-note',
          kind: 'note',
          descriptor: { title: 'Context note' },
          body: { text: 'Independent context work.' },
          authority: 'model',
          provenance: ['journal:event-context'],
        },
      },
      {
        type: 'bind',
        spaceId: 'space:context-compiler',
        primaryId: 'primary:context-note',
        mode: 'inline',
        provenance: ['journal:event-context'],
      },
    ],
  };
  const ledgerTransaction: ProjectTransaction = {
    operationId: 'operation:ledger-note',
    projectId,
    basisRevision: base.revision,
    operations: [
      {
        type: 'create_primary',
        primary: {
          id: 'primary:ledger-note',
          homeSpaceId: 'space:ledger',
          key: 'ledger-note',
          kind: 'note',
          descriptor: { title: 'Ledger note' },
          body: { text: 'Independent ledger work.' },
          authority: 'model',
          provenance: ['journal:event-ledger'],
        },
      },
      {
        type: 'bind',
        spaceId: 'space:ledger',
        primaryId: 'primary:ledger-note',
        mode: 'inline',
        provenance: ['journal:event-ledger'],
      },
    ],
  };

  const afterContext = applyProjectTransaction(base, contextTransaction);
  assert.throws(
    () => applyProjectTransaction(afterContext, ledgerTransaction),
    (error: unknown) => error instanceof ProjectStateError && error.code === 'stale_revision',
  );
  const ledgerRebase = rebaseProjectTransaction(afterContext, ledgerTransaction);
  assert.equal(ledgerRebase.status, 'ready');
  if (ledgerRebase.status !== 'ready') return;
  const merged = applyProjectTransaction(afterContext, ledgerRebase.transaction);
  assert.ok(merged.primaries.has('primary:context-note'));
  assert.ok(merged.primaries.has('primary:ledger-note'));

  const firstUpdate: ProjectTransaction = {
    operationId: 'operation:architecture-a',
    projectId,
    basisRevision: merged.revision,
    operations: [{
      type: 'update_primary',
      primaryId: 'primary:architecture',
      ifVersion: 1,
      changes: { body: { text: 'Architecture A.' } },
    }],
  };
  const competingUpdate: ProjectTransaction = {
    operationId: 'operation:architecture-b',
    projectId,
    basisRevision: merged.revision,
    operations: [{
      type: 'update_primary',
      primaryId: 'primary:architecture',
      ifVersion: 1,
      changes: { body: { text: 'Architecture B.' } },
    }],
  };
  const afterFirstUpdate = applyProjectTransaction(merged, firstUpdate);
  const competingRebase = rebaseProjectTransaction(afterFirstUpdate, competingUpdate);
  assert.deepEqual(competingRebase, {
    status: 'conflict',
    code: 'version_conflict',
    message: 'Primary primary:architecture is version 2, not 1.',
  });
});

test('state transitions preserve prior versions and replay to deterministic bytes', () => {
  const first = createRemuxFixture();
  const second = createRemuxFixture();
  assert.equal(projectStateBytes(first), projectStateBytes(second));
  assert.equal(projectStateHash(first), projectStateHash(second));

  const oldArchitecture = first.primaries.get('primary:architecture');
  const mutableBody = { text: 'Updated architecture.' };
  const updated = applyProjectTransaction(first, {
    operationId: 'operation:update-architecture',
    projectId,
    basisRevision: first.revision,
    operations: [{
      type: 'update_primary',
      primaryId: 'primary:architecture',
      ifVersion: 1,
      changes: { body: mutableBody },
    }],
  });
  mutableBody.text = 'Mutated outside the state engine.';
  assert.equal(oldArchitecture?.version, 1);
  assert.deepEqual(oldArchitecture?.body, {
    text: 'Journal evidence feeds layered project context.',
  });
  assert.equal(updated.primaries.get('primary:architecture')?.version, 2);
  assert.deepEqual(updated.primaries.get('primary:architecture')?.body, {
    text: 'Updated architecture.',
  });
  assert.notEqual(projectStateHash(first), projectStateHash(updated));

  assert.throws(
    () => applyProjectTransaction(updated, {
      operationId: 'operation:duplicate-key',
      projectId,
      basisRevision: updated.revision,
      operations: [{
        type: 'create_primary',
        primary: {
          id: 'primary:duplicate-architecture',
          homeSpaceId: 'space:harness',
          key: 'architecture',
          kind: 'note',
          descriptor: {},
          body: {},
          authority: 'model',
          provenance: ['journal:event-duplicate'],
        },
      }],
    }),
    (error: unknown) => error instanceof ProjectStateError && error.code === 'identity_conflict',
  );
});

test('unrelated sibling commits leave rendered context bytes unchanged', () => {
  const before = createRemuxFixture();
  const renderedBefore = renderCompiledProjectContext(
    compileProjectContext(before, 'space:context-compiler'),
  );
  const after = applyProjectTransaction(before, {
    operationId: 'operation:ledger-cache-check',
    projectId,
    basisRevision: before.revision,
    operations: [
      {
        type: 'create_primary',
        primary: {
          id: 'primary:ledger-cache-check',
          homeSpaceId: 'space:ledger',
          key: 'ledger-cache-check',
          kind: 'note',
          descriptor: { title: 'Ledger-only state' },
          body: { text: 'This must not perturb a harness prompt.' },
          authority: 'model',
          provenance: ['journal:event-ledger-cache-check'],
        },
      },
      bind('space:ledger', 'primary:ledger-cache-check', 'inline'),
    ],
  });
  assert.equal(after.revision, before.revision + 1);
  assert.equal(
    renderCompiledProjectContext(compileProjectContext(after, 'space:context-compiler')),
    renderedBefore,
  );
});

test('superseding context requires explicit placement cleanup', () => {
  const before = createRemuxFixture();
  assert.throws(
    () => applyProjectTransaction(before, {
      operationId: 'operation:implicit-supersede',
      projectId,
      basisRevision: before.revision,
      operations: [
        createPrimary(
          'primary:architecture-v2',
          'space:harness',
          'architecture-v2',
          'model',
          'Harness architecture v2',
          'Replacement architecture.',
        ),
        {
          type: 'supersede_primary',
          primaryId: 'primary:architecture',
          replacementPrimaryId: 'primary:architecture-v2',
          ifVersion: 1,
        },
      ],
    }),
    (error: unknown) => error instanceof ProjectStateError
      && error.message.includes('explicitly unbound'),
  );
  assert.ok(!before.primaries.has('primary:architecture-v2'));

  const after = applyProjectTransaction(before, {
    operationId: 'operation:explicit-supersede',
    projectId,
    basisRevision: before.revision,
    operations: [
      createPrimary(
        'primary:architecture-v2',
        'space:harness',
        'architecture-v2',
        'model',
        'Harness architecture v2',
        'Replacement architecture.',
      ),
      bind('space:harness', 'primary:architecture-v2', 'inline'),
      {
        type: 'unbind',
        spaceId: 'space:harness',
        primaryId: 'primary:architecture',
        ifVersion: 1,
      },
      {
        type: 'supersede_primary',
        primaryId: 'primary:architecture',
        replacementPrimaryId: 'primary:architecture-v2',
        ifVersion: 1,
      },
    ],
  });
  assert.equal(after.primaries.get('primary:architecture')?.lifecycle, 'superseded');
  assert.equal(
    after.primaries.get('primary:architecture')?.supersededBy,
    'primary:architecture-v2',
  );
  const compiled = compileProjectContext(after, 'space:context-compiler');
  assert.ok(!effectiveIds(compiled).has('primary:architecture'));
  assert.ok(effectiveIds(compiled).has('primary:architecture-v2'));
});

function createRemuxFixture(): ProjectState {
  const state = createProjectState({
    projectId,
    rootSpaceId,
    rootKey: 'remux',
    rootDescriptor: { title: 'Remux' },
  });
  const transaction: ProjectTransaction = {
    operationId: 'operation:seed-remux',
    projectId,
    basisRevision: 0,
    operations: [
      createSpace('space:harness', rootSpaceId, 'harness', 'Harness'),
      createSpace('space:context-compiler', 'space:harness', 'context-compiler', 'Context compiler'),
      createSpace('space:provider-preflight', 'space:harness', 'provider-preflight', 'Provider preflight'),
      createSpace('space:ledger', rootSpaceId, 'ledger', 'Ledger extension'),
      createPrimary(
        'primary:root-instructions',
        rootSpaceId,
        'root-instructions',
        'instruction',
        'Root instructions',
        'Work directly on main and preserve user changes.',
      ),
      bind(rootSpaceId, 'primary:root-instructions', 'inline'),
      createPrimary(
        'primary:architecture',
        'space:harness',
        'architecture',
        'model',
        'Harness architecture',
        'Journal evidence feeds layered project context.',
      ),
      bind('space:harness', 'primary:architecture', 'inline'),
      createPrimary(
        'primary:context-goal',
        'space:context-compiler',
        'context-compiler-goal',
        'goal',
        'Context compiler goal',
        'Compile cache-friendly context without manual compaction.',
      ),
      bind('space:context-compiler', 'primary:context-goal', 'inline'),
      createPrimary(
        'primary:provider-goal',
        'space:provider-preflight',
        'provider-goal',
        'goal',
        'Provider preflight goal',
        'Keep provider preflight subscription-safe.',
      ),
      bind('space:provider-preflight', 'primary:provider-goal', 'inline'),
      createPrimary(
        'primary:ledger-goal',
        'space:ledger',
        'ledger-goal',
        'goal',
        'Ledger goal',
        'Author the Remux ledger extension.',
      ),
      bind('space:ledger', 'primary:ledger-goal', 'inline'),
      {
        type: 'create_primary',
        primary: {
          id: 'primary:accepted-design',
          homeSpaceId: 'space:context-compiler',
          key: 'accepted-design',
          kind: 'decision',
          descriptor: {
            title: 'Layered context',
            summary: 'Use bindings to promote without copying.',
          },
          body: { text: 'Primaries are placed into context spaces using explicit bindings.' },
          authority: 'user',
          provenance: ['journal:event-design-accepted'],
        },
      },
      bind('space:context-compiler', 'primary:accepted-design', 'inline'),
      bind('space:harness', 'primary:accepted-design', 'index'),
      createPrimary(
        'primary:transport-decision',
        'space:harness',
        'transport-decision',
        'decision',
        'Shared transport',
        'Use a remote provider bridge.',
      ),
      bind('space:harness', 'primary:transport-decision', 'inline'),
      {
        type: 'mask',
        spaceId: 'space:provider-preflight',
        primaryId: 'primary:transport-decision',
        provenance: ['journal:event-local-experiment'],
      },
      {
        type: 'relate',
        relation: {
          id: 'relation:design-promoted-to-harness',
          from: { type: 'primary', id: 'primary:accepted-design' },
          predicate: 'promoted-to',
          to: { type: 'space', id: 'space:harness' },
          attributes: { reason: 'Useful to sibling harness work as an index entry.' },
          provenance: ['journal:event-design-accepted'],
        },
      },
    ],
  };
  return applyProjectTransaction(state, transaction);
}

function createSpace(id: string, parentSpaceId: string, key: string, title: string) {
  return {
    type: 'create_space' as const,
    space: { id, parentSpaceId, key, descriptor: { title } },
  };
}

function createPrimary(
  id: string,
  homeSpaceId: string,
  key: string,
  kind: string,
  title: string,
  text: string,
) {
  return {
    type: 'create_primary' as const,
    primary: {
      id,
      homeSpaceId,
      key,
      kind,
      descriptor: { title },
      body: { text },
      authority: 'user' as const,
      provenance: [`journal:event-${id}`],
    },
  };
}

function bind(spaceId: string, primaryId: string, mode: 'inline' | 'index' | 'available') {
  return {
    type: 'bind' as const,
    spaceId,
    primaryId,
    mode,
    provenance: [`journal:event-bind-${spaceId}-${primaryId}`],
  };
}

function effectiveIds(compiled: ReturnType<typeof compileProjectContext>) {
  return new Set(compiled.effective.map(({ primaryId }) => primaryId));
}
