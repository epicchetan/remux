import {
  canonicalJson,
  canonicalJsonHash,
  type CanonicalJsonValue,
} from '../storage/canonical-json.ts';
import {
  contextBindingKey,
  type BindingMode,
  type ContextBinding,
  type ContextSpace,
  type ProjectEntityRef,
  type ProjectOperation,
  type ProjectPrimary,
  type ProjectRelation,
  type ProjectState,
  type ProjectTransaction,
} from './model.ts';

export type ProjectStateErrorCode =
  | 'invalid_transaction'
  | 'missing_entity'
  | 'identity_conflict'
  | 'stale_revision'
  | 'version_conflict';

export class ProjectStateError extends Error {
  readonly code: ProjectStateErrorCode;

  constructor(code: ProjectStateErrorCode, message: string) {
    super(message);
    this.name = 'ProjectStateError';
    this.code = code;
  }
}

export type RebaseResult =
  | {
    status: 'ready';
    transaction: ProjectTransaction;
    fromRevision: number;
    toRevision: number;
  }
  | {
    status: 'conflict';
    code: ProjectStateErrorCode;
    message: string;
  };

export function applyProjectTransaction(
  state: ProjectState,
  transaction: ProjectTransaction,
): ProjectState {
  assertIdentifier(transaction.operationId, 'operationId');
  if (transaction.projectId !== state.projectId) {
    throw new ProjectStateError(
      'invalid_transaction',
      `Transaction project ${transaction.projectId} does not match ${state.projectId}.`,
    );
  }
  if (transaction.basisRevision !== state.revision) {
    throw new ProjectStateError(
      'stale_revision',
      `Transaction basis ${transaction.basisRevision} does not match revision ${state.revision}.`,
    );
  }
  if (transaction.operations.length === 0) {
    throw new ProjectStateError('invalid_transaction', 'A transaction must contain an operation.');
  }
  if (!Number.isSafeInteger(state.revision) || state.revision < 0) {
    throw new ProjectStateError('invalid_transaction', `Invalid project revision ${state.revision}.`);
  }
  const nextRevision = state.revision + 1;
  if (!Number.isSafeInteger(nextRevision)) {
    throw new ProjectStateError('invalid_transaction', 'Project revision overflow.');
  }

  const draft: MutableProjectState = {
    spaces: new Map(state.spaces),
    primaries: new Map(state.primaries),
    bindings: new Map(state.bindings),
    relations: new Map(state.relations),
  };
  for (const operation of transaction.operations) {
    applyOperation(state, draft, operation, nextRevision);
  }
  return {
    projectId: state.projectId,
    revision: nextRevision,
    rootSpaceId: state.rootSpaceId,
    spaces: draft.spaces,
    primaries: draft.primaries,
    bindings: draft.bindings,
    relations: draft.relations,
  };
}

export function rebaseProjectTransaction(
  state: ProjectState,
  transaction: ProjectTransaction,
): RebaseResult {
  if (!Number.isSafeInteger(transaction.basisRevision) || transaction.basisRevision < 0) {
    return {
      status: 'conflict',
      code: 'invalid_transaction',
      message: `Invalid transaction basis ${transaction.basisRevision}.`,
    };
  }
  if (transaction.basisRevision > state.revision) {
    return {
      status: 'conflict',
      code: 'stale_revision',
      message: `Transaction basis ${transaction.basisRevision} is ahead of revision ${state.revision}.`,
    };
  }
  const rebased = transaction.basisRevision === state.revision
    ? transaction
    : { ...transaction, basisRevision: state.revision };
  try {
    applyProjectTransaction(state, rebased);
    return {
      status: 'ready',
      transaction: rebased,
      fromRevision: transaction.basisRevision,
      toRevision: state.revision,
    };
  } catch (error) {
    if (error instanceof ProjectStateError) {
      return { status: 'conflict', code: error.code, message: error.message };
    }
    throw error;
  }
}

