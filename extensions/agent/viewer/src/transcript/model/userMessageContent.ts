import type { AgentUserMessageSegment } from '../../../../shared/transcript';

export type UserMessageLayout = {
  bodyMarkdown: string;
  railItems: [];
  revision: string;
};

export function buildUserMessageLayout(
  message: Pick<AgentUserMessageSegment, 'id' | 'revision' | 'text' | 'type'>,
  _placement: 'topLevel' | 'work' = 'topLevel',
): UserMessageLayout {
  return {
    bodyMarkdown: message.text,
    railItems: [],
    revision: `${message.id}:${message.revision}`,
  };
}

export function plainTextFromUserMessage(message: Pick<AgentUserMessageSegment, 'text'>) {
  return message.text;
}
