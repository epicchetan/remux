import { rpc } from '@remux/viewer-kit';

import {
  AGENT_METHODS,
  type AgentComposerMessagePart,
  type MessageBranchResult,
  type MessageSendResult,
  type ReasoningLevel,
} from '../../../shared/protocol.ts';

export const agentCommands = {
  cancelLogin(operationId: string) {
    return rpc.command(AGENT_METHODS.authLoginCancel, { operationId });
  },
  createConversation(input: {
    operationId: string;
    cwd: string;
    modelId: string;
    reasoning: ReasoningLevel;
  }) {
    return rpc.command<{ conversationId: string }>(AGENT_METHODS.conversationCreate, input);
  },
  interrupt(conversationId: string, turnId: string) {
    return rpc.command(AGENT_METHODS.turnInterrupt, { conversationId, turnId });
  },
  sendMessage(input: {
    operationId: string;
    conversationId: string;
    clientMessageId: string;
    parts: AgentComposerMessagePart[];
    text: string;
  }) {
    return rpc.command<MessageSendResult>(AGENT_METHODS.messageSend, input);
  },
  branchMessage(input: {
    mode: 'edit' | 'fork';
    operationId: string;
    clientMessageId: string;
    parts: AgentComposerMessagePart[];
    text: string;
    sourceConversationId: string;
    sourceMessageId: string;
    sourceTurnId: string;
  }) {
    const { mode, ...params } = input;
    return rpc.command<MessageBranchResult>(
      mode === 'edit' ? AGENT_METHODS.messageEdit : AGENT_METHODS.messageFork,
      params,
    );
  },
  login() {
    return rpc.command(AGENT_METHODS.authLoginStart);
  },
  logout() {
    return rpc.command(AGENT_METHODS.authLogout);
  },
};
