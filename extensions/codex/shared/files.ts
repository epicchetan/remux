export type CodexFilesReadParams = {
  requests: CodexFileResourceRequest[];
};

export type CodexFileResourceRequest =
  | {
      knownRevision?: string;
      path: string;
      type: 'directoryListing';
    }
  | {
      knownRevision?: string;
      path: string;
      type: 'directoryDetails';
    }
  | {
      includeDirectories?: boolean | null;
      includeFiles?: boolean | null;
      knownRevision?: string;
      limit?: number | null;
      query: string;
      roots: string[];
      type: 'fileSearch';
    }
  | {
      knownRevision?: string;
      maxBytes?: number | null;
      path: string;
      type: 'fileBytes';
    };

export type CodexFilesReadResponse = {
  resources: CodexFileResourceResult[];
};

export type CodexFileResourceResult = {
  key: string;
  reason?: string;
  requestIndex: number;
  revision?: string;
  status: 'ok' | 'notModified' | 'missing' | 'error';
  value?: unknown;
};

export type CodexDirectoryListingResource = {
  entries: CodexDirectoryEntry[];
  path: string;
  revision: string;
};

export type CodexDirectoryEntry = {
  fileName: string;
  isDirectory: boolean;
  path: string;
};

export type CodexDirectoryDetailsResource = {
  isDirectory: boolean;
  itemCount: number | null;
  modifiedAtMs: number | null;
  path: string;
  revision: string;
  sizeBytes: number | null;
};

export type CodexFileSearchResource = {
  query: string;
  results: CodexFileSearchResult[];
  revision: string;
  roots: string[];
};

export type CodexFileSearchResult = {
  absolutePath: string;
  id: string;
  kind: 'directory' | 'file';
  name: string;
  parentPath: string;
  path: string;
  score: number;
};

export type CodexFileBytesResource = {
  dataBase64: string;
  path: string;
  revision: string;
  sizeBytes: number;
};
