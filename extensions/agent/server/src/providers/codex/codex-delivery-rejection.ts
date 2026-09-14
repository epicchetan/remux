// Recognize only this explicit failure to submit input. Other internal errors
// can occur after acceptance and must retain the unknown-delivery fence.
export const CODEX_ACTIVE_COMPACT_REJECTION =
  'Codex App Server turn/start failed (-32603): failed to submit turn input: ActiveTurnNotSteerable { turn_kind: Compact }';

export function isCodexActiveCompactRejection(message: unknown): message is string {
  return message === CODEX_ACTIVE_COMPACT_REJECTION;
}
