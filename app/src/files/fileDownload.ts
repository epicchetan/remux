import { Directory, File, Paths } from 'expo-file-system';
import { Share } from 'react-native';

const downloadsDirectory = new Directory(Paths.cache, 'remux-downloads');
const staleDownloadAgeMs = 24 * 60 * 60 * 1000;

// One share sheet per file: a second request for a path still downloading
// joins the first instead of racing it for the same destination.
const activeDownloads = new Map<string, Promise<FileDownloadResult>>();

export type FileDownloadRequest = {
  origin: string;
  path: string;
  token: string;
};

export type FileDownloadResult = {
  ok: boolean;
  reason?: string;
};

export function rawFileDownloadUrl(origin: string, path: string) {
  return `${origin.replace(/\/+$/u, '')}/remux/fs/raw?path=${encodeURIComponent(path)}&download=1`;
}

// A cached copy only exists to hand bytes to the share sheet, so an entry that
// cannot be dated is as disposable as an old one.
export function isStaleDownload(modifiedAtMs: number | null, nowMs: number) {
  return modifiedAtMs === null || nowMs - modifiedAtMs > staleDownloadAgeMs;
}

export function downloadAndShareFile(request: FileDownloadRequest): Promise<FileDownloadResult> {
  const active = activeDownloads.get(request.path);
  if (active) {
    return active;
  }

  const download = shareDownloadedFile(request).finally(() => {
    activeDownloads.delete(request.path);
  });
  activeDownloads.set(request.path, download);
  return download;
}

export async function cleanupDownloadsCache(now = Date.now()) {
  if (!downloadsDirectory.exists) {
    return;
  }

  for (const entry of downloadsDirectory.list()) {
    const modifiedAtMs = entry instanceof File
      ? entry.lastModified
      : entry.info().modificationTime ?? null;
    if (isStaleDownload(modifiedAtMs, now)) {
      entry.delete();
    }
  }
}

async function shareDownloadedFile(
  { origin, path, token }: FileDownloadRequest,
): Promise<FileDownloadResult> {
  try {
    downloadsDirectory.create({ idempotent: true, intermediates: true });
    const destination = new File(downloadsDirectory, downloadFileName(path));
    if (destination.exists) {
      destination.delete();
    }

    const downloaded = await File.downloadFileAsync(
      rawFileDownloadUrl(origin, path),
      destination,
      { headers: token ? { Authorization: `Bearer ${token}` } : {} },
    );
    // A dismissed sheet still resolves; only failing to present it throws.
    await Share.share({ url: downloaded.uri });
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: downloadFailureReason(error) };
  }
}

// The share sheet shows the destination file name, so it keeps the workspace
// name rather than anything derived from the cache layout.
function downloadFileName(path: string) {
  const name = path.split(/[\\/]/u).filter(Boolean).at(-1);
  return name && name !== '.' && name !== '..' ? name : 'download';
}

// expo-file-system rejects a non-2xx response with an UnableToDownload error
// whose message carries the status; there is no structured status to read.
function downloadFailureReason(error: unknown) {
  const message = (error instanceof Error ? error.message : String(error)).split('\n')[0]?.trim() ?? '';
  return message.length > 0 ? message : 'The file could not be downloaded.';
}
