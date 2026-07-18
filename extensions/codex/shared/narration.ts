export type CodexNarrationBlockKind =
  | 'paragraph'
  | 'heading'
  | 'listItem'
  | 'blockquote'
  | 'code'
  | 'table'
  | 'diagram';

export type CodexNarrationHighlightMode = 'block' | 'text';

export type CodexNarrationSourceBlock = {
  highlightMode: CodexNarrationHighlightMode;
  id: string;
  kind: CodexNarrationBlockKind;
  text: string;
};

export type CodexNarrationSourceDocument = {
  blocks: CodexNarrationSourceBlock[];
  offsetEncoding: 'utf16CodeUnit';
  schemaVersion: 1;
};

// This identity stays local to the Codex viewer. It is deliberately absent
// from the Narrate API and the cacheable artifact.
export type CodexNarrationTarget = {
  assistantMessageId: string;
  messageRevision: string;
  sourceHash: string;
  threadId: string;
  turnId: string;
};

export type CodexNarrationStartParams = {
  document: CodexNarrationSourceDocument;
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
export type CodexNarrationStage =
  | 'baseline'
  | 'languagePlanning'
  | 'planning'
  | 'loadingModel'
  | 'synthesizing'
  | 'finalizing'
  | 'ready';
export type CodexNarrationProgress = {
  auditWindowsCompleted: number;
  auditWindowsTotal: number;
  transcriptWindowsCompleted: number;
  transcriptWindowsTotal: number;
  chunksCompleted: number;
  chunksTotal: number;
  sentences: number;
  stage: CodexNarrationStage;
  words: number;
};

export type CodexNarrationResource = {
  artifactKey: string;
  complete: boolean;
  error: string | null;
  manifest: CodexNarrationArtifact | null;
  progress: CodexNarrationProgress;
  revision: string;
  status: 'preparing' | 'synthesizing' | 'finalizing' | 'ready' | 'failed' | 'cancelled';
};

export type CodexNarrationUpdatedNotification = { artifactKey: string };

export type CodexNarrationArtifact = {
  artifactKey: string;
  audio: CodexNarrationAudio;
  blocks: CodexNarrationBlockTiming[];
  documentHash: string;
  offsetEncoding: 'utf16CodeUnit';
  pronunciationPlanSha256: string;
  structuralTranscriptPlanSha256: string;
  profile: CodexNarrationProfile;
  schemaVersion: 4;
  sentences: CodexNarrationSentence[];
  wordCues: CodexNarrationWordCue[];
};

export type CodexNarrationAudio = {
  channels: 1;
  mimeType: 'audio/wav';
  sampleRate: 24000;
  sha256: string;
  sizeBytes: number;
  totalSamples: number;
  url: `/remux/media/sha256/${string}`;
};

export type CodexNarrationBlockTiming = {
  blockId: string;
  endSample: number;
  startSample: number;
};

export type CodexNarrationSentence = {
  blockId: string;
  endSample: number;
  id: string;
  startSample: number;
  textEnd: number;
  textStart: number;
};

export type CodexNarrationWordCue = {
  blockId: string;
  endSample: number;
  sentenceId: string;
  startSample: number;
  textEnd: number;
  textStart: number;
};

export type CodexNarrationProfile = {
  phonemizer: string;
  plannerVersion: number;
  pronunciationReviewer: CodexPronunciationReviewerProfile;
  structuralTranscript: CodexStructuralTranscriptProfile;
  sentenceVersion: number;
  sourceMapperVersion: number;
  synthesizerHash: string;
  timingVersion: number;
  wordSegmenterVersion: number;
};

export type CodexPronunciationReviewerProfile = {
  directPhoneValidatorVersion: number;
  effort: 'low';
  kokoroVocabularySha256: string;
  model: 'gpt-5.6-sol';
  outputSchemaVersion: number;
  phoneAlphabetSha256: string;
  phoneAlphabetVersion: number;
  profileDigest: string;
  promptVersion: number;
  serviceTier: 'priority';
  windowPlannerVersion: number;
};

export type CodexStructuralTranscriptProfile = {
  effort: 'low';
  model: 'gpt-5.6-sol';
  outputSchemaVersion: number;
  profileDigest: string;
  promptVersion: number;
  serviceTier: 'priority';
  windowPlannerVersion: number;
};
