import {
  DEFAULT_TURN_CONTEXT_DIALOGUE_TURNS,
  type TurnContextPlan,
  type TurnContextResolution,
} from '../../../../shared/protocol.ts';

export function createDefaultTurnContextPlan(): TurnContextPlan {
  return {
    version: 1,
    automaticDialogueTurns: DEFAULT_TURN_CONTEXT_DIALOGUE_TURNS,
    overrides: [],
  };
}

export function effectiveTurnContextResolution(
  plan: TurnContextPlan,
  eligibleTurnIds: readonly string[],
  turnId: string,
): TurnContextResolution {
  const explicit = plan.overrides.find((override) => override.turnId === turnId);
  if (explicit) return explicit.resolution;
  return plan.automaticDialogueTurns > 0 &&
    eligibleTurnIds.slice(-plan.automaticDialogueTurns).includes(turnId)
    ? 'dialogue'
    : 'off';
}

export function withTurnContextResolution(
  plan: TurnContextPlan,
  eligibleTurnIds: readonly string[],
  turnId: string,
  resolution: TurnContextResolution,
): TurnContextPlan {
  const automatic = plan.automaticDialogueTurns > 0 &&
    eligibleTurnIds.slice(-plan.automaticDialogueTurns).includes(turnId)
    ? 'dialogue'
    : 'off';
  const overrides = plan.overrides.filter((override) => override.turnId !== turnId);
  if (resolution !== automatic) overrides.push({ turnId, resolution });
  return { ...plan, overrides };
}

export function parsePersistedTurnContextPlan(value: unknown): TurnContextPlan | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Partial<TurnContextPlan>;
  if (
    candidate.version !== 1 ||
    !Number.isSafeInteger(candidate.automaticDialogueTurns) ||
    (candidate.automaticDialogueTurns ?? -1) < 0 ||
    !Array.isArray(candidate.overrides)
  ) return null;
  const seen = new Set<string>();
  const overrides = candidate.overrides.flatMap((override) => {
    if (
      !override ||
      typeof override.turnId !== 'string' ||
      !override.turnId ||
      seen.has(override.turnId) ||
      (override.resolution !== 'off' && override.resolution !== 'dialogue' && override.resolution !== 'full')
    ) return [];
    seen.add(override.turnId);
    return [{ turnId: override.turnId, resolution: override.resolution }];
  });
  if (overrides.length !== candidate.overrides.length) return null;
  return {
    version: 1,
    automaticDialogueTurns: candidate.automaticDialogueTurns!,
    overrides,
  };
}
