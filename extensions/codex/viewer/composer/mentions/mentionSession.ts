import type { ComposerMentionItem } from './mentionSearch';

export type ComposerMentionSession = {
  close: () => void;
  query: string;
  removeTrigger: () => void;
  selectFile: (file: ComposerMentionItem) => void;
};
