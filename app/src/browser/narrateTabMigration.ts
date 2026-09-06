import type { RemuxExtension } from '../remote/remuxExtensions';
import type { BrowserPendingNavigation } from './browserTypes';

export const editorDocumentViewerHandlerId = 'document-viewer';

type MigratableFileTab = {
  extensionId: string;
  handlerId: string | null;
  id: string;
  lastActiveAt: number;
  pendingNavigation: BrowserPendingNavigation | null;
  resourceId: string | null;
  resourceKind: string | null;
  viewId: string;
};

export type NarrateTabMigrationResult<T> = {
  activeTabId: string | null;
  migratedTabIds: ReadonlySet<string>;
  tabs: T[];
};

export function migrateNarrateFileTabs<T extends MigratableFileTab>(
  tabs: readonly T[],
  activeTabId: string | null,
  extensions: readonly RemuxExtension[],
): NarrateTabMigrationResult<T> {
  const editor = extensions.find((extension) => extension.id === 'editor');
  const handler = editor?.fileHandlers.find((candidate) => candidate.id === editorDocumentViewerHandlerId);
  if (!editor || !handler || !editor.views[handler.view]) {
    return { activeTabId, migratedTabIds: new Set(), tabs: [...tabs] };
  }

  const narratePaths = new Set(tabs.flatMap((tab) => (
    isNarrateMarkdownTab(tab) ? [canonicalFilePath(tab.resourceId!)] : []
  )));
  if (narratePaths.size === 0) {
    return { activeTabId, migratedTabIds: new Set(), tabs: [...tabs] };
  }

  const grouped = new Map<string, Array<{ index: number; tab: T }>>();
  tabs.forEach((tab, index) => {
    const path = filePathForMigration(tab);
    if (!path || !narratePaths.has(path) || ((tab.extensionId !== 'editor' || tab.viewId !== handler.view) && !isNarrateMarkdownTab(tab))) {
      return;
    }
    const group = grouped.get(path) ?? [];
    group.push({ index, tab });
    grouped.set(path, group);
  });

  const removedIds = new Set<string>();
  const migratedTabIds = new Set<string>();
  const replacementById = new Map<string, T>();
  let nextActiveTabId = activeTabId;

  for (const group of grouped.values()) {
    const active = group.find(({ tab }) => tab.id === activeTabId);
    const existingEditor = group
      .filter(({ tab }) => tab.extensionId === 'editor')
      .sort((left, right) => right.tab.lastActiveAt - left.tab.lastActiveAt || left.index - right.index)[0];
    const survivor = active ?? existingEditor ?? group[0];
    const pendingNavigation = survivor.tab.pendingNavigation
      ?? group
        .slice()
        .sort((left, right) => right.tab.lastActiveAt - left.tab.lastActiveAt || left.index - right.index)
        .find(({ tab }) => tab.pendingNavigation)?.tab.pendingNavigation
      ?? null;
    const migrated = {
      ...survivor.tab,
      extensionId: 'editor',
      handlerId: editorDocumentViewerHandlerId,
      pendingNavigation,
      viewId: handler.view,
    };

    replacementById.set(survivor.tab.id, migrated);
    if (survivor.tab.extensionId !== 'editor' || survivor.tab.handlerId !== editorDocumentViewerHandlerId) {
      migratedTabIds.add(survivor.tab.id);
    }
    for (const { tab } of group) {
      if (tab.id !== survivor.tab.id) removedIds.add(tab.id);
    }
    if (activeTabId && group.some(({ tab }) => tab.id === activeTabId)) {
      nextActiveTabId = survivor.tab.id;
    }
  }

  return {
    activeTabId: nextActiveTabId,
    migratedTabIds,
    tabs: tabs.flatMap((tab) => removedIds.has(tab.id) ? [] : [replacementById.get(tab.id) ?? tab]),
  };
}

function isNarrateMarkdownTab(tab: MigratableFileTab) {
  return tab.extensionId === 'narrate'
    && tab.viewId === 'main'
    && tab.resourceKind === 'file'
    && Boolean(tab.resourceId)
    && /\.(?:md|markdown|mdown)$/iu.test(tab.resourceId!);
}

function filePathForMigration(tab: MigratableFileTab) {
  if (tab.resourceKind !== 'file' || !tab.resourceId) return null;
  return canonicalFilePath(tab.resourceId);
}

// Match existing browser resource identity. Lexically collapsing .. can merge
// distinct files when a path traverses a symlink.
function canonicalFilePath(path: string) {
  return path.trim();
}
