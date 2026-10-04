import { createHash } from 'node:crypto';
import type { NativeQueuedMessage } from '../../shared/native-agent-protocol.ts';
import type { JournalConversation } from '../../server/src/native-runtime/native-journal.ts';
import type { FrozenDeliveryAttempt } from '../../server/src/native-runtime/delivery-contract.ts';

/** A proven fixture delivery for tests that exercise journal admission directly. */
export function rootDeliveryFixture(conversation: JournalConversation, queued: NativeQueuedMessage,
  nativeTurnId?: string): FrozenDeliveryAttempt {
  const recoveryPayloadJson = JSON.stringify({ ...queued, nativeClientMessageId: queued.turnId });
  return {
    attemptId: `attempt:${queued.commandId}`, commandId: queued.commandId, kind: 'root-turn',
    provider: conversation.provider, providerInstanceId: conversation.providerInstanceId,
    conversationId: conversation.conversationId, executionId: conversation.rootExecutionId,
    intendedTurnId: queued.turnId, clientMessageId: queued.clientMessageId,
    nativeClientMessageId: queued.turnId, nativeSessionId: 'fixture-session', nativeTurnId,
    recoveryPayloadJson, recoveryPayloadHash: createHash('sha256').update(recoveryPayloadJson).digest('hex'),
    ownerInstanceId: 'fixture-owner', state: 'dispatching', transcriptGap: false,
    acceptanceEvidence: { kind: 'fixture-correlated-acceptance', sessionId: 'fixture-session',
      commandId: queued.commandId, nativeTurnId },
  };
}
