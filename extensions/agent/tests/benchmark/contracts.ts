export const BENCHMARK_FORMAT_VERSION = 1 as const;

export type BenchmarkTarget = 'agent' | 'codex';
export type BenchmarkContextMode =
  | 'full-history'
  | 'managed-v1.1'
  | 'managed-v1.1-work-units'
  | 'stateful'
  | 'working-memory-v1'
  | 'bounded-work-units-v2';

export type BenchmarkStage = {
  id: string;
  title: string;
  ownerIntent: string[];
  defaultPrompt: string;
  permissions: {
    mayWrite: boolean;
    mayCommit: boolean;
    mayPush: boolean;
  };
};

export type BenchmarkScenario = {
  version: 1;
  fixtureId: string;
  title: string;
  sourceRepository: string;
  baseCommit: string;
  acceptedSpecPath: string;
  hiddenTargetCommit: string;
  sourceRollouts: string[];
  sourceTurnIds: string[];
  maxUserTurns: number;
  stages: BenchmarkStage[];
  forbiddenPaths: string[];
  hiddenValidationPaths: string[];
  requiredCommands: string[];
};

export type PreparedFixtureManifest = {
  version: 1;
  fixtureId: string;
  createdAt: string;
  source: {
    repositoryPath: string;
    headBefore: string;
    statusBefore: string;
    baseCommit: string;
    baseTree: string;
    acceptedSpecPath: string;
    acceptedSpecSha256: string;
    transcriptFiles: Array<{ path: string; sha256: string; bytes: number }>;
    sourceTurnIds: string[];
  };
  template: {
    path: string;
    headCommit: string;
    tree: string;
  };
  evaluation: {
    hiddenTargetCommit: string;
    hiddenTargetTree: string;
    forbiddenPaths: string[];
    requiredCommands: string[];
  };
};

export type BenchmarkTurnRecord = {
  stageId: string;
  text: string;
  turnId: string;
  startedAt: string;
  completedAt: string;
  workspaceHeadAfter: string;
  workspaceStatusAfter: string;
};

export type BenchmarkRun = {
  version: 1;
  runId: string;
  fixtureId: string;
  target: BenchmarkTarget;
  state: 'running' | 'ready-for-evaluation' | 'evaluating' | 'completed' | 'failed' | 'interrupted';
  dataRoot: string;
  workspacePath: string;
  fixtureManifestPath: string;
  conversationId: string;
  modelId: string;
  reasoning: string;
  reviewMode: string;
  speed: string;
  contextMode: BenchmarkContextMode;
  stageIndex: number;
  startedAt: string;
  updatedAt: string;
  sourceHeadBefore: string;
  sourceStatusBefore: string;
  turns: BenchmarkTurnRecord[];
  transcriptPath: string | null;
  evidencePath: string | null;
  reportPath: string | null;
  error: string | null;
};

export type BenchmarkGate = {
  id: string;
  group: 'contract' | 'safety-authority' | 'validation' | 'historical-parity';
  passed: boolean;
  detail: string;
  logPath?: string;
};

export type BenchmarkReport = {
  version: 1;
  runId: string;
  fixtureId: string;
  target: BenchmarkTarget;
  passed: boolean;
  evaluatedAt: string;
  durationMs: number;
  turns: number;
  modelId: string;
  reasoning: string;
  workspacePath: string;
  changedPaths: string[];
  gates: BenchmarkGate[];
  metrics: {
    functionCalls: number | null;
    commandCalls: number | null;
    compactionEvents: number | null;
    inputTokens: number | null;
    cachedInputTokens: number | null;
    outputTokens: number | null;
    reasoningOutputTokens: number | null;
    totalTokenUsage: number | null;
    cacheReadRatio: number | null;
    modelContextWindow: number | null;
    providerCalls: number | null;
    estimatedInputTokens: number | null;
    peakEstimatedInputTokens: number | null;
    reportedInputTokens: number | null;
    reportedOutputTokens: number | null;
    fullRequests: number | null;
    continuationRequests: number | null;
    contextFrames: number | null;
    contextRollovers: number | null;
    pressureNotices: number | null;
    workUnitCheckpointNotices: number | null;
    emergencyWorkUnitRollovers: number | null;
    rolloversWithoutPriorNotice: number | null;
    contextLimitErrors: number | null;
    contextBlockEstimatedTokens: Record<string, number> | null;
    contextOmissions: number | null;
    contextUpdates: number | null;
    journalRetrievalCalls: number | null;
    journalSearchCalls: number | null;
    journalOpenCalls: number | null;
    usefulRetrievalCalls: number | null;
    invalidContextCalls: number | null;
    selfReferentialSearchHits: number | null;
    duplicateRetrievalHits: number | null;
    primaryCreates: number | null;
    primaryRevisions: number | null;
    primaryCloses: number | null;
    primaryProvenanceSources: number | null;
    activePrimaryBytes: number | null;
    acceptedProposalEntries: number | null;
    readCalls: number | null;
    repeatedReadCalls: number | null;
    acceptedSpecReads: number | null;
    shellCalls: number | null;
    editCalls: number | null;
    writeCalls: number | null;
    testCalls: number | null;
    parentVisibleToolResultBytes: number | null;
    workUnitsEntered: number | null;
    workUnitsReturned: number | null;
    explicitWorkUnitReturns: number | null;
    implicitWorkUnitReturns: number | null;
    childProviderCalls: number | null;
    childToolCalls: number | null;
    childEstimatedInputTokens: number | null;
    childContextFrames: number | null;
    maxWorkUnitEstimatedInputTokens: number | null;
    workUnitStateCommits: number | null;
    workUnitResultBytes: number | null;
    workUnitTraceBytes: number | null;
    parentTraceReopens: number | null;
    localPrimaryLeaks: number | null;
    abandonedUnitPromotions: number | null;
    finalProjectRevision: number | null;
    memoryAttempts: number | null;
    memoryCommits: number | null;
    memoryFailures: number | null;
    memoryStaleCommits: number | null;
    memoryInputTokens: number | null;
    memoryOutputTokens: number | null;
    memoryCacheReadTokens: number | null;
    memoryDurationMs: number | null;
    finalMemoryEntries: number | null;
    finalMemoryBytes: number | null;
  };
  artifacts: {
    run: string;
    transcript: string;
    evidence: string;
    patch: string;
    rollout: string | null;
  };
};

export type VisibleBenchmarkTranscript = {
  target: BenchmarkTarget;
  conversationId: string;
  turnIds: string[];
  activeTurnId: string | null;
  assistantTextByTurn: Record<string, string>;
  raw: unknown;
};

export type StartedBenchmarkTurn = {
  conversationId: string;
  turnId: string;
  modelId: string;
};

export interface BenchmarkConversationTarget {
  readonly kind: BenchmarkTarget;
  start(input: {
    cwd: string;
    modelId: string;
    reasoning: string;
    reviewMode: string;
    speed: string;
    contextMode?: BenchmarkContextMode;
    text: string;
  }): Promise<StartedBenchmarkTurn>;
  send(input: { conversationId: string; text: string }): Promise<{ turnId: string }>;
  waitForTerminal(input: {
    conversationId: string;
    turnId: string;
    timeoutMs: number;
  }): Promise<void>;
  readTranscript(conversationId: string): Promise<VisibleBenchmarkTranscript>;
  interrupt(input: { conversationId: string; turnId?: string }): Promise<void>;
}
