export type ThreadDocumentView = {
  documentId: string;
  versionId: string;
  content: string;
  ref: string;
};

export type ThreadPatchEdit = {
  oldText: string;
  newText: string;
};

export type ThreadPatchInput = {
  baseVersionId: string;
  edits: ThreadPatchEdit[];
};

export type ThreadReplaceInput = {
  baseVersionId: string;
  content: string;
};

export type WorkUnitEnterInput = {
  objective: string;
  doneWhen?: string[];
  resources?: WorkUnitResourceRef[];
};

export type WorkUnitReturnInput = {
  status: WorkUnitReturnStatus;
  result: string;
  threadUpdate?: string;
  resources?: WorkUnitResourceRef[];
};

export type WorkUnitReturnStatus = 'completed' | 'partial' | 'blocked';

export type WorkUnitResourceRole = 'authority' | 'deliverable' | 'evidence';

export type WorkUnitResourceRef = {
  ref: string;
  role: WorkUnitResourceRole;
  description?: string;
};

export type WorkUnitResourceView = WorkUnitResourceRef & {
  snapshot: {
    ref: string;
    hash: string;
    byteLength: number;
    mediaType: string;
    source: 'file' | 'history';
  };
  inclusion: 'materialized' | 'inherited';
};

export type WorkUnitView = {
  scopeId: string;
  parentScopeId: string;
  objective: string;
  doneWhen: string[];
  resources: WorkUnitResourceView[];
  state: 'running';
};

export type WorkUnitReturnPending = {
  scopeId: string;
  state: 'returning';
};

export type HistorySearchInput = {
  query: string;
  limit?: number;
  scope?: 'conversation' | 'project';
  include?: 'operations';
};

export type HistorySearchOptions = {
  excludeRef?: string;
};

export type HistorySearchHit = {
  ref: string;
  kind: string;
  excerpt: string;
  conversationId?: string;
  turnId?: string;
  sequence?: number;
  revision?: number;
  historical?: boolean;
};

export type HistorySearchResult = {
  query: string;
  scope: 'conversation' | 'project';
  hits: HistorySearchHit[];
  truncated: boolean;
  retention: 'ephemeral';
};

export type HistoryOpenInput = { ref: string; offset?: number; maxBytes?: number };

export type HistoryOpenResult = {
  ref: string;
  content: string;
  contentHash: string;
  offset: number;
  byteLength: number;
  totalByteLength: number;
  nextOffset: number | null;
  retention: 'ephemeral';
};
