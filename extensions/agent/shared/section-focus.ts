export type AgentSectionFocus = { turnId: string; segmentId: string };

export function encodeAgentSectionFocus(focus: AgentSectionFocus): string {
  return JSON.stringify([focus.turnId, focus.segmentId]);
}

export function decodeAgentSectionFocus(value: string | null): AgentSectionFocus | null {
  if (!value) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed) || parsed.length !== 2 ||
        !parsed.every(part => typeof part === 'string' && part.trim().length > 0)) return null;
    return { turnId: parsed[0], segmentId: parsed[1] };
  } catch { return null; }
}
