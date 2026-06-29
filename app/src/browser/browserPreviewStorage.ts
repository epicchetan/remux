import { Directory, File, Paths } from 'expo-file-system';

const previewDirectory = new Directory(Paths.cache, 'remux', 'tab-previews');
const legacyPreviewDirectory = new Directory(Paths.document, 'remux', 'tab-previews');

export type PersistedTabPreview = {
  previewFileName: string;
  previewUri: string;
};

export async function persistTabPreview(
  tabId: string,
  sourceUri: string,
): Promise<PersistedTabPreview | null> {
  const previewFileName = previewFileNameForTab(tabId);
  const sourceFile = new File(sourceUri);
  const previewFile = new File(previewDirectory, previewFileName);

  if (!sourceFile.exists) {
    return null;
  }

  previewDirectory.create({ idempotent: true, intermediates: true });
  await sourceFile.copy(previewFile, { overwrite: true });

  return {
    previewFileName,
    previewUri: previewFile.uri,
  };
}

export async function deleteTabPreview(previewFileName: string | null | undefined) {
  if (!previewFileName) {
    return;
  }

  try {
    deletePreviewFile(previewDirectory, previewFileName);
    deletePreviewFile(legacyPreviewDirectory, previewFileName);
  } catch {
    // Preview cleanup is best effort; the tab metadata is the source of truth.
  }
}

export function resolveTabPreview(previewFileName: string | null | undefined): PersistedTabPreview | null {
  if (!previewFileName) {
    return null;
  }

  try {
    const previewFile = new File(previewDirectory, previewFileName);
    if (!previewFile.exists) {
      deletePreviewFile(legacyPreviewDirectory, previewFileName);
      return null;
    }

    deletePreviewFile(legacyPreviewDirectory, previewFileName);

    return {
      previewFileName,
      previewUri: previewFile.uri,
    };
  } catch {
    return null;
  }
}

function previewFileNameForTab(tabId: string) {
  const safeTabId = tabId.replace(/[^A-Za-z0-9._-]/g, '_');
  return `${safeTabId}.jpg`;
}

function deletePreviewFile(directory: Directory, previewFileName: string) {
  try {
    const previewFile = new File(directory, previewFileName);
    if (previewFile.exists) {
      previewFile.delete();
    }
  } catch {
    // Preview files are disposable cache artifacts.
  }
}