export function projectStateSnapshot(state: ProjectState): CanonicalJsonValue {
  return {
    bindings: [...state.bindings.values()].toSorted(compareBinding).map((binding) => ({
      createdRevision: binding.createdRevision,
      mode: binding.mode,
      primaryId: binding.primaryId,
      provenance: [...binding.provenance],
      spaceId: binding.spaceId,
      updatedRevision: binding.updatedRevision,
      version: binding.version,
    })),
    primaries: [...state.primaries.values()].toSorted(compareById).map((primary) => ({
      authority: primary.authority,
      body: primary.body,
      createdRevision: primary.createdRevision,
      descriptor: primary.descriptor,
      homeSpaceId: primary.homeSpaceId,
      id: primary.id,
      key: primary.key,
      kind: primary.kind,
      lifecycle: primary.lifecycle,
      projectId: primary.projectId,
      provenance: [...primary.provenance],
      supersededBy: primary.supersededBy,
      updatedRevision: primary.updatedRevision,
      version: primary.version,
    })),
    projectId: state.projectId,
    relations: [...state.relations.values()].toSorted(compareById).map((relation) => ({
      attributes: relation.attributes,
      createdRevision: relation.createdRevision,
      from: relation.from,
      id: relation.id,
      predicate: relation.predicate,
      projectId: relation.projectId,
      provenance: [...relation.provenance],
      to: relation.to,
      version: relation.version,
    })),
    revision: state.revision,
    rootSpaceId: state.rootSpaceId,
    spaces: [...state.spaces.values()].toSorted(compareById).map((space) => ({
      createdRevision: space.createdRevision,
      descriptor: space.descriptor,
      id: space.id,
      key: space.key,
      parentSpaceId: space.parentSpaceId,
      projectId: space.projectId,
    })),
  };
}

export function projectStateHash(state: ProjectState) {
  return canonicalJsonHash(projectStateSnapshot(state));
}

export function projectStateBytes(state: ProjectState) {
  return canonicalJson(projectStateSnapshot(state));
}

type MutableProjectState = {
  spaces: Map<string, ContextSpace>;
  primaries: Map<string, ProjectPrimary>;
  bindings: Map<string, ContextBinding>;
  relations: Map<string, ProjectRelation>;
};

