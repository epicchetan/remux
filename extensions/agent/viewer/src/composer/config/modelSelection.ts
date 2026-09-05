import type { ModelInfo, ModelsValue, ReasoningEffort } from '../../../../shared/protocol.ts';

export function resolveModel(models: ModelsValue | null, modelId: string | null) {
  if (!models?.models.length) return null;
  return models.models.find((model) => model.id === modelId)
    ?? models.models.find((model) => model.id === models.defaultModelId)
    ?? models.models[0];
}

export function preferredReasoning(model: ModelInfo): ReasoningEffort {
  for (const level of ['high', 'medium', 'low', 'off'] as const) {
    if (model.supportedReasoning.includes(level)) return level;
  }
  return model.supportedReasoning[0] ?? null;
}

export function preferredServiceTier(model: ModelInfo, requested?: string | null) {
  if (requested && model.serviceTiers.some(({ id }) => id === requested)) return requested;
  if (model.serviceTiers.some(({ id }) => id === 'default')) return 'default';
  if (model.defaultServiceTier &&
      model.serviceTiers.some(({ id }) => id === model.defaultServiceTier)) {
    return model.defaultServiceTier;
  }
  return model.serviceTiers[0]?.id ?? null;
}

export function reasoningLabel(level: string) {
  if (level === 'xhigh') return 'Extra High';
  return `${level.charAt(0).toUpperCase()}${level.slice(1)}`;
}
