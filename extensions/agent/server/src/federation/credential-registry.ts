import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

import type {
  NativeSessionRef,
  ProviderAccess,
  ProviderKind,
} from '../../../shared/provider-runtime.ts';
import { FEDERATION_TOOLS } from './constants.ts';

export { FEDERATION_TOOLS } from './constants.ts';

export type FederationToolName = typeof FEDERATION_TOOLS[number];

export type FederationTargetCatalogEntry = {
  providerInstanceId: string;
  provider: ProviderKind;
  label: string;
  models: readonly {
    id: string;
    name: string;
    supportedEffort: readonly string[];
    isDefault: boolean;
  }[];
};

export type FederationCredentialScope = {
  generation: string;
  conversationId: string;
  executionId: string;
  provider: ProviderKind;
  providerInstanceId: string;
  access: ProviderAccess;
  depth: number;
  tools: readonly FederationToolName[];
  targetCatalog: readonly FederationTargetCatalogEntry[];
  nativeSessionId?: string;
};

type CredentialRecord = FederationCredentialScope & {
  revoked: boolean;
  lastSeenAt: number;
};

export type FederationCredential = {
  token: string;
  bindNativeSession(nativeSession: NativeSessionRef): void;
  touch(): void;
  revoke(): void;
};

export type ResolvedFederationTarget = {
  providerInstanceId: string;
  model: string;
  effort?: string;
};

/** Resolve a spawn target only from the immutable catalog captured at issuance. */
export function resolveFederationTarget(
  scope: FederationCredentialScope,
  requested: { providerInstanceId: string; model?: string; effort?: string },
): ResolvedFederationTarget {
  const target = scope.targetCatalog.find(({ providerInstanceId }) =>
    providerInstanceId === requested.providerInstanceId);
  if (!target) {
    throw new Error(`Federation target ${requested.providerInstanceId} is outside this credential scope.`);
  }
  const model = requested.model
    ? target.models.find(({ id }) => id === requested.model)
    : target.models.find(({ isDefault }) => isDefault) ?? target.models[0];
  if (requested.model && !model) {
    throw new Error(`Federation model ${requested.model} is outside this credential scope.`);
  }
  if (!model) {
    throw new Error(`Federation target ${requested.providerInstanceId} has no model in this credential scope.`);
  }
  if (requested.effort && !model.supportedEffort.includes(requested.effort)) {
    throw new Error(`Effort ${requested.effort} is outside the credential scope for federation model ${model.id}.`);
  }
  return {
    providerInstanceId: target.providerInstanceId,
    model: model.id,
    ...(requested.effort ? { effort: requested.effort } : {}),
  };
}

/** In-memory bearer credentials. Tokens are never persisted or exposed as resources. */
export class FederationCredentialRegistry {
  private static readonly MAX_IDLE_MS = 24 * 60 * 60 * 1_000;
  private readonly records = new Map<string, CredentialRecord>();
  private readonly now: () => number;

  constructor(options: { now?: () => number } = {}) {
    this.now = options.now ?? Date.now;
  }

  issue(scope: Omit<FederationCredentialScope, 'nativeSessionId'>): FederationCredential {
    const token = randomBytes(32).toString('base64url');
    const tokenHash = hashToken(token);
    const record: CredentialRecord = {
      ...structuredClone(scope),
      revoked: false,
      lastSeenAt: this.now(),
    };
    this.records.set(tokenHash, record);
    return {
      token,
      bindNativeSession: (nativeSession) => {
        if (record.revoked) throw new Error('Federation credential is revoked.');
        if (nativeSession.provider !== record.provider ||
            nativeSession.providerInstanceId !== record.providerInstanceId) {
          throw new Error('Federation credential cannot bind a different provider session.');
        }
        record.nativeSessionId = nativeSession.sessionId;
        record.lastSeenAt = this.now();
      },
      touch: () => {
        if (!record.revoked) record.lastSeenAt = this.now();
      },
      revoke: () => {
        record.revoked = true;
        this.records.delete(tokenHash);
      },
    };
  }

  resolve(token: string, currentGeneration: string): FederationCredentialScope {
    const tokenHash = hashToken(token);
    let recordKey: string | undefined;
    const tokenDigest = Buffer.from(tokenHash, 'hex');
    for (const candidate of this.records.keys()) {
      if (timingSafeEqual(Buffer.from(candidate, 'hex'), tokenDigest)) recordKey = candidate;
    }
    const record = recordKey ? this.records.get(recordKey) : undefined;
    if (!record || record.revoked || record.generation !== currentGeneration ||
        this.now() - record.lastSeenAt > FederationCredentialRegistry.MAX_IDLE_MS) {
      if (record) {
        record.revoked = true;
        this.records.delete(recordKey!);
      }
      throw new FederationAuthorizationError('Federation credential is invalid or expired.');
    }
    if (!record.nativeSessionId) {
      throw new FederationAuthorizationError('Federation credential is not bound to a native session.');
    }
    record.lastSeenAt = this.now();
    const { revoked: _revoked, lastSeenAt: _lastSeenAt, ...scope } = record;
    return structuredClone(scope);
  }

  revokeAll() {
    for (const record of this.records.values()) record.revoked = true;
    this.records.clear();
  }
}

function hashToken(token: string) {
  return createHash('sha256').update(token).digest('hex');
}

export class FederationAuthorizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FederationAuthorizationError';
  }
}
