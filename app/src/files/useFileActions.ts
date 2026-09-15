import { useCallback, useEffect, useRef, useState } from 'react';
import * as Clipboard from 'expo-clipboard';
import * as DocumentPicker from 'expo-document-picker';
import * as ImagePicker from 'expo-image-picker';
import { Alert } from 'react-native';

import { useRemuxConnection } from '../remote/RemuxConnectionProvider';
import { currentRemuxOrigin, useRemuxSettingsStore } from '../remote/remuxSettingsStore';
import { downloadAndShareFile } from './fileDownload';
import {
  createDirectory,
  deleteEntry,
  isValidEntryName,
  joinPath,
  mutationErrorKind,
  parentPath,
  renameEntry,
} from './fileMutations';
import { uploadFileToDirectory } from './fileUpload';
import { useFilesStore } from './filesStore';
import { isDirectoryLikeEntry, type VisibleFileTreeRow } from './filesTypes';

export type FileActionKind =
  | 'copy-path'
  | 'delete'
  | 'download'
  | 'new-folder'
  | 'rename'
  | 'upload-files'
  | 'upload-photos';

export type FileActionTarget = {
  isDirectory: boolean;
  name: string;
  path: string;
};

/**
 * Every sheet keeps its payload after `visible` flips to false so its content
 * does not blank out mid-dismissal; the next open replaces it.
 */
export type FileActionsRequest = {
  actions: FileActionKind[];
  target: FileActionTarget;
  visible: boolean;
};

export type EntryNameRequest = {
  busy: boolean;
  error: string | null;
  initialName: string;
  mode: 'new-folder' | 'rename';
  target: FileActionTarget;
  visible: boolean;
};

export type DeleteConfirmRequest = {
  busy: boolean;
  error: string | null;
  /** Set only after the runtime refused a non-empty directory. */
  recursive: boolean;
  target: FileActionTarget;
  visible: boolean;
};

export type FilesSummary = {
  text: string;
  tone: 'error' | 'info';
};

type PendingFileAction = {
  action: FileActionKind;
  target: FileActionTarget;
};

type PickedUpload = {
  name: string;
  uri: string;
};

const directoryMenuActions: FileActionKind[] = ['new-folder', 'upload-files', 'upload-photos'];
const summaryVisibleMs = 4000;
const uploadProgressIntervalMs = 250;

