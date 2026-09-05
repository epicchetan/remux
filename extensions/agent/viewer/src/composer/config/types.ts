import type { ModelInfo, ReasoningEffort } from '../../../../shared/protocol.ts';

export type AgentComposerConfig = {
  modelId: string;
  reasoning: ReasoningEffort;
};

export type AgentModelOption = ModelInfo;
