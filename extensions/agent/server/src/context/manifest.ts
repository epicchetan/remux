import type { CanonicalJsonValue } from '../storage/canonical-json.ts';

export const CONTEXT_COMPILER_VERSION = 'agent-context-compiler-v4' as const;
export const CONTEXT_POLICY_VERSION = 'agent-context-policy-v5' as const;
export const INFERENCE_CONTEXT_MANIFEST_VERSION = 'agent-inference-context-v5' as const;

export type ThreadContextLayerKind =
  | 'thread_document'
  | 'recent_dialogue'
  | 'active_scope';

export type ThreadContextLayer = {
  kind: ThreadContextLayerKind;
  estimatedTokens: number;
  hash: string;
  sources: readonly string[];
};

export type ContextOmission = {
  source: string;
  reason: 'recent-dialogue-budget' | 'prior-turn-scratch' | 'prior-turn-reasoning';
  retrieval: string;
  count: number;
};

/**
 * The durable description of the exact context selected for one provider
 * scope. This is the frame that is actually dispatched.
 */
export type ThreadContextFrameCandidate = {
  compilerVersion: typeof CONTEXT_COMPILER_VERSION;
  policyVersion: typeof CONTEXT_POLICY_VERSION;
  basisSequence: number;
  threadVersionId: string;
  contextEnvelope: string;
  contextEnvelopeHash: string;
  semanticHash: string;
  estimatedInputTokens: number;
  orderedMessageHashes: readonly string[];
  selectedTurnIds: readonly string[];
  dialogueTurnIds: readonly string[];
  omittedDialogueTurns: number;
  threadDocumentBytes: number;
  scopeKind: 'turn' | 'work_unit';
  softContextLimit: number;
  hardContextLimit: number;
  pressureNoticed: boolean;
  layers: readonly ThreadContextLayer[];
  omissions: readonly ContextOmission[];
};

export type InferenceContextManifest = {
  version: typeof INFERENCE_CONTEXT_MANIFEST_VERSION;
  compilerVersion: typeof CONTEXT_COMPILER_VERSION;
  policyVersion: typeof CONTEXT_POLICY_VERSION;
  piVersion: '0.84.0';
  provider: 'openai-codex';
  modelId: string;
  projectId: string;
  conversationId: string;
  turnId: string;
  scopeId: string;
  frameId: string;
  inferenceId: string;
  basisSequence: number;
  threadVersionId: string;
  context: {
    semanticHash: string;
    contextEnvelopeHash: string;
    logicalHash: string;
    renderedHash: string;
    orderedMessageHashes: readonly string[];
    messageCount: number;
    estimatedInputTokens: number;
    selectedTurnIds: readonly string[];
    dialogueTurnIds: readonly string[];
    omittedDialogueTurns: number;
    threadDocumentBytes: number;
    scopeKind: 'turn' | 'work_unit';
    softContextLimit: number;
    hardContextLimit: number;
    pressureNoticed: boolean;
    layers: readonly ThreadContextLayer[];
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

export function inferenceContextManifestValue(manifest: InferenceContextManifest): CanonicalJsonValue {
  return manifest as unknown as CanonicalJsonValue;
}