export function useFileActions() {
  const { command, query } = useRemuxConnection();
  const refreshVisibleDirectories = useFilesStore((state) => state.refreshVisibleDirectories);
  const [actionsRequest, setActionsRequest] = useState<FileActionsRequest | null>(null);
  const [deleteRequest, setDeleteRequest] = useState<DeleteConfirmRequest | null>(null);
  const [entryNameRequest, setEntryNameRequest] = useState<EntryNameRequest | null>(null);
  const [summary, setSummary] = useState<FilesSummary | null>(null);
  // Selecting an action dismisses the sheet first: presenting a picker, an
  // alert or another sheet while UIKit is still dismissing this one is
  // dropped, so the work runs from the dismissal callback.
  const pendingActionRef = useRef<PendingFileAction | null>(null);
  const summaryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showSummary = useCallback((next: FilesSummary | null) => {
    if (summaryTimerRef.current !== null) {
      clearTimeout(summaryTimerRef.current);
      summaryTimerRef.current = null;
    }

    setSummary(next);
    if (next?.tone === 'info') {
      summaryTimerRef.current = setTimeout(() => {
        summaryTimerRef.current = null;
        setSummary(null);
      }, summaryVisibleMs);
    }
  }, []);

  useEffect(() => () => {
    if (summaryTimerRef.current !== null) {
      clearTimeout(summaryTimerRef.current);
    }
  }, []);

  // The relay broadcast lands too, but the listing must not wait for it.
  const refreshAfterMutation = useCallback(() => {
    void refreshVisibleDirectories(query);
  }, [query, refreshVisibleDirectories]);

  const uploadAssets = useCallback(async (target: FileActionTarget, assets: PickedUpload[]) => {
    if (assets.length === 0) {
      return;
    }

    const origin = currentRemuxOrigin();
    const token = useRemuxSettingsStore.getState().token;
    let announcedTooLarge = false;
    let failed = 0;
    let skipped = 0;
    let uploaded = 0;

    for (const [index, asset] of assets.entries()) {
      const position = `(${index + 1} of ${assets.length})`;
      const send = (overwrite: boolean) => {
        // The summary line lives above a FlatList, so progress is rate-limited
        // rather than repainted on every native callback.
        let reportedAtMs = 0;
        let reportedPercent = -1;
        return uploadFileToDirectory({
          directory: target.path,
          name: asset.name,
          onProgress: ({ bytesSent, totalBytes }) => {
            const percent = totalBytes > 0
              ? Math.min(100, Math.floor((bytesSent / totalBytes) * 100))
              : 0;
            const now = Date.now();
            if (percent === reportedPercent || (percent < 100 && now - reportedAtMs < uploadProgressIntervalMs)) {
              return;
            }

            reportedAtMs = now;
            reportedPercent = percent;
            showSummary({
              text: `Uploading ${asset.name} ${position} ${percent}%`,
              tone: 'info',
            });
          },
          origin,
          overwrite,
          sourceUri: asset.uri,
          token,
        });
      };

      showSummary({ text: `Uploading ${asset.name} ${position} 0%`, tone: 'info' });
      let result = await send(false);

      if (result.status === 'conflict') {
        if (!await confirmReplace(asset.name)) {
          skipped += 1;
          continue;
        }

        result = await send(true);
      }

      if (result.status === 'tooLarge') {
        failed += 1;
        if (!announcedTooLarge) {
          announcedTooLarge = true;
          Alert.alert(
            'Upload limit reached',
            `${asset.name} is larger than the upload limit this Remux host accepts.`,
          );
        }
        continue;
      }

      if (result.status === 'failed') {
        failed += 1;
        continue;
      }

      uploaded += 1;
    }

    showSummary(uploadSummary({ failed, skipped, total: assets.length, uploaded }));
    refreshAfterMutation();
  }, [refreshAfterMutation, showSummary]);

  const runAction = useCallback(async ({ action, target }: PendingFileAction) => {
    switch (action) {
      case 'copy-path': {
        await Clipboard.setStringAsync(target.path);
        showSummary({ text: 'Path copied', tone: 'info' });
        return;
      }
      case 'delete': {
        setDeleteRequest({
          busy: false,
          error: null,
          recursive: false,
          target,
          visible: true,
        });
        return;
      }
      case 'download': {
        showSummary({ text: `Downloading ${target.name}`, tone: 'info' });
        // Read at invocation: the download must use the runtime the app is
        // connected to now, not the one captured when the sheet opened.
        const result = await downloadAndShareFile({
          origin: currentRemuxOrigin(),
          path: target.path,
          token: useRemuxSettingsStore.getState().token,
        });
        showSummary(result.ok
          ? null
          : { text: result.reason ?? 'The file could not be downloaded.', tone: 'error' });
        return;
      }
      case 'new-folder': {
        setEntryNameRequest({
          busy: false,
          error: null,
          initialName: '',
          mode: 'new-folder',
          target,
          visible: true,
        });
        return;
      }
      case 'rename': {
        setEntryNameRequest({
          busy: false,
          error: null,
          initialName: target.name,
          mode: 'rename',
          target,
          visible: true,
        });
        return;
      }
      case 'upload-files': {
        const picked = await DocumentPicker.getDocumentAsync({
          copyToCacheDirectory: true,
          multiple: true,
          type: '*/*',
        });
        if (picked.canceled) {
          return;
        }

        await uploadAssets(target, picked.assets.map((asset) => ({
          name: uploadEntryName(asset.name, asset.uri),
          uri: asset.uri,
        })));
        return;
      }
      case 'upload-photos': {
        const picked = await ImagePicker.launchImageLibraryAsync({
          allowsMultipleSelection: true,
          mediaTypes: ['images', 'videos'],
          quality: 1,
        });
        if (picked.canceled) {
          return;
        }

        await uploadAssets(target, picked.assets.map((asset) => ({
          name: uploadEntryName(asset.fileName, asset.uri),
          uri: asset.uri,
        })));
        return;
      }
    }
  }, [showSummary, uploadAssets]);

  const openEntryActions = useCallback((row: VisibleFileTreeRow) => {
    const target: FileActionTarget = {
      isDirectory: isDirectoryLikeEntry(row),
      name: row.name,
      path: row.path,
    };
    setActionsRequest({ actions: entryActions(target), target, visible: true });
  }, []);

  const openDirectoryMenu = useCallback((path: string) => {
    setActionsRequest({
      actions: directoryMenuActions,
      target: { isDirectory: true, name: directoryName(path), path },
      visible: true,
    });
  }, []);

  const selectAction = useCallback((action: FileActionKind) => {
    if (!actionsRequest) {
      return;
    }

    pendingActionRef.current = { action, target: actionsRequest.target };
    setActionsRequest({ ...actionsRequest, visible: false });
  }, [actionsRequest]);

  const closeActions = useCallback(() => {
    setActionsRequest((current) => (current ? { ...current, visible: false } : current));
  }, []);

  const handleActionsDismissed = useCallback(() => {
    const pending = pendingActionRef.current;
    pendingActionRef.current = null;
    if (!pending) {
      return;
    }

    void runAction(pending).catch((error: unknown) => {
      showSummary({ text: errorMessage(error), tone: 'error' });
    });
  }, [runAction, showSummary]);

  const closeEntryName = useCallback(() => {
    setEntryNameRequest((current) => (current ? { ...current, visible: false } : current));
  }, []);

  const submitEntryName = useCallback(async (name: string) => {
    const request = entryNameRequest;
    if (!request || request.busy) {
      return;
    }

    setEntryNameRequest((current) => (current ? { ...current, busy: true, error: null } : current));
    try {
      if (request.mode === 'rename') {
        await renameEntry(
          command,
          request.target.path,
          joinPath(parentPath(request.target.path), name),
        );
      } else {
        await createDirectory(command, joinPath(request.target.path, name));
      }

      setEntryNameRequest((current) => (
        current ? { ...current, busy: false, error: null, visible: false } : current
      ));
      showSummary({
        text: request.mode === 'rename' ? `Renamed to ${name}` : `Created ${name}`,
        tone: 'info',
      });
      refreshAfterMutation();
    } catch (error) {
      setEntryNameRequest((current) => (
        current ? { ...current, busy: false, error: mutationErrorText(error) } : current
      ));
    }
  }, [command, entryNameRequest, refreshAfterMutation, showSummary]);

  const closeDeleteConfirm = useCallback(() => {
    setDeleteRequest((current) => (current ? { ...current, visible: false } : current));
  }, []);

  const confirmDelete = useCallback(async () => {
    const request = deleteRequest;
    if (!request || request.busy) {
      return;
    }

    setDeleteRequest((current) => (current ? { ...current, busy: true, error: null } : current));
    try {
      await deleteEntry(
        command,
        request.target.path,
        request.recursive ? { recursive: true } : {},
      );
      setDeleteRequest((current) => (
        current ? { ...current, busy: false, error: null, visible: false } : current
      ));
      showSummary({ text: `Deleted ${request.target.name}`, tone: 'info' });
      refreshAfterMutation();
    } catch (error) {
      // A non-empty directory escalates in place to the typed confirmation,
      // the only path that is allowed to pass `recursive`.
      if (mutationErrorKind(error) === 'notEmpty' && !request.recursive) {
        setDeleteRequest((current) => (
          current ? { ...current, busy: false, error: null, recursive: true } : current
        ));
        return;
      }

      setDeleteRequest((current) => (
        current ? { ...current, busy: false, error: mutationErrorText(error) } : current
      ));
    }
  }, [command, deleteRequest, refreshAfterMutation, showSummary]);

  return {
    actionsRequest,
    closeActions,
    closeDeleteConfirm,
    closeEntryName,
    confirmDelete,
    deleteRequest,
    entryNameRequest,
    handleActionsDismissed,
    openDirectoryMenu,
    openEntryActions,
    selectAction,
    submitEntryName,
    summary,
  };
}

