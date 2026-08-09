import type { CanonicalJsonValue } from '../storage/canonical-json.ts';

export const CONTEXT_COMPILER_VERSION = 'agent-context-compiler-v3' as const;
export const CONTEXT_POLICY_VERSION = 'agent-context-policy-v2' as const;
export const PROMPT_MANIFEST_VERSION = 'agent-prompt-manifest-v3' as const;

export type ContextBlockKind =
  | 'context_hud'
  | 'continuation'
  | 'working_state'
  | 'open_work'
  | 'workspace'
  | 'runtime'
  | 'raw_tail'
  | 'retrieval_map';

export type ContextDecision =
  | { kind: 'append'; pressurePermille: number }
  | { kind: 'roll'; pressurePermille: number; reason: string }
  | { kind: 'block'; pressurePermille: number; reason: string };

export type ContextCandidateBlock = {
  kind: ContextBlockKind;
  hash: string;
  estimatedTokens: number;
  text: string;
  sources: readonly string[];
};

export type ContextOmission = {
  ref?: string;
  source: string;
  reason: string;
  retrieval: string;
  count: number;
};

export type ShadowContextCandidate = {
  compilerVersion: typeof CONTEXT_COMPILER_VERSION;
  policyVersion: string;
  basisSequence: number;
  projectRevision: number;
  targetContextSpaceId: string;
  decision: ContextDecision;
  blocks: readonly ContextCandidateBlock[];
  omissions: readonly ContextOmission[];
  bootstrap: string;
  bootstrapHash: string;
  semanticHash: string;
  estimatedInputTokens: number;
  activeEstimatedInputTokens: number;
};

export type PromptManifest = {
  version: typeof PROMPT_MANIFEST_VERSION;
  compilerVersion: typeof CONTEXT_COMPILER_VERSION;
  policyVersion: string;
  piVersion: '0.84.0';
  provider: 'openai-codex';
  modelId: string;
  projectId: string;
  conversationId: string;
  strandId: string;
  turnId: string;
  scopeId: string;
  epochId: string;
  inferenceId: string;
  basisSequence: number;
  projectRevision: number;
  targetContextSpaceId: string;
  active: {
    mode: 'full-history' | 'stateful-frame';
    frameOrdinal: number | null;
    pressureNotice: boolean;
    logicalHash: string;
    renderedHash: string;
    orderedMessageHashes: readonly string[];
    messageCount: number;
    estimatedInputTokens: number;
  };
  candidate: {
    mode: 'diagnostic' | 'authoritative';
    semanticHash: string;
    bootstrapHash: string;
    estimatedInputTokens: number;
    decision: ContextDecision;
    blocks: ReadonlyArray<{
      kind: ContextBlockKind;
      hash: string;
      estimatedTokens: number;
      sources: readonly string[];
    }>;
    omissions: readonly ContextOmission[];
  };
  transport: {
    requestMode: 'full' | 'continuation';
    fixedContractsHash: string;
    dispatchArtifact: {
      hash: string;
      byteLength: number;
      mediaType: string;
    };
  };
};

export function promptManifestValue(manifest: PromptManifest): CanonicalJsonValue {
  return manifest as unknown as CanonicalJsonValue;
}