function applyOperation(
  state: ProjectState,
  draft: MutableProjectState,
  operation: ProjectOperation,
  revision: number,
) {
  switch (operation.type) {
    case 'create_space': {
      const input = operation.space;
      assertIdentifier(input.id, 'space.id');
      assertIdentifier(input.key, 'space.key');
      if (draft.spaces.has(input.id)) {
        conflict('identity_conflict', `Space ${input.id} already exists.`);
      }
      const parent = requireSpace(draft, input.parentSpaceId);
      if ([...draft.spaces.values()].some(
        (candidate) => candidate.parentSpaceId === parent.id && candidate.key === input.key,
      )) {
        conflict('identity_conflict', `Space key ${input.key} already exists below ${parent.id}.`);
      }
      const space: ContextSpace = Object.freeze({
        id: input.id,
        projectId: state.projectId,
        parentSpaceId: parent.id,
        key: input.key,
        descriptor: cloneCanonical(input.descriptor, 'space.descriptor'),
        createdRevision: revision,
      });
      draft.spaces.set(space.id, space);
      return;
    }
    case 'create_primary': {
      const input = operation.primary;
      assertIdentifier(input.id, 'primary.id');
      assertIdentifier(input.key, 'primary.key');
      assertIdentifier(input.kind, 'primary.kind');
      if (!['user', 'observed', 'model'].includes(input.authority)) {
        throw new ProjectStateError(
          'invalid_transaction',
          `Unknown primary authority ${String(input.authority)}.`,
        );
      }
      requireSpace(draft, input.homeSpaceId);
      if (draft.primaries.has(input.id)) {
        conflict('identity_conflict', `Primary ${input.id} already exists.`);
      }
      assertActiveKeyAvailable(draft, input.homeSpaceId, input.key);
      const primary: ProjectPrimary = Object.freeze({
        id: input.id,
        projectId: state.projectId,
        homeSpaceId: input.homeSpaceId,
        key: input.key,
        kind: input.kind,
        descriptor: cloneCanonical(input.descriptor, 'primary.descriptor'),
        body: cloneCanonical(input.body, 'primary.body'),
        authority: input.authority,
        provenance: normalizeProvenance(input.provenance),
        lifecycle: 'active',
        supersededBy: null,
        version: 1,
        createdRevision: revision,
        updatedRevision: revision,
      });
      draft.primaries.set(primary.id, primary);
      return;
    }
    case 'update_primary': {
      const current = requirePrimary(draft, operation.primaryId);
      requireActive(current);
      assertVersion(current.version, operation.ifVersion, `Primary ${current.id}`);
      const changeKeys = Object.keys(operation.changes);
      if (changeKeys.length === 0) {
        throw new ProjectStateError('invalid_transaction', 'A primary update must contain a change.');
      }
      if (changeKeys.some((key) => !['kind', 'descriptor', 'body', 'provenance'].includes(key))) {
        throw new ProjectStateError('invalid_transaction', 'A primary update contains an unknown field.');
      }
      const next: ProjectPrimary = Object.freeze({
        ...current,
        kind: operation.changes.kind === undefined
          ? current.kind
          : checkedIdentifier(operation.changes.kind, 'primary.kind'),
        descriptor: operation.changes.descriptor === undefined
          ? current.descriptor
          : cloneCanonical(operation.changes.descriptor, 'primary.descriptor'),
        body: operation.changes.body === undefined
          ? current.body
          : cloneCanonical(operation.changes.body, 'primary.body'),
        provenance: operation.changes.provenance === undefined
          ? current.provenance
          : normalizeProvenance(operation.changes.provenance),
        version: current.version + 1,
        updatedRevision: revision,
      });
      draft.primaries.set(next.id, next);
      return;
    }
    case 'supersede_primary': {
      const current = requirePrimary(draft, operation.primaryId);
      const replacement = requirePrimary(draft, operation.replacementPrimaryId);
      requireActive(current);
      requireActive(replacement);
      if (current.id === replacement.id) {
        throw new ProjectStateError('invalid_transaction', 'A primary cannot supersede itself.');
      }
      assertVersion(current.version, operation.ifVersion, `Primary ${current.id}`);
      if ([...draft.bindings.values()].some(({ primaryId }) => primaryId === current.id)) {
        conflict(
          'version_conflict',
          `Primary ${current.id} must be explicitly unbound before it is superseded.`,
        );
      }
      draft.primaries.set(current.id, Object.freeze({
        ...current,
        lifecycle: 'superseded',
        supersededBy: replacement.id,
        version: current.version + 1,
        updatedRevision: revision,
      }));
      return;
    }
    case 'relate': {
      const input = operation.relation;
      assertIdentifier(input.id, 'relation.id');
      assertIdentifier(input.predicate, 'relation.predicate');
      if (draft.relations.has(input.id)) {
        conflict('identity_conflict', `Relation ${input.id} already exists.`);
      }
      requireEntity(draft, input.from);
      requireEntity(draft, input.to);
      const relation: ProjectRelation = Object.freeze({
        id: input.id,
        projectId: state.projectId,
        from: freezeEntityRef(input.from),
        predicate: input.predicate,
        to: freezeEntityRef(input.to),
        attributes: cloneCanonical(input.attributes, 'relation.attributes'),
        provenance: normalizeProvenance(input.provenance),
        version: 1,
        createdRevision: revision,
      });
      draft.relations.set(relation.id, relation);
      return;
    }
    case 'bind':
      if (!['inline', 'index', 'available'].includes(operation.mode)) {
        throw new ProjectStateError(
          'invalid_transaction',
          `Unknown binding mode ${String(operation.mode)}.`,
        );
      }
      setBinding(draft, operation, operation.mode, revision);
      return;
    case 'mask':
      setBinding(draft, operation, 'masked', revision);
      return;
    case 'unbind': {
      requireSpace(draft, operation.spaceId);
      requirePrimary(draft, operation.primaryId);
      const key = contextBindingKey(operation.spaceId, operation.primaryId);
      const current = draft.bindings.get(key);
      if (!current) conflict('missing_entity', `Binding ${key} does not exist.`);
      assertVersion(current.version, operation.ifVersion, `Binding ${key}`);
      draft.bindings.delete(key);
      return;
    }
    default:
      throw new ProjectStateError(
        'invalid_transaction',
        `Unknown project operation ${String((operation as { type?: unknown }).type)}.`,
      );
  }
}