function entryActions(target: FileActionTarget): FileActionKind[] {
  return target.isDirectory
    ? ['new-folder', 'upload-files', 'upload-photos', 'rename', 'copy-path', 'delete']
    : ['download', 'rename', 'copy-path', 'delete'];
}

function uploadSummary({
  failed,
  skipped,
  total,
  uploaded,
}: {
  failed: number;
  skipped: number;
  total: number;
  uploaded: number;
}): FilesSummary {
  if (failed === 0 && skipped === 0) {
    return {
      text: `Uploaded ${uploaded} ${uploaded === 1 ? 'file' : 'files'}`,
      tone: 'info',
    };
  }

  return {
    text: [
      `Uploaded ${uploaded} of ${total}`,
      failed > 0 ? `${failed} failed` : null,
      skipped > 0 ? `${skipped} skipped` : null,
    ].filter(Boolean).join(' - '),
    tone: failed > 0 ? 'error' : 'info',
  };
}

function confirmReplace(name: string) {
  return new Promise<boolean>((resolve) => {
    Alert.alert(
      `${name} already exists`,
      'Replace it on the host, or skip this file?',
      [
        { onPress: () => resolve(false), style: 'cancel', text: 'Skip' },
        { onPress: () => resolve(true), style: 'destructive', text: 'Replace' },
      ],
      { cancelable: false },
    );
  });
}

function mutationErrorText(error: unknown) {
  switch (mutationErrorKind(error)) {
    case 'crossDevice':
      return 'That move would cross devices, which is not supported yet';
    case 'exists':
      return 'Something with that name already exists';
    case 'notFound':
      return 'That item no longer exists on the host';
    default:
      return errorMessage(error);
  }
}

function directoryName(path: string) {
  return path.split('/').filter(Boolean).at(-1) ?? path;
}

/**
 * Photo assets often carry no file name, and a picker name is not guaranteed
 * to be a legal single path segment; the cache URI's last segment is the
 * fallback, then a constant.
 */
function uploadEntryName(preferred: string | null | undefined, uri: string) {
  if (preferred && isValidEntryName(preferred)) {
    return preferred;
  }

  const segment = uri.split(/[?#]/u)[0]?.split('/').filter(Boolean).at(-1) ?? '';
  let decoded = segment;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
    // A malformed escape leaves the raw segment, which is still a file name.
  }

  return isValidEntryName(decoded) ? decoded : 'upload';
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error || 'The action failed');
}
