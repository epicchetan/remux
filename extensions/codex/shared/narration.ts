export type CodexNarrationBlockKind =
  | 'paragraph'
  | 'heading'
  | 'listItem'
  | 'blockquote'
  | 'code'
  | 'table'
  | 'diagram';

export type CodexNarrationInlineRange = {
  displayEnd: number;
  displayStart: number;
  kind: 'inlineCode' | 'link' | 'text';
};

export type CodexNarrationBlockTarget = {
  blockId: string;
  id: string;
  kind: 'block';
};

export type CodexNarrationTextTarget = {
  blockId: string;
  displayEnd: number;
  displayStart: number;
  id: string;
  kind: 'textRange';
  role: 'expression' | 'inlineCode' | 'link' | 'word';
};

export type CodexNarrationTableCellTarget = {
  blockId: string;
  column: number;
  id: string;
  kind: 'tableCell';
  role: 'body' | 'header';
  row: number;
};

export type CodexNarrationTableRegionTarget = {
  blockId: string;
  columnEnd: number;
  columnStart: number;
  id: string;
  kind: 'tableRegion';
  rowEnd: number;
  rowStart: number;
};

export type CodexNarrationCodeLinesTarget = {
  blockId: string;
  id: string;
  kind: 'codeLines';
  lineEnd: number;
  lineStart: number;
};

export type CodexNarrationDiagramNodeTarget = {
  blockId: string;
  id: string;
  kind: 'diagramNode';
  nodeId: string;
};

export type CodexNarrationSourceTarget =
  | CodexNarrationBlockTarget
  | CodexNarrationCodeLinesTarget
  | CodexNarrationDiagramNodeTarget
  | CodexNarrationTableCellTarget
  | CodexNarrationTableRegionTarget
  | CodexNarrationTextTarget;

export type CodexNarrationSourceBlock = {
  displayText: string;
  id: string;
  inlineRanges: CodexNarrationInlineRange[];
  kind: CodexNarrationBlockKind;
  needsTransform: boolean;
  path: string;
  targetIds: string[];
};

export type CodexNarrationSourceDocument = {
  blocks: CodexNarrationSourceBlock[];
  documentVersion: string;
  messageId: string;
  messageRevision: string;
  schemaVersion: 2;
  sourceHash: string;
  targets: CodexNarrationSourceTarget[];
};

export type CodexNarrationTarget = {
  assistantMessageId: string;
  messageRevision: string;
  sourceHash: string;
  threadId: string;
  turnId: string;
};

export type CodexNarrationStartParams = {
  document: CodexNarrationSourceDocument;
  sourceText: string;
  target: CodexNarrationTarget;
};

export type CodexNarrationStartResponse = {
  artifactKey: string;
  resource: CodexNarrationResource;
  status: 'accepted';
};

export type CodexNarrationReadParams = {
  artifactKey: string;
  knownRevision?: string | null;
};

export type CodexNarrationReadResponse = {
  resource: CodexNarrationResource | null;
  status: 'missing' | 'notModified' | 'ok';
};

export type CodexNarrationCancelParams = {
  artifactKey: string;
};

export type CodexNarrationCancelResponse = {
  artifactKey: string;
  status: 'accepted';
};

export type CodexNarrationAudioReadParams = {
  artifactKey: string;
  chunkId: string;
};

export type CodexNarrationAudioReadResponse = {
  artifactKey: string;
  chunkId: string;
  dataBase64: string;
  mimeType: 'audio/wav';
  sizeBytes: number;
};

export type CodexNarrationResource = {
  artifactKey: string;
  completedUnits: number | null;
  error: string | null;
  manifest: CodexNarrationManifest | null;
  revision: string;
  stage: 'planning' | 'synthesizing' | null;
  status: 'cancelled' | 'failed' | 'planning' | 'ready' | 'synthesizing';
  target: CodexNarrationTarget;
  totalUnits: number | null;
};

export type CodexNarrationUpdatedNotification = {
  artifactKey: string;
};

export type CodexNarrationProviderDescriptor = {
  acousticTiming?: {
    algorithmVersion: string;
    provider: string;
  };
  aligner?: {
    algorithmVersion: string;
    model?: string;
    modelRevision?: string;
    provider: string;
  };
  id: string;
  scriptGenerator: {
    baseInstructionsVersion?: string;
    contextProfileVersion?: string;
    contractVersion?: number;
    effort?: string;
    model: string;
    promptVersion: string;
    provider: string;
    reasoningSummary?: string;
    serviceTier?: 'priority' | 'standard';
  };
  sourceMapper?: {
    algorithmVersion: string;
    provider: string;
  };
  synthesizer: {
    model: string;
    modelRevision: string;
    optionsVersion: string;
    provider: string;
    sampleRate: number;
    voice: string;
  };
};

export type CodexNarrationManifest = {
  alignmentKey: string;
  artifactKey: string;
  audioKey: string;
  chunks: CodexNarrationAudioChunk[];
  cues: CodexNarrationCue[];
  durationSeconds: number;
  profile: CodexNarrationProviderDescriptor;
  scriptKey: string;
  sourceDocumentKey: string;
  sourceHash: string;
  targets: CodexNarrationSourceTarget[];
  units: CodexNarrationUnit[];
  version: 2;
};

export type CodexNarrationAudioChunk = {
  end: number;
  id: string;
  sampleRate: number;
  sizeBytes: number;
  start: number;
};

export type CodexNarrationUnit = {
  blockId: string;
  chunkId: string;
  end: number;
  fallbackTargetIds: string[];
  id: string;
  mode: 'normalized' | 'summary' | 'verbatim';
  sentenceRanges: CodexNarrationSentence[];
  spokenText: string;
  start: number;
};

export type CodexNarrationSentence = {
  end: number;
  spokenEnd: number;
  spokenStart: number;
  start: number;
};

export type CodexNarrationCue = {
  confidence: number;
  end: number;
  granularity:
    | 'block'
    | 'codeLines'
    | 'diagramNode'
    | 'expression'
    | 'tableCell'
    | 'tableRegion'
    | 'word';
  id: string;
  origin:
    | 'deterministic'
    | 'fallback'
    | 'forcedAlignment'
    | 'scriptHint'
    | 'sourceSemantic'
    | 'sourceWord'
    | 'summarySemantic'
    | 'ttsTiming';
  spokenEnd: number;
  spokenStart: number;
  start: number;
  targetIds: string[];
  unitId: string;
};
