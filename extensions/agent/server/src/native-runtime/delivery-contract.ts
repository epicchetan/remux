import type { ProviderEventEnvelope } from '../../../shared/provider-runtime.ts';

export type ProviderCrossing =
  | { phase: 'not-sent'; detail: 'validation' | 'closed-before-write' | 'preparation' }
  | { phase: 'possibly-sent'; detail: 'entered-write' | 'stdin-yielded' | 'response-lost' };

export type ProviderDeliveryError = { code: string; message: string; retryable?: boolean };

export type ProviderAcceptanceEvidence =
  | { kind: 'codex-turn-start-response'; threadId: string; turnId: string; nativeClientMessageId: string }
  | { kind: 'codex-turn-steer-response'; threadId: string; turnId: string; nativeClientMessageId: string }
  | { kind: 'codex-compact-response'; threadId: string; requestId: number; connectionGeneration: string }
  | { kind: 'codex-history-client-id'; threadId: string; nativeClientMessageId: string; nativeTurnId?: string }
  | { kind: 'claude-root-processing'; sessionId: string; userMessageUuid: string; observationUuid: string }
  | { kind: 'claude-manual-compact-boundary'; sessionId: string; boundaryUuid: string; processGeneration: string; trigger: 'manual' }
  | { kind: 'fixture-correlated-acceptance'; sessionId: string; commandId: string; nativeTurnId?: string };

export type ProviderReceiptEvidence = never;
export type ProviderDispatchResult =
  | { accepted: true; outcome: 'accepted'; evidence: ProviderAcceptanceEvidence; nativeTurnId?: string; nativeOperationId?: string }
  | { accepted: false; outcome: 'rejected'; crossing: Extract<ProviderCrossing, { phase: 'not-sent' }>; error: ProviderDeliveryError; nativeTurnId?: undefined }
  | { accepted: false; outcome: 'unknown'; crossing: Extract<ProviderCrossing, { phase: 'possibly-sent' }>; error: ProviderDeliveryError; receiptEvidence?: ProviderReceiptEvidence; nativeTurnId?: undefined };
export type ProviderNegativeCoverage = never;
export type ProviderPresenceRead =
  | { presence: 'present'; evidence: ProviderAcceptanceEvidence }
  | { presence: 'absent'; coverage: ProviderNegativeCoverage }
  | { presence: 'unknown'; reason: string };

export interface DispatchBoundary {
  markPossiblySent(nativeSessionId: string, processGeneration?: string): void;
}

export type SteerDispatchContext = {
  boundary: DispatchBoundary;
  nativeClientMessageId: string;
  expectedNativeTurnId: string;
};

export type CompactDispatchContext = {
  boundary: DispatchBoundary;
  nativeInputUuid?: string;
};

export type ProviderPositiveRead = (attempt: FrozenDeliveryAttempt) => Promise<ProviderPresenceRead>;
export type DeliveryAttemptKind = 'root-turn' | 'steer' | 'manual-compact';
export type DeliveryAttemptState = 'preparing' | 'dispatching' | 'accepted' | 'rejected' | 'unknown';
export type FrozenDeliveryAttempt = {
  attemptId: string; commandId: string; kind: DeliveryAttemptKind;
  provider: 'codex' | 'claude-code' | 'fixture'; providerInstanceId: string;
  conversationId: string; executionId: string; intendedTurnId?: string;
  clientMessageId?: string; nativeClientMessageId?: string; compactOperationId?: string;
  recoveryPayloadHash: string; recoveryPayloadJson: string; nativeSessionId: string;
  processGeneration?: string; nativeTurnId?: string; nativeOperationId?: string;
  ownerInstanceId: string; state: DeliveryAttemptState; crossedAt?: number;
  acceptanceEvidence?: ProviderAcceptanceEvidence; transcriptGap: boolean;
};

export type StagedProviderEnvelope = { ordinal: number; observationId: string; envelope: ProviderEventEnvelope; byteLength: number; observedAt: number };

export function requireLegacyAcceptance(result: ProviderDispatchResult) {
  if (result.outcome === 'accepted') return { accepted: true as const, ...(result.nativeTurnId ? { nativeTurnId: result.nativeTurnId } : {}) };
  const error = new Error(result.error.message);
  Object.assign(error, { deliveryOutcome: result.outcome, crossing: result.crossing });
  throw error;
}
