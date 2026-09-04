import type { ConversationSummary } from '../../../shared/protocol.ts';
import { shortenPath } from './format.ts';

type HistoryIdentity = Pick<ConversationSummary, 'cwd' | 'preview' | 'provider' | 'title'>;

export function conversationHistoryTitle(conversation: HistoryIdentity) {
  const title = conversation.title.trim();
  if (isMeaningfulConversationTitle(title)) return title;
  const preview = normalizedPreview(conversation.preview);
  if (preview === '[Attached image]') return 'Image conversation';
  return preview || 'Untitled conversation';
}

export function conversationHistorySubtitle(conversation: HistoryIdentity) {
  const title = conversation.title.trim();
  const preview = normalizedPreview(conversation.preview);
  if (isMeaningfulConversationTitle(title) && preview && preview !== title) return preview;
  return shortenPath(conversation.cwd) || 'No message preview';
}

export function nativeModelId(modelId: string) {
  return modelId.includes('::') ? modelId.slice(modelId.indexOf('::') + 2) : modelId;
}

export function providerLabel(provider: ConversationSummary['provider']) {
  if (provider === 'claude-code') return 'Claude';
  if (provider === 'codex') return 'Codex';
  return 'Agent';
}

function isMeaningfulConversationTitle(title: string) {
  if (!title) return false;
  if (/^(?:new|untitled) (?:chat|conversation|thread)$/iu.test(title)) return false;
  if (/^(?:edited|forked) chat$/iu.test(title)) return false;
  return !/\s+\(fork\)$/iu.test(title);
}

function normalizedPreview(preview: string) {
  return preview.trim().replace(/\s+/gu, ' ');
}
