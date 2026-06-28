import { createCommand, type LexicalCommand } from 'lexical';

export type InsertComposerAttachmentPayload = {
  id: string;
  mimeType: string | null;
  name: string;
  preserveDomFocus?: boolean;
};

export type RemoveComposerAttachmentPayload = {
  id: string;
  preserveDomFocus?: boolean;
};

export const INSERT_COMPOSER_ATTACHMENT_COMMAND: LexicalCommand<InsertComposerAttachmentPayload> = createCommand(
  'INSERT_COMPOSER_ATTACHMENT_COMMAND',
);

export const REMOVE_COMPOSER_ATTACHMENT_COMMAND: LexicalCommand<RemoveComposerAttachmentPayload> = createCommand(
  'REMOVE_COMPOSER_ATTACHMENT_COMMAND',
);
