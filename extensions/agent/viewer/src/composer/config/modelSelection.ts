import type { ModelInfo, ModelsValue, ReasoningLevel } from '../../../../shared/protocol.ts';

export function resolveModel(models: ModelsValue | null, modelId: string | null) {
  if (!models?.models.length) return null;
  return models.models.find((model) => model.id === modelId)
    ?? models.models.find((model) => model.id === models.defaultModelId)
    ?? models.models[0];
}

export function preferredReasoning(model: ModelInfo): ReasoningLevel {
  for (const level of ['high', 'medium', 'low', 'off'] as const) {
    if (model.supportedReasoning.includes(level)) return level;
  }
  return model.supportedReasoning[0] ?? 'off';
}

export function reasoningLabel(level: ReasoningLevel) {
  if (level === 'xhigh') return 'Extra High';
  return `${level.charAt(0).toUpperCase()}${level.slice(1)}`;
}
