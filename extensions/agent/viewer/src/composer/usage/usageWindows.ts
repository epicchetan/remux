import type { AccountUsageWindow, ProviderKind } from '../../../../shared/provider-runtime.ts';

export function visibleAccountUsageWindows(
  provider: ProviderKind | undefined,
  windows: readonly AccountUsageWindow[],
) {
  if (provider !== 'codex') return windows;
  return windows.filter((window) => !isHiddenCodexSparkWindow(window));
}

// Spark is separately metered, but intentionally omitted from the general
// subscription tray so opt-in model limits do not become permanent UI noise.
function isHiddenCodexSparkWindow(window: AccountUsageWindow) {
  const id = window.id.toLocaleLowerCase();
  const model = window.model?.toLocaleLowerCase() ?? '';
  return id.startsWith('codex_bengalfox:') || model.includes('codex-spark');
}
