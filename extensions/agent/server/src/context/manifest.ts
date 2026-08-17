import type {
  TurnContextPlan,
  TurnContextResolution,
} from '../../../shared/protocol.ts';
import type { CanonicalJsonValue } from '../storage/canonical-json.ts';

export const CONTEXT_COMPILER_VERSION = 'agent-turn-context-v1' as const;
export const CONTEXT_POLICY_VERSION = 'agent-explicit-selection-v1' as const;
export const INFERENCE_CONTEXT_MANIFEST_VERSION = 'agent-inference-context-v7' as const;

export type SelectedTurnResolution = Exclude<TurnContextResolution, 'off'>;

export type ResolvedTurnContextSource = {
  turnId: string;
  resolution: SelectedTurnResolution;
  origin: 'automatic' | 'explicit';
};

export type TurnContextLayerKind =
  | 'selected_dialogue'
  | 'selected_full_turns'
  | 'provider_checkpoint'
  | 'active_scope';

export type TurnContextLayer = {
  kind: TurnContextLayerKind;
  estimatedTokens: number;
  hash: string;
  sources: readonly string[];
};

export type ContextOmission = {
  source: string;
  reason: 'not-selected' | 'prior-work-unit-trace';
  retrieval: string;
  count: number;
};

/** Durable, deterministic description of the exact context selected for one provider scope. */
export type TurnContextFrameCandidate = {
  compilerVersion: typeof CONTEXT_COMPILER_VERSION;
  policyVersion: typeof CONTEXT_POLICY_VERSION;
  basisSequence: number;
  requestedPlan: TurnContextPlan;
  resolvedTurns: readonly ResolvedTurnContextSource[];
  semanticHash: string;
  estimatedInputTokens: number;
  orderedMessageHashes: readonly string[];
  selectedTurnIds: readonly string[];
  scopeKind: 'turn' | 'work_unit';
  layers: readonly TurnContextLayer[];
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
  context: {
    semanticHash: string;
    logicalHash: string;
    renderedHash: string;
    orderedMessageHashes: readonly string[];
    messageCount: number;
    estimatedInputTokens: number;
    requestedPlan: TurnContextPlan;
    resolvedTurns: readonly ResolvedTurnContextSource[];
    selectedTurnIds: readonly string[];
    scopeKind: 'turn' | 'work_unit';
    layers: readonly TurnContextLayer[];
    omissions: readonly ContextOmission[];
    compaction: {
      epoch: number;
      checkpointSequence: number | null;
      compactedThroughSequence: number | null;
      warningIssued: boolean;
      modelRequested: boolean;
      policyInputTokens: number;
    };
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
