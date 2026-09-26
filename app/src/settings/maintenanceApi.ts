import type { RemuxConnection } from '../remote/RemuxConnectionProvider';

const maintenanceReadMethod = 'remux/maintenance/agent-autoupdate/read';

/** Mirrors `RunOutcome` in `crates/remux/src/maintenance.rs` (serde tag `decision`). */
export type AgentAutoupdateOutcome =
  | { decision: 'Skipped'; stage: string; reason: string }
  | { decision: 'Deferred'; stage: string; reason: string }
  | { decision: 'Upgraded'; cli: string; sdk: string }
  | { decision: 'RolledBack'; stage: string; error: string }
  | { decision: 'Held'; target: string; attempts: number; reason: string }
  | { decision: 'NoOp' }
  | { decision: 'Plan'; cli: string; current: string; target: string };

export type AgentAutoupdateHold = {
  target: string;
  attempts: number;
  reason: string;
  timestamp: number;
};

/** Mirrors `MaintenanceStatus` — the state flattened under its schedule. */
export type AgentAutoupdateStatus = {
  enabled: boolean;
  window: string;
  inWindow: boolean;
  quietMinutes: number;
  lastRun: number | null;
  lastResult: AgentAutoupdateOutcome | null;
  lastDeferReason: string | null;
  installedCliVersion: string | null;
  pinnedSdkVersion: string | null;
  hold: AgentAutoupdateHold | null;
  stateError: string | null;
};

/**
 * Returns null when the runtime predates the maintenance driver, which the card
 * renders as no auto-update line rather than as a fault.
 */
export async function readAgentAutoupdateStatus(
  query: RemuxConnection['query'],
): Promise<AgentAutoupdateStatus | null> {
  try {
    const response = await query<unknown>(maintenanceReadMethod, undefined, {
      resourceKey: 'agent-autoupdate',
    });
    return parseAgentAutoupdateStatus(response);
  } catch (error) {
    if (isMethodNotFound(error)) return null;
    throw error;
  }
}

export function parseAgentAutoupdateStatus(value: unknown): AgentAutoupdateStatus {
  if (
    !isRecord(value)
    || typeof value.enabled !== 'boolean'
    || typeof value.window !== 'string'
    || typeof value.inWindow !== 'boolean'
    || !isFiniteNumber(value.quietMinutes)
  ) {
    throw new Error('Invalid agent auto-update status response');
  }
  return {
    enabled: value.enabled,
    window: value.window,
    inWindow: value.inWindow,
    quietMinutes: value.quietMinutes,
    lastRun: isFiniteNumber(value.lastRun) ? value.lastRun : null,
    lastResult: parseOutcome(value.lastResult),
    lastDeferReason: typeof value.lastDeferReason === 'string' ? value.lastDeferReason : null,
    installedCliVersion: typeof value.installedCliVersion === 'string' ? value.installedCliVersion : null,
    pinnedSdkVersion: typeof value.pinnedSdkVersion === 'string' ? value.pinnedSdkVersion : null,
    hold: parseHold(value.hold),
    stateError: typeof value.stateError === 'string' ? value.stateError : null,
  };
}

/**
 * The value of the card's "Auto-update" row. Holding wins over everything: it
 * is the only state the owner may want to act on. Otherwise: what the last run
 * decided, then the window the next one will use.
 */
export function describeAgentAutoupdate(status: AgentAutoupdateStatus): string {
  if (status.stateError) return `State unreadable: ${status.stateError}`;
  if (!status.enabled) return 'Off';
  if (status.hold) {
    return `Holding on ${status.hold.target} after ${status.hold.attempts} attempt${
      status.hold.attempts === 1 ? '' : 's'
    } — ${status.hold.reason}`;
  }
  const schedule = `nightly ${status.window.replace('-', '–')}`;
  if (!status.lastRun || !status.lastResult) return `On · ${schedule}`;
  return `${describeOutcome(status.lastResult)} ${relativeTime(status.lastRun)} · ${schedule}`;
}

function describeOutcome(outcome: AgentAutoupdateOutcome): string {
  switch (outcome.decision) {
    case 'Upgraded':
      return `Updated to ${outcome.cli} (SDK ${outcome.sdk})`;
    case 'NoOp':
      return 'Checked, already current';
    case 'Skipped':
      return `Skipped (${outcome.reason})`;
    case 'Deferred':
      return `Deferred (${outcome.reason})`;
    case 'RolledBack':
      return `Rolled back at ${outcome.stage}`;
    case 'Held':
      return `Holding on ${outcome.target}`;
    case 'Plan':
      return `Dry run ${outcome.current} → ${outcome.target}`;
  }
}

function relativeTime(timestamp: number): string {
  const minutes = Math.max(0, Math.round((Date.now() - timestamp) / 60_000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function parseOutcome(value: unknown): AgentAutoupdateOutcome | null {
  if (!isRecord(value) || typeof value.decision !== 'string') return null;
  const string = (key: string) => (typeof value[key] === 'string' ? value[key] as string : '');
  switch (value.decision) {
    case 'Skipped':
    case 'Deferred':
      return { decision: value.decision, stage: string('stage'), reason: string('reason') };
    case 'Upgraded':
      return { decision: 'Upgraded', cli: string('cli'), sdk: string('sdk') };
    case 'RolledBack':
      return { decision: 'RolledBack', stage: string('stage'), error: string('error') };
    case 'Held':
      return {
        decision: 'Held',
        target: string('target'),
        attempts: isFiniteNumber(value.attempts) ? value.attempts : 0,
        reason: string('reason'),
      };
    case 'NoOp':
      return { decision: 'NoOp' };
    case 'Plan':
      return {
        decision: 'Plan',
        cli: string('cli'),
        current: string('current'),
        target: string('target'),
      };
    default:
      return null;
  }
}

function parseHold(value: unknown): AgentAutoupdateHold | null {
  if (!isRecord(value)) return null;
  if (typeof value.target !== 'string' || typeof value.reason !== 'string') return null;
  return {
    target: value.target,
    attempts: isFiniteNumber(value.attempts) ? value.attempts : 0,
    reason: value.reason,
    timestamp: isFiniteNumber(value.timestamp) ? value.timestamp : 0,
  };
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isMethodNotFound(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('-32601') || message.toLowerCase().includes('method not found');
}
