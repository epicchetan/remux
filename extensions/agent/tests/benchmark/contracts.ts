export const BENCHMARK_FORMAT_VERSION = 3 as const;

export type BenchmarkTarget = 'agent' | 'codex';
export type BenchmarkSuite = 'parity' | 'workflow';

export type BenchmarkVisibleInput = {
  path: string;
} & ({
  sourceRef: string;
  sourcePath: string;
  fixturePath?: never;
} | {
  fixturePath: string;
  sourceRef?: never;
  sourcePath?: never;
});

export type BenchmarkCommand = {
  id: string;
  file: string;
  args: string[];
  heavy?: boolean;
};

export type BenchmarkOverlayRewrite = {
  path: string;
  from: string;
  to: string;
};

export type BenchmarkScenario = {
  version: 3;
  suite: BenchmarkSuite;
  fixtureId: string;
  title: string;
  sourceRepository: string;
  baseCommit: string;
  referenceCommit: string;
  sourceRollouts: string[];
  sourceTurnIds: string[];
  visibleInputs: BenchmarkVisibleInput[];
  governingPaths: string[];
  fixedPrompt: string | null;
  driverCardPath: string | null;
  driverBrief: {
    goal: string;
    background: string[];
    constraints: string[];
    defaultAuthority: {
      mayWrite: boolean;
      mayCommit: boolean;
      mayPush: boolean;
    };
  };
  maxUserTurns: number;
  maxDurationMs: number;
  forbiddenPaths: string[];
  evaluator: {
    overlayPaths: string[];
    overlayRewrites: BenchmarkOverlayRewrite[];
    formatCommand: BenchmarkCommand;
    behavioralCommand: BenchmarkCommand;
  };
};

export type PreparedFixtureManifest = {
  version: 3;
  fixtureId: string;
  createdAt: string;
  source: {
    repositoryPath: string;
    headBefore: string;
    statusBefore: string;
    baseCommit: string;
    baseTree: string;
    referenceCommit: string;
    referenceTree: string;
    visibleInputs: Array<BenchmarkVisibleInput & { sha256: string }>;
    transcriptFiles: Array<{ path: string; sha256: string; bytes: number }>;
    sourceTurnIds: string[];
  };
  template: {
    path: string;
    headCommit: string;
    tree: string;
  };
  evaluation: {
    forbiddenPaths: string[];
    overlayPaths: string[];
    overlayRewrites: BenchmarkOverlayRewrite[];
    formatCommand: BenchmarkCommand;
    behavioralCommand: BenchmarkCommand;
  };
};

export type BenchmarkDriverDecision = {
  id: string;
  status: 'accepted' | 'rejected' | 'revised' | 'open';
  value?: string;
  rationale?: string;
};

export type BenchmarkDriverEvent = {
  stage: 'explore' | 'decide' | 'revise' | 'implement' | 'review' | 'continuity' | 'strict';
  intent: string;
  introducedConstraints: string[];
  decisions: BenchmarkDriverDecision[];
};

export type BenchmarkThreadSnapshot = {
  versionId: string;
  ordinal: number;
  content: string;
  byteLength: number;
  previousVersionId: string | null;
};

export type BenchmarkTurnRecord = {
  sequence: number;
  text: string;
  driverNote: string | null;
  driverEvent: BenchmarkDriverEvent | null;
  authority: {
    mayWrite: boolean;
    mayCommit: boolean;
    mayPush: boolean;
  };
  turnId: string;
  startedAt: string;
  completedAt: string;
  activeDurationMs: number;
  workspaceHeadAfter: string;
  workspaceStatusAfter: string;
  threadSnapshot: BenchmarkThreadSnapshot | null;
};

export type BenchmarkRun = {
  version: 3;
  runId: string;
  fixtureId: string;
  suite: BenchmarkSuite;
  target: BenchmarkTarget;
  state: 'running' | 'stopped' | 'evaluating' | 'completed' | 'failed' | 'infrastructure-failed';
  dataRoot: string;
  workspacePath: string;
  fixtureManifestPath: string;
  conversationId: string;
  modelId: string;
  reasoning: string;
  reviewMode: string;
  speed: string;
  contextArchitecture: 'thread-runtime-v2' | 'codex-app-server';
  stopReason: 'accepted' | 'abandoned' | 'budget-exhausted' | null;
  driverAssessment: string | null;
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
  group: 'outcome' | 'safety-authority' | 'validation' | 'harness';
  passed: boolean;
  detail: string;
  logPath?: string;
};

export type BenchmarkReport = {
  version: 3;
  runId: string;
  fixtureId: string;
  suite: BenchmarkSuite;
  target: BenchmarkTarget;
  passed: boolean;
  evaluatedAt: string;
  durationMs: number;
  activeTurnMs: number;
  driverGapMs: number;
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
    rootProviderCalls: number | null;
    childProviderCalls: number | null;
    estimatedInputTokens: number | null;
    peakEstimatedInputTokens: number | null;
    peakRootEstimatedInputTokens: number | null;
    peakChildEstimatedInputTokens: number | null;
    reportedInputTokens: number | null;
    reportedOutputTokens: number | null;
    fullRequests: number | null;
    continuationRequests: number | null;
    contextFrames: number | null;
    providerItems: number | null;
    runningInferences: number | null;
    runningTurns: number | null;
    peakSelectedDialogueTurns: number | null;
    peakOmittedDialogueTurns: number | null;
    peakThreadDocumentBytes: number | null;
    pressureNotices: number | null;
    threadUpdates: number | null;
    workUnitsEntered: number | null;
    workUnitsReturned: number | null;
    workUnitsAbandoned: number | null;
    rootToolCalls: number | null;
    childToolCalls: number | null;
    workUnitResultBytes: number | null;
    workUnitInputResources: number | null;
    workUnitInputAuthorities: number | null;
    workUnitReturnedResources: number | null;
    workUnitReturnedAuthorities: number | null;
    workUnitReturnedDeliverables: number | null;
    workUnitReturnedEvidence: number | null;
    contextLimitErrors: number | null;
    contextLayerEstimatedTokens: Record<string, number> | null;
    contextOmissions: number | null;
    historyRetrievalCalls: number | null;
    historySearchCalls: number | null;
    historyReadCalls: number | null;
    usefulRetrievalCalls: number | null;
    invalidContextCalls: number | null;
    selfReferentialSearchHits: number | null;
    duplicateRetrievalHits: number | null;
    readCalls: number | null;
    repeatedReadCalls: number | null;
    parentHandoffReadCalls: number | null;
    parentReconstructionReadCalls: number | null;
    parentReturnedResourceReadCalls: number | null;
    acceptedSpecReads: number | null;
    shellCalls: number | null;
    editCalls: number | null;
    writeCalls: number | null;
    testCalls: number | null;
    parentVisibleToolResultBytes: number | null;
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
  turnStatusByTurn: Record<string, string>;
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
    text: string;
  }): Promise<StartedBenchmarkTurn>;
  send(input: { conversationId: string; text: string }): Promise<{ turnId: string }>;
  waitForTerminal(input: {
    conversationId: string;
    turnId: string;
    timeoutMs: number;
  }): Promise<void>;
  readTranscript(conversationId: string): Promise<VisibleBenchmarkTranscript>;
  readThread?(conversationId: string): Promise<BenchmarkThreadSnapshot>;
  interrupt(input: { conversationId: string; turnId?: string }): Promise<void>;
}
