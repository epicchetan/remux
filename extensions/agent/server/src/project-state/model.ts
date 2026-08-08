import { canonicalJson, type CanonicalJsonValue } from '../storage/canonical-json.ts';

export type PrimaryAuthority = 'user' | 'observed' | 'model';
export type PrimaryLifecycle = 'active' | 'superseded' | 'tombstoned';
export type BindingMode = 'inline' | 'index' | 'available' | 'masked';

export type ContextSpace = {
  id: string;
  projectId: string;
  parentSpaceId: string | null;
  key: string;
  descriptor: CanonicalJsonValue;
  createdRevision: number;
};

export type ProjectPrimary = {
  id: string;
  projectId: string;
  homeSpaceId: string;
  key: string;
  kind: string;
  descriptor: CanonicalJsonValue;
  body: CanonicalJsonValue;
  authority: PrimaryAuthority;
  provenance: readonly string[];
  lifecycle: PrimaryLifecycle;
  supersededBy: string | null;
  version: number;
  createdRevision: number;
  updatedRevision: number;
};

export type ContextBinding = {
  spaceId: string;
  primaryId: string;
  mode: BindingMode;
  provenance: readonly string[];
  version: number;
  createdRevision: number;
  updatedRevision: number;
};

export type ProjectEntityRef = {
  type: 'primary' | 'space';
  id: string;
};

export type ProjectRelation = {
  id: string;
  projectId: string;
  from: ProjectEntityRef;
  predicate: string;
  to: ProjectEntityRef;
  attributes: CanonicalJsonValue;
  provenance: readonly string[];
  version: number;
  createdRevision: number;
};

export type ProjectState = {
  projectId: string;
  revision: number;
  rootSpaceId: string;
  spaces: ReadonlyMap<string, ContextSpace>;
  primaries: ReadonlyMap<string, ProjectPrimary>;
  bindings: ReadonlyMap<string, ContextBinding>;
  relations: ReadonlyMap<string, ProjectRelation>;
};

export type NewContextSpace = Pick<ContextSpace, 'id' | 'parentSpaceId' | 'key' | 'descriptor'>;

export type NewProjectPrimary = Pick<
  ProjectPrimary,
  | 'id'
  | 'homeSpaceId'
  | 'key'
  | 'kind'
  | 'descriptor'
  | 'body'
  | 'authority'
  | 'provenance'
>;

export type NewProjectRelation = Pick<
  ProjectRelation,
  'id' | 'from' | 'predicate' | 'to' | 'attributes' | 'provenance'
>;

export type ProjectOperation =
  | { type: 'create_space'; space: NewContextSpace }
  | { type: 'create_primary'; primary: NewProjectPrimary }
  | {
    type: 'update_primary';
    primaryId: string;
    ifVersion: number;
    changes: Partial<Pick<ProjectPrimary, 'kind' | 'descriptor' | 'body' | 'provenance'>>;
  }
  | {
    type: 'supersede_primary';
    primaryId: string;
    replacementPrimaryId: string;
    ifVersion: number;
  }
  | { type: 'relate'; relation: NewProjectRelation }
  | {
    type: 'bind';
    spaceId: string;
    primaryId: string;
    mode: Exclude<BindingMode, 'masked'>;
    provenance: readonly string[];
    ifVersion?: number;
  }
  | {
    type: 'mask';
    spaceId: string;
    primaryId: string;
    provenance: readonly string[];
    ifVersion?: number;
  }
  | { type: 'unbind'; spaceId: string; primaryId: string; ifVersion: number };

export type ProjectTransaction = {
  operationId: string;
  projectId: string;
  basisRevision: number;
  operations: readonly ProjectOperation[];
};

export function createProjectState(input: {
  projectId: string;
  rootSpaceId: string;
  rootKey?: string;
  rootDescriptor?: CanonicalJsonValue;
}): ProjectState {
  assertInitialIdentifier(input.projectId, 'projectId');
  assertInitialIdentifier(input.rootSpaceId, 'rootSpaceId');
  const rootKey = input.rootKey ?? 'root';
  assertInitialIdentifier(rootKey, 'rootKey');
  const root: ContextSpace = Object.freeze({
    id: input.rootSpaceId,
    projectId: input.projectId,
    parentSpaceId: null,
    key: rootKey,
    descriptor: freezeCanonical(input.rootDescriptor ?? { title: 'Project' }),
    createdRevision: 0,
  });
  return {
    projectId: input.projectId,
    revision: 0,
    rootSpaceId: root.id,
    spaces: new Map([[root.id, root]]),
    primaries: new Map(),
    bindings: new Map(),
    relations: new Map(),
  };
}

export function contextBindingKey(spaceId: string, primaryId: string) {
  return JSON.stringify([spaceId, primaryId]);
}

function assertInitialIdentifier(value: string, label: string) {
  if (typeof value !== 'string' || value.trim().length === 0 || value.includes('\0')) {
    throw new TypeError(`${label} must be a non-empty string.`);
  }
}

function freezeCanonical(value: CanonicalJsonValue): CanonicalJsonValue {
  const clone = JSON.parse(canonicalJson(value)) as CanonicalJsonValue;
  if (clone !== null && typeof clone === 'object') {
    for (const child of Array.isArray(clone) ? clone : Object.values(clone)) freezeCanonicalValue(child);
    Object.freeze(clone);
  }
  return clone;
}

function freezeCanonicalValue(value: CanonicalJsonValue) {
  if (value !== null && typeof value === 'object') {
    for (const child of Array.isArray(value) ? value : Object.values(value)) freezeCanonicalValue(child);
    Object.freeze(value);
  }
}
