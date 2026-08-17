export type WorkUnitEnterInput = {
  /** One concise model-authored statement of the work and its closing condition. */
  boundary: string;
};

export type WorkUnitReturnInput = {
  status: WorkUnitReturnStatus;
  result: string;
  /** Optional files or History references worth retaining as immutable snapshots. */
  artifacts?: string[];
};

export type WorkUnitReturnStatus = 'completed' | 'partial' | 'blocked';

export type WorkUnitArtifactView = {
  ref: string;
  snapshot: {
    ref: string;
    hash: string;
    byteLength: number;
    mediaType: string;
    source: 'file' | 'history';
  };
};

export type WorkUnitView = {
  scopeId: string;
  parentScopeId: string;
  boundary: string;
  state: 'running';
};

export type WorkUnitReturnPending = {
  scopeId: string;
  state: 'returning';
};

export type WorkUnitCompletion = {
  scopeId: string;
  status: WorkUnitReturnStatus;
  result: string;
  artifacts: WorkUnitArtifactView[];
  resultRef: string;
  historyRef: string;
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

export type HistoryOpenInput = {
  ref: string;
  offset?: number;
  maxBytes?: number;
};

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
