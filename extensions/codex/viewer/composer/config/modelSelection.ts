import type { CodexModelOption } from '../../../shared/composerConfig';

export function findModelOption(
  models: CodexModelOption[] | null,
  model: string | null,
) {
  if (!models || !model) {
    return null;
  }

  return models.find((option) => option.model === model || option.id === model) ?? null;
}

export function resolveModelOption(
  models: CodexModelOption[] | null,
  configuredModel: string | null,
  resolvedDefaultModel: string | null,
) {
  if (!models || models.length === 0) {
    return null;
  }

  if (configuredModel) {
    return findModelOption(models, configuredModel);
  }

  return findModelOption(models, resolvedDefaultModel)
    ?? models.find((option) => option.isDefault)
    ?? models[0]
    ?? null;
}

export function resolveModelValue(
  models: CodexModelOption[] | null,
  configuredModel: string | null,
  resolvedDefaultModel: string | null,
) {
  const option = resolveModelOption(models, configuredModel, resolvedDefaultModel);

  if (configuredModel) {
    return option?.model ?? configuredModel;
  }

  return option?.model ?? resolvedDefaultModel;
}

export function modelDisplayLabel(
  models: CodexModelOption[] | null,
  model: string | null,
  fallback = 'Default model',
) {
  return findModelOption(models, model)?.displayName
    ?? (model ? formatModelSlug(model) : fallback);
}

function formatModelSlug(model: string) {
  return model
    .replace(/^gpt-/i, 'GPT ')
    .replace(/^codex-/i, 'Codex ')
    .replace(/-/g, ' ');
}
