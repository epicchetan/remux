export type FileTreeEntry = {
  git?: FileTreeGitStatus | null;
  itemCount?: number | null;
  kind: 'directory' | 'file' | 'other' | 'symlink';
  modifiedAtMs?: number | null;
  name: string;
  path: string;
  sizeBytes?: number | null;
};

export type FileTreeGitStatus = {
  staged?: boolean;
  status: 'added' | 'conflicted' | 'deleted' | 'modified' | 'renamed' | 'untracked';
};

export type VisibleFileTreeRow = FileTreeEntry & {
  childrenLoaded: boolean;
  depth: number;
  hasChildren: boolean;
  isExpanded: boolean;
  parentPath: string | null;
};