function setBinding(
  draft: MutableProjectState,
  operation: Extract<ProjectOperation, { type: 'bind' | 'mask' }>,
  mode: BindingMode,
  revision: number,
) {
  requireSpace(draft, operation.spaceId);
  const primary = requirePrimary(draft, operation.primaryId);
  requireActive(primary);
  const key = contextBindingKey(operation.spaceId, operation.primaryId);
  const current = draft.bindings.get(key);
  if (current) {
    if (operation.ifVersion === undefined) {
      conflict('version_conflict', `Binding ${key} requires ifVersion ${current.version}.`);
    }
    assertVersion(current.version, operation.ifVersion, `Binding ${key}`);
  } else if (operation.ifVersion !== undefined) {
    conflict('version_conflict', `Binding ${key} does not exist at version ${operation.ifVersion}.`);
  }
  const binding: ContextBinding = Object.freeze({
    spaceId: operation.spaceId,
    primaryId: operation.primaryId,
    mode,
    provenance: normalizeProvenance(operation.provenance),
    version: current ? current.version + 1 : 1,
    createdRevision: current?.createdRevision ?? revision,
    updatedRevision: revision,
  });
  draft.bindings.set(key, binding);
}

function requireSpace(draft: MutableProjectState, id: string | null) {
  if (id === null) {
    throw new ProjectStateError('invalid_transaction', 'Only the project root may omit a parent.');
  }
  const space = draft.spaces.get(id);
  if (!space) conflict('missing_entity', `Space ${id} does not exist.`);
  return space;
}

function requirePrimary(draft: MutableProjectState, id: string) {
  const primary = draft.primaries.get(id);
  if (!primary) conflict('missing_entity', `Primary ${id} does not exist.`);
  return primary;
}

function requireEntity(draft: MutableProjectState, reference: ProjectEntityRef) {
  assertIdentifier(reference.id, `${reference.type}.id`);
  if (reference.type === 'space') return requireSpace(draft, reference.id);
  if (reference.type === 'primary') return requirePrimary(draft, reference.id);
  throw new ProjectStateError('invalid_transaction', 'Unknown relation endpoint type.');
}

function requireActive(primary: ProjectPrimary) {
  if (primary.lifecycle !== 'active') {
    conflict('version_conflict', `Primary ${primary.id} is ${primary.lifecycle}.`);
  }
}

function assertActiveKeyAvailable(draft: MutableProjectState, homeSpaceId: string, key: string) {
  const existing = [...draft.primaries.values()].find(
    (candidate) => candidate.homeSpaceId === homeSpaceId
      && candidate.key === key
      && candidate.lifecycle === 'active',
  );
  if (existing) {
    conflict('identity_conflict', `Active primary key ${key} already exists in ${homeSpaceId}.`);
  }
}

function assertVersion(actual: number, expected: number, label: string) {
  if (!Number.isSafeInteger(expected) || expected < 1 || actual !== expected) {
    conflict('version_conflict', `${label} is version ${actual}, not ${expected}.`);
  }
}

function normalizeProvenance(provenance: readonly string[]) {
  if (!Array.isArray(provenance) || provenance.length === 0) {
    throw new ProjectStateError('invalid_transaction', 'Provenance must contain an evidence reference.');
  }
  const normalized = [...new Set(provenance.map((reference) => {
    assertIdentifier(reference, 'provenance reference');
    return reference;
  }))].toSorted(compareText);
  return Object.freeze(normalized);
}

function freezeEntityRef(reference: ProjectEntityRef): ProjectEntityRef {
  return Object.freeze({ type: reference.type, id: reference.id });
}

function cloneCanonical(value: CanonicalJsonValue, label: string): CanonicalJsonValue {
  try {
    return deepFreeze(JSON.parse(canonicalJson(value)) as CanonicalJsonValue);
  } catch (error) {
    throw new ProjectStateError(
      'invalid_transaction',
      `${label} is not canonical JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function deepFreeze(value: CanonicalJsonValue): CanonicalJsonValue {
  if (value !== null && typeof value === 'object') {
    for (const child of Array.isArray(value) ? value : Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function checkedIdentifier(value: string, label: string) {
  assertIdentifier(value, label);
  return value;
}

function assertIdentifier(value: string, label: string) {
  if (typeof value !== 'string' || value.trim().length === 0 || value.includes('\0')) {
    throw new ProjectStateError('invalid_transaction', `${label} must be a non-empty string.`);
  }
}

function conflict(code: ProjectStateErrorCode, message: string): never {
  throw new ProjectStateError(code, message);
}

function compareById(left: { id: string }, right: { id: string }) {
  return compareText(left.id, right.id);
}

function compareBinding(left: ContextBinding, right: ContextBinding) {
  return compareText(left.spaceId, right.spaceId) || compareText(left.primaryId, right.primaryId);
}

function compareText(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}
