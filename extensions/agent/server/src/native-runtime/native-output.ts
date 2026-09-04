import type { ProviderEventEnvelope } from '../../../shared/provider-runtime.ts';

export const NATIVE_ASSISTANT_PREVIEW_BYTES = 48 * 1024;

export function terminalAssistantText(
  events: readonly ProviderEventEnvelope[],
  turnId: string,
) {
  const blocks = new Map<string, { ordinal: number; text: string }>();
  for (const envelope of events) {
    if (envelope.scope.kind !== 'turn' || envelope.scope.turnId !== turnId) continue;
    const event = envelope.event;
    if (event.type !== 'turn.block.started' &&
        event.type !== 'turn.block.revised' &&
        event.type !== 'turn.block.completed') continue;
    if (event.block.payload.kind !== 'final-message') continue;
    blocks.set(event.structure.blockId, {
      ordinal: event.structure.passOrdinal * 1_000_000 + event.structure.blockOrdinal,
      text: event.block.payload.text,
    });
  }
  return [...blocks.values()].sort((left, right) => right.ordinal - left.ordinal)[0]?.text ?? '';
}

export function boundedUtf8Preview(text: string, maxBytes = NATIVE_ASSISTANT_PREVIEW_BYTES) {
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.byteLength <= maxBytes) return { text, returnedBytes: bytes.byteLength };
  let end = maxBytes;
  while (end > 0 && end < bytes.byteLength && (bytes[end]! & 0xc0) === 0x80) end -= 1;
  const preview = bytes.subarray(0, end).toString('utf8');
  return { text: preview, returnedBytes: end };
}
