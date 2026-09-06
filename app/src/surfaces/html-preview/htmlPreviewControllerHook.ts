import type { ViewerTab } from '../../browser/browserTypes';
import type { HtmlPreviewMode } from './htmlPreviewLoad';

export function htmlPreviewPath(
  tab: Pick<ViewerTab, 'extensionId' | 'resourceId' | 'resourceKind' | 'viewId'>,
) {
  if (
    tab.extensionId !== 'editor'
    || tab.viewId !== 'main'
    || tab.resourceKind !== 'file'
    || !tab.resourceId
  ) {
    return null;
  }
  return /\.html?$/iu.test(tab.resourceId) ? tab.resourceId : null;
}

export function htmlPreviewModeForTarget({
  currentMode,
  nextPath,
  previousPath,
  focusKind,
}: {
  currentMode: HtmlPreviewMode;
  focusKind: string | null | undefined;
  nextPath: string | null;
  previousPath: string | null;
}): HtmlPreviewMode {
  if (focusKind === 'line') return 'source';
  if (nextPath && nextPath !== previousPath) return 'preview';
  return currentMode;
}
