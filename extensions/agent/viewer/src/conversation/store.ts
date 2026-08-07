import { create } from 'zustand';

type ConversationDraftStore = {
  cwd: string;
  directoryPickerOpen: boolean;
  directoryPickerPath: string | null;
  closeDirectoryPicker: () => void;
  initializeCwd: (cwd: string) => void;
  openDirectoryPicker: () => void;
  selectDirectoryPickerPath: () => void;
  setCwd: (cwd: string) => void;
  setDirectoryPickerPath: (path: string) => void;
};

export const useConversationStore = create<ConversationDraftStore>((set, get) => ({
  cwd: '',
  directoryPickerOpen: false,
  directoryPickerPath: null,
  closeDirectoryPicker: () => set({ directoryPickerOpen: false, directoryPickerPath: null }),
  initializeCwd: (cwd) => set((state) => state.cwd ? {} : { cwd }),
  openDirectoryPicker: () => {
    const cwd = get().cwd;
    if (!cwd) return;
    set({ directoryPickerOpen: true, directoryPickerPath: cwd });
  },
  selectDirectoryPickerPath: () => {
    const path = get().directoryPickerPath;
    if (!path) return;
    set({ cwd: path, directoryPickerOpen: false, directoryPickerPath: null });
  },
  setCwd: (cwd) => set({ cwd }),
  setDirectoryPickerPath: (directoryPickerPath) => set({ directoryPickerPath }),
}));
