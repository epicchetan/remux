import { create } from 'zustand';

import { createEmptyComposerSnapshot, type ComposerSnapshot } from '../composer/model/composerModel';
import { codexWebViewStorageKey, defaultCodexCwd } from '../config/defaults';

type ThreadsStoreState = {
  activeDraftId: string | null;
  activeThreadId: string | null;
  completeDraftAsThread: (threadId: string) => void;
  defaultCwd: string;
  directoryPickerOpen: boolean;
  directoryPickerPath: string | null;
  draft: NewChatDraft | null;
  discardDraft: () => void;
  goToParentDirectory: () => void;
  openDirectoryPicker: () => void;
  saveActiveDraftSnapshot: (snapshot: ComposerSnapshot) => void;
  selectDirectoryPickerPath: () => void;
  selectDraft: () => void;
  selectThread: (threadId: string) => void;
  setDefaultCwd: (cwd: string | null | undefined) => void;
  setDirectoryPickerPath: (path: string) => void;
  startNewChat: (input?: StartNewChatInput | string) => void;
};

export type NewChatDraft = {
  cwd: string | null;
  id: string;
  initialCwd: string;
  snapshot: ComposerSnapshot;
  updatedAt: number;
};

type StartNewChatInput = {
  cwd?: string | null;
  draftId?: string | null;
};

const draftStorageKeyPrefix = `${codexWebViewStorageKey}:new-chat-draft:v2`;
const legacyDraftStorageKey = `${codexWebViewStorageKey}:new-chat-draft:v1`;
const initialDraft = loadLegacyPersistedDraft();
let draftGeneration = 0;

export const useThreadsStore = create<ThreadsStoreState>((set) => ({
  activeDraftId: initialDraft?.id ?? null,
  activeThreadId: null,
  defaultCwd: defaultCodexCwd,
  completeDraftAsThread(threadId) {
    const currentDraftId = useThreadsStore.getState().draft?.id;
    deletePersistedDraft(currentDraftId);
    set({
      activeDraftId: null,
      activeThreadId: threadId,
      directoryPickerOpen: false,
      directoryPickerPath: null,
      draft: null,
    });
  },
  directoryPickerOpen: false,
  directoryPickerPath: initialDraft?.cwd ?? null,
  draft: initialDraft,
  discardDraft() {
    deletePersistedDraft(useThreadsStore.getState().draft?.id);
    set({
      activeDraftId: null,
      directoryPickerOpen: false,
      directoryPickerPath: null,
      draft: null,
    });
  },
  goToParentDirectory() {
    set((state) => {
      const parent = state.directoryPickerPath ? parentDirectory(state.directoryPickerPath) : null;
      return parent ? { directoryPickerPath: parent } : {};
    });
  },
  openDirectoryPicker() {
    set((state) => ({
      activeDraftId: state.draft?.id ?? null,
      activeThreadId: state.draft ? null : state.activeThreadId,
      directoryPickerOpen: Boolean(state.draft),
      directoryPickerPath: state.draft?.cwd ?? state.draft?.initialCwd ?? state.directoryPickerPath,
    }));
  },
  saveActiveDraftSnapshot(snapshot) {
    set((state) => {
      if (!state.activeDraftId || state.draft?.id !== state.activeDraftId || !state.draft.cwd) {
        return {};
      }

      if (
        state.draft.snapshot.contentKey === snapshot.contentKey &&
        state.draft.snapshot.error === snapshot.error &&
        state.draft.snapshot.isReadingImages === snapshot.isReadingImages
      ) {
        return {};
      }

      return {
        draft: {
          ...state.draft,
          snapshot,
          updatedAt: Date.now(),
        },
      };
    });
  },
  selectDirectoryPickerPath() {
    set((state) => {
      const cwd = state.directoryPickerPath;
      if (!cwd) {
        return {};
      }

      const id = state.draft?.id ?? nextDraftId();
      return {
        activeDraftId: id,
        directoryPickerOpen: false,
        draft: state.draft
          ? { ...state.draft, cwd, updatedAt: Date.now() }
          : {
              cwd,
              id,
              initialCwd: cwd,
              snapshot: createEmptyComposerSnapshot(),
              updatedAt: Date.now(),
            },
      };
    });
  },
  selectDraft() {
    set((state) => {
      if (!state.draft) {
        return {};
      }

      return {
        activeDraftId: state.draft.id,
        activeThreadId: null,
        directoryPickerOpen: !state.draft.cwd,
        directoryPickerPath: state.draft.cwd ?? state.draft.initialCwd,
      };
    });
  },
  selectThread(threadId) {
    set((state) => ({
      activeDraftId: null,
      activeThreadId: threadId,
      directoryPickerOpen: false,
      directoryPickerPath: null,
      draft: state.draft?.cwd ? state.draft : null,
    }));
  },
  setDefaultCwd(cwd) {
    const nextDefaultCwd = normalizeDefaultCwd(cwd);
    set((state) => {
      if (state.defaultCwd === nextDefaultCwd) {
        return {};
      }

      const updates: Partial<ThreadsStoreState> = { defaultCwd: nextDefaultCwd };
      if (state.draft && !state.draft.cwd && state.draft.initialCwd === state.defaultCwd) {
        updates.draft = {
          ...state.draft,
          initialCwd: nextDefaultCwd,
          updatedAt: Date.now(),
        };
        if (!state.directoryPickerPath || state.directoryPickerPath === state.defaultCwd) {
          updates.directoryPickerPath = nextDefaultCwd;
        }
      }

      return updates;
    });
  },
  setDirectoryPickerPath(path) {
    set({ directoryPickerPath: path });
  },
  startNewChat(input) {
    set((state) => {
      const normalized = normalizeStartNewChatInput(input);
      const id = normalized.draftId ?? nextDraftId();
      const persistedDraft = loadPersistedDraft(id);
      const initialCwd =
        normalized.cwd ??
        persistedDraft?.cwd ??
        persistedDraft?.initialCwd ??
        state.draft?.cwd ??
        state.draft?.initialCwd ??
        state.defaultCwd;
      const draft = persistedDraft
        ? {
            ...persistedDraft,
            initialCwd,
          }
        : {
            cwd: null,
            id,
            initialCwd,
            snapshot: createEmptyComposerSnapshot(),
            updatedAt: Date.now(),
          };

      return {
        activeDraftId: id,
        activeThreadId: null,
        directoryPickerOpen: !draft.cwd,
        directoryPickerPath: draft.cwd ?? draft.initialCwd,
        draft,
      };
    });
  },
}));

