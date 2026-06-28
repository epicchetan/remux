import {
  readFile,
  type ReadFileGitMetadata,
  type ReadFileResult,
} from '@remux/extension-api/fs';
import { create } from 'zustand';

type EditorFileState =
  | { status: 'idle' }
  | { path: string; status: 'loading' }
  | {
      content: string;
      encoding: 'utf8';
      modifiedAtMs: number | null;
      name: string;
      path: string;
      sizeBytes: number;
      status: 'ready';
      git: ReadFileGitMetadata | null;
    }
  | {
      isBinary: boolean;
      modifiedAtMs: number | null;
      name: string;
      path: string;
      sizeBytes: number;
      status: 'unsupported';
      tooLarge: boolean;
    }
  | { message: string; path: string; status: 'error' };

type EditorStore = {
  activeFile: EditorFileState;
  loadFile: (path: string) => Promise<void>;
};

let loadGeneration = 0;

export const useEditorStore = create<EditorStore>((set) => ({
  activeFile: { status: 'idle' },
  loadFile: async (path) => {
    const generation = ++loadGeneration;
    set({
      activeFile: { path, status: 'loading' },
    });

    try {
      const result = await readFile(path, {
        git: {
          includeBase: true,
          includeStatus: true,
        },
      });
      if (generation !== loadGeneration) {
        return;
      }

      const activeFile = fileStateFromResult(result);
      set({ activeFile });
    } catch (error) {
      if (generation !== loadGeneration) {
        return;
      }

      set({
        activeFile: {
          message: error instanceof Error ? error.message : String(error),
          path,
          status: 'error',
        },
      });
    }
  },
}));

function fileStateFromResult(result: ReadFileResult): EditorFileState {
  if (result.content === null || result.encoding !== 'utf8') {
    return {
      isBinary: result.isBinary,
      modifiedAtMs: result.modifiedAtMs,
      name: result.name,
      path: result.path,
      sizeBytes: result.sizeBytes,
      status: 'unsupported',
      tooLarge: result.tooLarge,
    };
  }

  return {
    content: result.content,
    encoding: result.encoding,
    modifiedAtMs: result.modifiedAtMs,
    name: result.name,
    path: result.path,
    sizeBytes: result.sizeBytes,
    status: 'ready',
    git: result.git ?? null,
  };
}
