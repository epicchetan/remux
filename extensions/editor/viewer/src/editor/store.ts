import { readFileGit } from '@remux/viewer-kit/fs';
import { create } from 'zustand';

import { EditorFileController, type EditorControllerState, type PendingFocus } from './fileController';
import { loadDocumentWindow, loadInitialDocument } from './fileLoading';

export const editorController = new EditorFileController({
  loadInitial: loadInitialDocument,
  loadWindow: loadDocumentWindow,
  readGit: readFileGit,
});

type EditorStore = EditorControllerState & {
  acknowledgeFocus: (nonce: string | null) => void;
  load: () => Promise<boolean>;
  loadEnd: () => Promise<boolean>;
  loadNext: () => Promise<boolean>;
  loadPrevious: () => Promise<boolean>;
  loadStart: () => Promise<boolean>;
  reload: () => Promise<boolean>;
  retarget: (path: string, options?: { hostGeneration?: number | null; focus?: PendingFocus | null }) => void;
  setHostGeneration: (generation: number | null) => void;
  setMode: EditorFileController['setMode'];
  showDiff: () => Promise<boolean>;
};

export const useEditorStore = create<EditorStore>((set) => {
  editorController.subscribe((state) => set(state));
  return {
    ...editorController.snapshot(),
    acknowledgeFocus: (nonce) => editorController.acknowledgeFocus(nonce),
    load: () => editorController.load(),
    loadEnd: () => editorController.loadEnd(),
    loadNext: () => editorController.loadNext(),
    loadPrevious: () => editorController.loadPrevious(),
    loadStart: () => editorController.loadStart(),
    reload: () => editorController.reload(),
    retarget: (path, options) => editorController.retarget(path, options),
    setHostGeneration: (generation) => editorController.setHostGeneration(generation),
    setMode: (mode) => editorController.setMode(mode),
    showDiff: () => editorController.showDiff(),
  };
});