function nextDraftId() {
  draftGeneration += 1;
  return `codex:draft:${Date.now()}:${draftGeneration}`;
}

function normalizeDefaultCwd(cwd: string | null | undefined) {
  return cwd?.trim() || defaultCodexCwd;
}

function normalizeStartNewChatInput(input: StartNewChatInput | string | undefined): Required<StartNewChatInput> {
  if (typeof input === 'string') {
    return {
      cwd: input,
      draftId: null,
    };
  }

  return {
    cwd: input?.cwd ?? null,
    draftId: input?.draftId?.trim() || null,
  };
}

export function parentDirectory(path: string) {
  const normalized = normalizePath(path);
  if (!normalized || normalized === '/') {
    return null;
  }

  const withoutTrailingSlash = normalized.replace(/\/+$/, '');
  const slashIndex = withoutTrailingSlash.lastIndexOf('/');
  return slashIndex <= 0 ? '/' : withoutTrailingSlash.slice(0, slashIndex);
}

function normalizePath(path: string) {
  return path.replace(/\\/g, '/') || '/';
}

useThreadsStore.subscribe((state) => {
  if (state.draft?.cwd) {
    persistDraft(state.draft);
  }
});

function draftStorageKey(draftId: string) {
  return `${draftStorageKeyPrefix}:${encodeURIComponent(draftId)}`;
}

function loadPersistedDraft(draftId: string): NewChatDraft | null {
  const storage = sessionStorageOrNull();
  if (!storage) {
    return null;
  }

  try {
    const raw = storage.getItem(draftStorageKey(draftId));
    if (!raw) {
      return null;
    }

    const parsed = JSON.parse(raw) as Partial<NewChatDraft>;
    if (
      parsed.id !== draftId ||
      typeof parsed.cwd !== 'string' ||
      typeof parsed.initialCwd !== 'string' ||
      !parsed.snapshot ||
      !Array.isArray(parsed.snapshot.document?.parts)
    ) {
      return null;
    }

    return {
      cwd: parsed.cwd,
      id: draftId,
      initialCwd: parsed.initialCwd,
      snapshot: sanitizeDraftSnapshot(parsed.snapshot),
      updatedAt: typeof parsed.updatedAt === 'number' ? parsed.updatedAt : Date.now(),
    };
  } catch {
    storage.removeItem(draftStorageKey(draftId));
    return null;
  }
}

function loadLegacyPersistedDraft(): NewChatDraft | null {
  const storage = sessionStorageOrNull();
  if (!storage) {
    return null;
  }

  try {
    const raw = storage.getItem(legacyDraftStorageKey);
    if (!raw) {
      return null;
    }

    const parsed = JSON.parse(raw) as Partial<NewChatDraft> & { id?: number | string };
    if (
      typeof parsed.cwd !== 'string' ||
      typeof parsed.initialCwd !== 'string' ||
      !parsed.snapshot ||
      !Array.isArray(parsed.snapshot.document?.parts)
    ) {
      return null;
    }

    return {
      cwd: parsed.cwd,
      id: `codex:legacy-draft:${typeof parsed.id === 'number' || typeof parsed.id === 'string' ? parsed.id : Date.now()}`,
      initialCwd: parsed.initialCwd,
      snapshot: sanitizeDraftSnapshot(parsed.snapshot),
      updatedAt: typeof parsed.updatedAt === 'number' ? parsed.updatedAt : Date.now(),
    };
  } catch {
    storage.removeItem(legacyDraftStorageKey);
    return null;
  }
}

function persistDraft(draft: NewChatDraft) {
  const storage = sessionStorageOrNull();
  if (!storage) {
    return;
  }

  try {
    storage.setItem(draftStorageKey(draft.id), JSON.stringify({
      ...draft,
      snapshot: sanitizeDraftSnapshot(draft.snapshot),
    }));
  } catch {
    // Large image drafts can exceed sessionStorage quota; keep the in-memory draft.
  }
}

function deletePersistedDraft(draftId: string | null | undefined) {
  const storage = sessionStorageOrNull();
  if (!storage || !draftId) {
    return;
  }

  storage.removeItem(draftStorageKey(draftId));
}

function sanitizeDraftSnapshot(snapshot: ComposerSnapshot): ComposerSnapshot {
  return {
    ...snapshot,
    attachments: snapshot.attachments.map((attachment) => ({
      ...attachment,
      previewUrl: attachment.dataUrl,
    })),
  };
}

function sessionStorageOrNull() {
  try {
    return globalThis.sessionStorage ?? null;
  } catch {
    return null;
  }
}
