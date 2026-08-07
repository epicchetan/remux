const maxDebugPayloadLength = 8_000;

type TranscriptDebugGlobal = typeof globalThis & {
  __REMUX_AGENT_TRANSCRIPT_DEBUG__?: unknown;
};

export function transcriptDebugEnabled() {
  const override = (globalThis as TranscriptDebugGlobal).__REMUX_AGENT_TRANSCRIPT_DEBUG__;
  if (typeof override === 'boolean') return override;
  if (override === '1' || override === 'true') return true;
  if (typeof window === 'undefined') return false;

  try {
    const params = new URLSearchParams(window.location.search);
    const query = params.get('agentTranscriptDebug');
    if (query === '0' || query === 'false') return false;
    if (query !== null) return true;
    const stored = window.localStorage.getItem('remux.agent.transcriptDebug');
    return stored === '1' || stored === 'true';
  } catch {
    return false;
  }
}

export function logTranscriptDebug(
  label: string,
  payload: unknown,
  options: { warn?: boolean } = {},
) {
  if (!transcriptDebugEnabled()) return;
  let serialized: string;
  try {
    serialized = JSON.stringify(payload, debugReplacer) ?? String(payload);
  } catch (error) {
    serialized = JSON.stringify({ serializationError: messageOf(error) });
  }
  if (serialized.length > maxDebugPayloadLength) {
    serialized = JSON.stringify({
      preview: serialized.slice(0, maxDebugPayloadLength / 2),
      originalLength: serialized.length,
      truncated: true,
    });
  }
  const method = options.warn ? console.warn : console.info;
  method.call(console, `[agent transcript] ${label} ${serialized}`);
}

export function duplicateStrings(values: readonly string[]) {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) duplicates.add(value);
    seen.add(value);
  }
  return [...duplicates];
}

function debugReplacer(_key: string, value: unknown) {
  if (typeof value === 'string' && value.length > 500) {
    return `${value.slice(0, 500)}…<truncated>`;
  }
  if (typeof value === 'bigint') return `${value}n`;
  return value;
}

function messageOf(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
