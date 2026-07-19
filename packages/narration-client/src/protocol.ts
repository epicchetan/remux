export type NarrationBlockKind =
  | 'paragraph'
  | 'heading'
  | 'listItem'
  | 'blockquote'
  | 'code'
  | 'table'
  | 'diagram';

export type NarrationHighlightMode = 'block' | 'text';

export type NarrationSourceBlock = {
  highlightMode: NarrationHighlightMode;
  id: string;
  kind: NarrationBlockKind;
  text: string;
};

export type NarrationSourceDocument = {
  blocks: NarrationSourceBlock[];
  offsetEncoding: 'utf16CodeUnit';
  schemaVersion: 1;
};

export type NarrationStartParams = { document: NarrationSourceDocument };
export type NarrationStartResponse = {
  artifactKey: string;
  resource: NarrationResource;
  status: 'accepted';
};
export type NarrationReadParams = {
  artifactKey: string;
  knownRevision?: string | null;
};
export type NarrationReadResponse = {
  resource: NarrationResource | null;
  status: 'missing' | 'notModified' | 'ok';
};
export type NarrationCancelParams = { artifactKey: string };
export type NarrationCancelResponse = { artifactKey: string; status: 'accepted' };

export type NarrationStage =
  | 'baseline'
  | 'languagePlanning'
  | 'planning'
  | 'loadingModel'
  | 'synthesizing'
  | 'finalizing'
  | 'ready';

export type NarrationProgress = {
  auditWindowsCompleted: number;
  auditWindowsTotal: number;
  transcriptWindowsCompleted: number;
  transcriptWindowsTotal: number;
  chunksCompleted: number;
  chunksTotal: number;
  sentences: number;
  stage: NarrationStage;
  words: number;
};

export type NarrationResourceStatus =
  | 'preparing'
  | 'synthesizing'
  | 'finalizing'
  | 'ready'
  | 'failed'
  | 'cancelled';

export type NarrationResource = {
  artifactKey: string;
  complete: boolean;
  error: string | null;
  manifest: NarrationArtifact | null;
  progress: NarrationProgress;
  revision: string;
  status: NarrationResourceStatus;
};

export type NarrationUpdatedNotification = { artifactKey: string };

export type NarrationArtifact = {
  artifactKey: string;
  audio: NarrationAudio;
  blocks: NarrationBlockTiming[];
  documentHash: string;
  offsetEncoding: 'utf16CodeUnit';
  pronunciationPlanSha256: string;
  structuralTranscriptPlanSha256: string;
  profile: NarrationProfile;
  schemaVersion: 4;
  sentences: NarrationSentence[];
  wordCues: NarrationWordCue[];
};

export type NarrationAudio = {
  channels: 1;
  mimeType: 'audio/wav';
  sampleRate: 24000;
  sha256: string;
  sizeBytes: number;
  totalSamples: number;
  url: `/remux/media/sha256/${string}`;
};

export type NarrationBlockTiming = {
  blockId: string;
  endSample: number;
  startSample: number;
};

export type NarrationSentence = {
  blockId: string;
  endSample: number;
  id: string;
  startSample: number;
  textEnd: number;
  textStart: number;
};

export type NarrationWordCue = {
  blockId: string;
  endSample: number;
  sentenceId: string;
  startSample: number;
  textEnd: number;
  textStart: number;
};

export type NarrationPlaybackRate = 0.75 | 1 | 1.25 | 1.5 | 2;

export type NarrationProfile = {
  phonemizer: string;
  plannerVersion: number;
  pronunciationReviewer: NarrationPronunciationReviewerProfile;
  structuralTranscript: NarrationStructuralTranscriptProfile;
  sentenceVersion: number;
  sourceMapperVersion: number;
  synthesizerHash: string;
  timingVersion: number;
  wordSegmenterVersion: number;
};

export type NarrationPronunciationReviewerProfile = {
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

export type NarrationStructuralTranscriptProfile = {
  effort: 'low';
  model: 'gpt-5.6-sol';
  outputSchemaVersion: number;
  profileDigest: string;
  promptVersion: number;
  serviceTier: 'priority';
  windowPlannerVersion: number;
};
