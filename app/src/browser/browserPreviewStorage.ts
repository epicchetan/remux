import { Directory, File, Paths } from 'expo-file-system';

const previewDirectory = new Directory(Paths.cache, 'remux', 'tab-previews');

let previewSequence = 0;

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

  deletePreviewFile(previewFileName);
}

export function resolveTabPreview(previewFileName: string | null | undefined): PersistedTabPreview | null {
  if (!previewFileName) {
    return null;
  }

  try {
    const previewFile = new File(previewDirectory, previewFileName);
    if (!previewFile.exists) {
      return null;
    }

    return {
      previewFileName,
      previewUri: previewFile.uri,
    };
  } catch {
    return null;
  }
}

// Each capture gets a fresh file name: the overview stays mounted while
// previews refresh, and Image only reloads a file URI when the URI changes.
function previewFileNameForTab(tabId: string) {
  const safeTabId = tabId.replace(/[^A-Za-z0-9._-]/g, '_');
  previewSequence += 1;
  return `${safeTabId}-${Date.now().toString(36)}-${previewSequence}.jpg`;
}

function deletePreviewFile(previewFileName: string) {
  try {
    const previewFile = new File(previewDirectory, previewFileName);
    if (previewFile.exists) {
      previewFile.delete();
    }
  } catch {
    // Preview files are disposable cache artifacts.
  }
}
