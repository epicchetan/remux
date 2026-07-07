import type { ExtensionServerLastExit, ExtensionServerState } from './extensionServerApi';

export function formatUptime(startedAtMs: number | null, nowMs: number): string | null {
  if (startedAtMs === null) {
    return null;
  }
  return formatDurationMs(Math.max(0, nowMs - startedAtMs));
}

export function formatDurationMs(ms: number): string {
  const totalMinutes = Math.floor(ms / 60_000);
  const days = Math.floor(totalMinutes / 1_440);
  const hours = Math.floor((totalMinutes % 1_440) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) {
    return `${days}d ${hours}h`;
  }
  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  if (totalMinutes > 0) {
    return `${minutes}m`;
  }
  return `${Math.floor(ms / 1_000)}s`;
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) {
    return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  }
  if (bytes >= 1024 ** 2) {
    return `${Math.round(bytes / 1024 ** 2)} MB`;
  }
  if (bytes >= 1024) {
    return `${Math.round(bytes / 1024)} KB`;
  }
  return `${bytes} B`;
}

export function formatLastExit(lastExit: ExtensionServerLastExit | null): string | null {
  if (!lastExit) {
    return null;
  }
  if (lastExit.reason) {
    return lastExit.reason;
  }
  if (lastExit.signal) {
    return `signal ${lastExit.signal}`;
  }
  if (lastExit.code !== null) {
    return `exit ${lastExit.code}`;
  }
  return null;
}

export function serverStateLabel(state: ExtensionServerState): string {
  switch (state) {
    case 'running':
      return 'Running';
    case 'stopped':
      return 'Stopped';
    case 'building':
      return 'Building';
    case 'starting':
      return 'Starting';
    case 'stopping':
      return 'Stopping';
    case 'backingOff':
      return 'Recovering';
    case 'failed':
      return 'Failed';
  }
}

export type ServerStateTone = 'ok' | 'idle' | 'busy' | 'bad';

/** green running / gray stopped / amber transitional / red failed. */
export function serverStateTone(state: ExtensionServerState): ServerStateTone {
  switch (state) {
    case 'running':
      return 'ok';
    case 'stopped':
      return 'idle';
    case 'failed':
      return 'bad';
    default:
      return 'busy';
  }
}
