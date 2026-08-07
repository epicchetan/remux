import type { ComposerSnapshot } from './composerModel.ts';

export type ComposerSendProjection =
  | { displayText: string; text: string; type: 'ok' }
  | { message: string; type: 'error' };

export function buildComposerSendProjection(snapshot: ComposerSnapshot): ComposerSendProjection {
  const text = snapshot.plainText.trim();
  if (!text) {
    return { message: 'Enter a message.', type: 'error' };
  }
  return { displayText: text, text, type: 'ok' };
}
