export type CodexViewHostStatus =
  | { type: 'idle' }
  | { type: 'connecting' }
  | { type: 'connected' }
  | { type: 'reconnecting'; attempt: number }
  | { type: 'closed'; reason?: string }
  | { type: 'error'; message: string };

export type RemuxHostViewportMetrics = {
  keyboardHeight: number;
  keyboardVisible: boolean;
  visibleBottom: number;
  visibleTop: number;
  viewportHeight: number;
  viewportWidth: number;
};
