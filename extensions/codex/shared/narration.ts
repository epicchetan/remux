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

export type CodexNarrationSourceTarget =
  | CodexNarrationBlockTarget
  | CodexNarrationTextTarget;

export type CodexNarrationSourceBlock = {
  displayText: string;
  id: string;
  inlineRanges: CodexNarrationInlineRange[];
  kind: CodexNarrationBlockKind;
  path: string;
  targetIds: string[];
};

export type CodexNarrationSourceDocument = {
  blocks: CodexNarrationSourceBlock[];
  documentVersion: '4';
  messageId: string;
  messageRevision: string;
  schemaVersion: 3;
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

export type CodexNarrationCancelParams = { artifactKey: string };
export type CodexNarrationCancelResponse = { artifactKey: string; status: 'accepted' };
export type CodexNarrationAudioReadParams = { artifactKey: string; chunkId: string };
export type CodexNarrationAudioReadResponse = {
  artifactKey: string;
  chunkId: string;
  dataBase64: string;
  mimeType: 'audio/wav';
  sizeBytes: number;
};

export type CodexNarrationProgress = {
  committedBlocks: number;
  committedGroups: number;
  primaryModelComplete: boolean;
  synthesizedGroups: number;
  totalBlocks: number;
  workerComplete: boolean;
};

export type CodexNarrationResource = {
  artifactKey: string;
  availableDuration: number;
  availableSegments: CodexNarrationSegment[];
  complete: boolean;
  error: string | null;
  manifest: CodexNarrationManifest | null;
  progress: CodexNarrationProgress;
  revision: string;
  status: 'planning' | 'streaming' | 'finalizing' | 'ready' | 'failed' | 'cancelled';
  target: CodexNarrationTarget;
};

export type CodexNarrationUpdatedNotification = { artifactKey: string };

export type CodexNarrationProviderDescriptor = {
  id: 'narrate-codex-kokoro-streaming-v6';
  corpus: {
    compatibility: {
      compatibleEntries: number;
      entries: number;
      incompatibleEntries: number;
      unsupportedSymbols: Record<string, number>;
    };
    goldSha256: string;
    provider: 'misaki-us-gold-silver';
    resolverVersion: '3';
    silverSha256: string;
  };
  localG2p: {
    provider: 'misaki-rs';
    role: 'authoritative-phoneme-and-token-alignment';
    version: 'misaki-rs-0.3.0-us';
  };
  parserVersion: '5';
  patchGenerator: {
    baseInstructionsVersion: '6';
    effort: 'low';
    groupingPromptVersion: '4';
    instructionsSha256: string;
    model: 'gpt-5.6-sol';
    profileDigest: string;
    provider: 'codex-structured-inference';
    reasoningSummary: 'none';
    schemaSha256: string;
    schemaTemplateSha256: string;
    serviceTier: 'priority';
  };
  reviewedLexicon: {
    role: 'stable-audio-aliases';
    version: '1';
  };
  sourceMapperVersion: '11';
  synthesizer: Record<string, unknown>;
  tokenizerVersion: '2';
};

export type CodexNarrationManifest = {
  artifactKey: string;
  chunks: CodexNarrationAudioChunk[];
  corpus: { goldSha256: string; silverSha256: string };
  cues: CodexNarrationCue[];
  durationSeconds: number;
  groups: CodexNarrationGroup[];
  planDigest: string;
  profile: CodexNarrationProviderDescriptor;
  segments: CodexNarrationSegment[];
  sourceDocumentKey: string;
  sourceHash: string;
  targets: CodexNarrationSourceTarget[];
  units: CodexNarrationUnit[];
  version: 6;
};

export type CodexNarrationTimeline = Pick<
  CodexNarrationManifest,
  'chunks' | 'cues' | 'durationSeconds' | 'segments' | 'targets' | 'units'
> & { complete: boolean };

export type CodexNarrationGroup = {
  chunkId: string;
  end: number;
  firstBlockId: string;
  id: string;
  index: number;
  lastBlockId: string;
  spokenText: string;
  start: number;
};

export type CodexNarrationSegment = {
  audio: CodexNarrationAudioChunk;
  audioSamples: number;
  cues: CodexNarrationCue[];
  group: CodexNarrationGroup;
  index: number;
  units: CodexNarrationUnit[];
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
  granularity: 'block' | 'expression' | 'word';
  id: string;
  origin: 'blockFallback' | 'sourceSemantic' | 'sourceWord' | 'summaryBlock';
  spokenEnd: number;
  spokenStart: number;
  start: number;
  targetIds: string[];
  unitId: string;
};
