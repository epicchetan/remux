import type {
  AcceptTurnParams,
  AcceptTurnResult,
  CreateConversationParams,
  CreateConversationResult,
  DurableTranscriptAction,
  DurableTranscriptProjection,
  DurableTranscriptWindowProjection,
  DurableTranscriptMutation,
  DurableTurnErrorCode,
  DurableTurnHandle,
  DurableResourceProjection,
  DurableArtifact,
} from './storage/repository.ts';
import type { DurableContextSnapshot } from './logical-context.ts';
import type { AgentResourceKey } from '../../shared/protocol.ts';
import type { AgentTranscriptResourcesReadParams } from '../../shared/transcript.ts';

export interface AgentConversationJournal {
  createConversation(params: CreateConversationParams): Promise<CreateConversationResult>;
  reconcileTurn(params: AcceptTurnParams): Promise<AcceptTurnResult | null>;
  acceptTurn(params: AcceptTurnParams): Promise<AcceptTurnResult>;
  appendAssistantCheckpoint(
    handle: DurableTurnHandle,
    checkpoint: { textDelta: string; reasoningDelta: string },
  ): Promise<DurableTranscriptMutation | null>;
  recordToolStarted(
    handle: DurableTurnHandle,
    input: { callId: string; name: string; args: unknown },
  ): Promise<DurableTranscriptMutation | null>;
  recordToolFinished(
    handle: DurableTurnHandle,
    input: { callId: string; result: unknown; isError: boolean },
  ): Promise<DurableTranscriptMutation | null>;
  startInference(
    handle: DurableTurnHandle,
    input: {
      payload: unknown;
      requestMode: 'full' | 'continuation';
      estimatedInputTokens: number;
      context?: {
        basisSequence: number;
        logicalHash: string;
        renderedHash: string;
        messageCount: number;
      };
    },
  ): Promise<{ inferenceId: string; ordinal: number; sequence: number }>;
  finishInference(
    handle: DurableTurnHandle,
    input: { state: 'completed' | 'failed' | 'interrupted' },
  ): Promise<boolean>;
  finishTurn(
    handle: DurableTurnHandle,
    input: {
      status: 'completed' | 'failed' | 'interrupted';
      error?: string | null;
      errorCode?: DurableTurnErrorCode | null;
      durationMs?: number;
    },
  ): Promise<DurableTranscriptMutation | null>;
  compileContext(conversationId: string): Promise<DurableContextSnapshot>;
  readTranscriptActions(conversationId: string): Promise<DurableTranscriptAction[]>;
  readTranscriptBasis(conversationId: string): Promise<number | null>;
  readTranscriptProjection(conversationId: string): Promise<DurableTranscriptProjection | null>;
  readTranscriptWindowProjection(
    params: AgentTranscriptResourcesReadParams,
  ): Promise<DurableTranscriptWindowProjection | null>;
  readResourceProjections(
    keys: readonly AgentResourceKey[],
  ): Promise<Array<DurableResourceProjection | null>>;
  readArtifact(
    hash: string,
    range?: { offset: number; byteLength: number },
  ): Promise<DurableArtifact | null>;
}
