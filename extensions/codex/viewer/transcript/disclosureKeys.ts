export function transcriptUserMessageDisclosureKey(turnId: string, segmentId: string) {
  return `${turnId}:${segmentId}`;
}

export function transcriptWorkDisclosureKey(turnId: string, segmentId: string) {
  return `${turnId}:${segmentId}`;
}
