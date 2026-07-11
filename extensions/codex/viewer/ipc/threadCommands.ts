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
import { requestIpc } from '@remux/viewer-kit/ipc';
import { rpcPolicies } from '@remux/viewer-kit/rpc-policy';

export const threadCompactMethod = 'remux/codex/thread/compact';
export const threadMessageEditMethod = 'remux/codex/thread/message/edit';
export const threadMessageForkMethod = 'remux/codex/thread/message/fork';
export const threadMessageSendMethod = 'remux/codex/thread/message/send';
export const threadMessageStartMethod = 'remux/codex/thread/message/start';
export const threadTurnInterruptMethod = 'remux/codex/thread/turn/interrupt';

export function compactThread(params: CodexThreadCompactParams) {
  return requestIpc<CodexThreadCompactResponse>(rpcPolicies['codex-compact'], params);
}

export function editThreadMessage(params: CodexThreadMessageEditParams) {
  return requestIpc<CodexThreadMessageEditResponse>(rpcPolicies['codex-message-edit'], params);
}

export function forkThreadMessage(params: CodexThreadMessageForkParams) {
  return requestIpc<CodexThreadMessageForkResponse>(rpcPolicies['codex-message-fork'], params);
}

export function sendThreadMessage(params: CodexThreadMessageSendParams) {
  return requestIpc<CodexThreadMessageSendResponse>(rpcPolicies['codex-message-send'], params);
}

export function startThreadMessage(params: CodexThreadMessageStartParams) {
  return requestIpc<CodexThreadMessageStartResponse>(rpcPolicies['codex-message-start'], params);
}

export function interruptThreadTurn(params: CodexThreadTurnInterruptParams) {
  return requestIpc<CodexThreadTurnInterruptResponse>(rpcPolicies['codex-turn-interrupt'], params);
}
