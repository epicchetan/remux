import type {
  CodexThreadCompactParams,
  CodexThreadCompactResponse,
  CodexThreadMessageEditParams,
  CodexThreadMessageEditResponse,
  CodexThreadMessageForkParams,
  CodexThreadMessageForkResponse,
  CodexThreadMessageStartParams,
  CodexThreadMessageStartResponse,
  CodexThreadMessageSendParams,
  CodexThreadMessageSendResponse,
  CodexThreadTurnInterruptParams,
  CodexThreadTurnInterruptResponse,
} from '../../shared/threadCommands';
import { rpc } from '@remux/viewer-kit/ipc';
import { createComposerNodeId } from '../composer/model/composerModel';

export const threadCompactMethod = 'remux/codex/thread/compact';
export const threadMessageEditMethod = 'remux/codex/thread/message/edit';
export const threadMessageForkMethod = 'remux/codex/thread/message/fork';
export const threadMessageSendMethod = 'remux/codex/thread/message/send';
export const threadMessageStartMethod = 'remux/codex/thread/message/start';
export const threadTurnInterruptMethod = 'remux/codex/thread/turn/interrupt';

export function compactThread(params: CodexThreadCompactParams) {
  return rpc.command<CodexThreadCompactResponse>(threadCompactMethod, params, {
    operationId: `compact:${params.threadId}:${createComposerNodeId()}`,
  });
}

export function editThreadMessage(params: CodexThreadMessageEditParams) {
  return rpc.command<CodexThreadMessageEditResponse>(threadMessageEditMethod, params, {
    operationId: params.clientMessageId ?? undefined,
  });
}

export function forkThreadMessage(params: CodexThreadMessageForkParams) {
  return rpc.command<CodexThreadMessageForkResponse>(threadMessageForkMethod, params, {
    operationId: params.clientMessageId ?? undefined,
  });
}

export function sendThreadMessage(params: CodexThreadMessageSendParams) {
  return rpc.command<CodexThreadMessageSendResponse>(threadMessageSendMethod, params, {
    operationId: params.clientMessageId ?? undefined,
  });
}

export function startThreadMessage(params: CodexThreadMessageStartParams) {
  return rpc.command<CodexThreadMessageStartResponse>(threadMessageStartMethod, params, {
    operationId: params.clientMessageId ?? undefined,
  });
}

export function interruptThreadTurn(params: CodexThreadTurnInterruptParams) {
  return rpc.command<CodexThreadTurnInterruptResponse>(threadTurnInterruptMethod, params, {
    operationId: `interrupt:${params.threadId}:${params.turnId ?? 'active'}`,
  });
}
