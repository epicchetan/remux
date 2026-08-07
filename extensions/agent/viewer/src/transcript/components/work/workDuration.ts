export function formatWorkDuration(durationMs: number) {
  return formatWorkDurationSeconds(Math.max(1, Math.round(durationMs / 1000)));
}

export function formatRunningWorkDuration(elapsedMs: number) {
  const elapsedSeconds = Math.floor(Math.max(0, elapsedMs) / 1000);
  return elapsedSeconds > 0 ? formatWorkDurationSeconds(elapsedSeconds) : null;
}

export function nextRunningWorkDurationUpdateMs(elapsedMs: number) {
  const normalizedElapsedMs = Math.max(0, elapsedMs);
  const nextSecondMs = (Math.floor(normalizedElapsedMs / 1000) + 1) * 1000;
  return Math.max(1, Math.ceil(nextSecondMs - normalizedElapsedMs));
}

function formatWorkDurationSeconds(totalSeconds: number) {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}h ${Math.floor((totalSeconds % 3600) / 60)}m`;
  }

  if (minutes === 0) {
    return `${seconds}s`;
  }

  return `${minutes}m ${seconds}s`;
}
