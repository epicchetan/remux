import { CONTEXT_POLICY_VERSION } from './manifest.ts';

export type ContextPolicy = {
  version: string;
  outputReserveTokens: number;
  safetyMarginTokens: number;
  hardInputLimitTokens: number;
  admissionLimitTokens: number;
  softNoticeTokens: number;
  rollThresholdTokens: number;
  snapshotTargetTokens: number;
  snapshotHardMaxTokens: number;
  oversizedValueBytes: number;
};

export type ContextPolicyOverrides = Partial<Omit<ContextPolicy, 'version' | 'hardInputLimitTokens' | 'admissionLimitTokens'>> & {
  version?: string;
  hardInputLimitTokens?: number;
};

export function contextPolicyForModel(
  contextWindow: number,
  overrides: ContextPolicyOverrides = {},
): ContextPolicy {
  if (!Number.isSafeInteger(contextWindow) || contextWindow <= 0) {
    throw new TypeError('contextWindow must be a positive safe integer.');
  }
  const outputReserveTokens = positiveInteger(
    overrides.outputReserveTokens ?? 25_000,
    'outputReserveTokens',
  );
  const safetyMarginTokens = nonnegativeInteger(
    overrides.safetyMarginTokens ?? 5_000,
    'safetyMarginTokens',
  );
  const hardInputLimitTokens = positiveInteger(
    overrides.hardInputLimitTokens ?? Math.max(1, contextWindow - outputReserveTokens),
    'hardInputLimitTokens',
  );
  const admissionLimit = Math.max(1, hardInputLimitTokens - safetyMarginTokens);
  const softNoticeTokens = positiveInteger(
    overrides.softNoticeTokens ?? Math.min(
      overrides.rollThresholdTokens ?? Number.MAX_SAFE_INTEGER,
      Math.max(1, Math.floor(admissionLimit * 0.82)),
    ),
    'softNoticeTokens',
  );
  const rollThresholdTokens = positiveInteger(
    overrides.rollThresholdTokens ?? Math.max(1, Math.floor(admissionLimit * 0.94)),
    'rollThresholdTokens',
  );
  const snapshotHardMaxTokens = positiveInteger(
    overrides.snapshotHardMaxTokens ?? Math.min(30_000, admissionLimit),
    'snapshotHardMaxTokens',
  );
  const snapshotTargetTokens = positiveInteger(
    overrides.snapshotTargetTokens ?? Math.min(18_000, snapshotHardMaxTokens),
    'snapshotTargetTokens',
  );
  if (rollThresholdTokens > admissionLimit) {
    throw new TypeError('rollThresholdTokens must not exceed the effective admission limit.');
  }
  if (softNoticeTokens > rollThresholdTokens) {
    throw new TypeError('softNoticeTokens must not exceed rollThresholdTokens.');
  }
  if (snapshotTargetTokens > snapshotHardMaxTokens) {
    throw new TypeError('snapshotTargetTokens must not exceed snapshotHardMaxTokens.');
  }
  if (snapshotHardMaxTokens > admissionLimit) {
    throw new TypeError('snapshotHardMaxTokens must not exceed the effective admission limit.');
  }
  return {
    version: overrides.version ?? CONTEXT_POLICY_VERSION,
    outputReserveTokens,
    safetyMarginTokens,
    hardInputLimitTokens,
    admissionLimitTokens: admissionLimit,
    softNoticeTokens,
    rollThresholdTokens,
    snapshotTargetTokens,
    snapshotHardMaxTokens,
    oversizedValueBytes: positiveInteger(overrides.oversizedValueBytes ?? 8 * 1024, 'oversizedValueBytes'),
  };
}

function positiveInteger(value: number, label: string) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${label} must be a positive safe integer.`);
  return value;
}

function nonnegativeInteger(value: number, label: string) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a nonnegative safe integer.`);
  }
  return value;
}
