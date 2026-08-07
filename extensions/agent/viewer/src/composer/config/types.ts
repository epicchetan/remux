import type { ModelInfo, ReasoningLevel } from '../../../../shared/protocol.ts';

export type AgentComposerConfig = {
  modelId: string;
  reasoning: ReasoningLevel;
};

export type AgentModelOption = ModelInfo;
