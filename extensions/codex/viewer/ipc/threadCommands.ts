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
import { requestIpc } from './client';

export const threadCompactMethod = 'remux/codex/thread/compact';
export const threadMessageEditMethod = 'remux/codex/thread/message/edit';
export const threadMessageForkMethod = 'remux/codex/thread/message/fork';
export const threadMessageSendMethod = 'remux/codex/thread/message/send';
export const threadMessageStartMethod = 'remux/codex/thread/message/start';
export const threadTurnInterruptMethod = 'remux/codex/thread/turn/interrupt';

export function compactThread(params: CodexThreadCompactParams) {
  return requestIpc<CodexThreadCompactResponse>(threadCompactMethod, params);
}

export function editThreadMessage(params: CodexThreadMessageEditParams) {
  return requestIpc<CodexThreadMessageEditResponse>(threadMessageEditMethod, params);
}

export function forkThreadMessage(params: CodexThreadMessageForkParams) {
  return requestIpc<CodexThreadMessageForkResponse>(threadMessageForkMethod, params);
}

export function sendThreadMessage(params: CodexThreadMessageSendParams) {
  return requestIpc<CodexThreadMessageSendResponse>(threadMessageSendMethod, params);
}

export function startThreadMessage(params: CodexThreadMessageStartParams) {
  return requestIpc<CodexThreadMessageStartResponse>(threadMessageStartMethod, params);
}

export function interruptThreadTurn(params: CodexThreadTurnInterruptParams) {
  return requestIpc<CodexThreadTurnInterruptResponse>(threadTurnInterruptMethod, params);
}
