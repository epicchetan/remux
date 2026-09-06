export type TranscriptViewportIntent =
  | { kind: 'bottom-follow' }
  | {
      conversationId: string;
      kind: 'message-anchor';
      phase: 'anchored' | 'catching-up';
      reason: 'navigation' | 'restore' | 'route-focus' | 'send';
      segmentId: string;
      turnId: string;
    }
  | { kind: 'free' };

export type TranscriptScrollAnchor = {
  contentBottom: number;
  contentTop: number;
  segmentId: string;
  scrollTop: number;
  turnId: string;
};

export type TranscriptViewportAnchor = {
  offset: number;
  rowId: string;
  segmentId: string;
  turnId: string;
};

export type TranscriptScrollAnchorSelection = {
  anchors: TranscriptScrollAnchor[];
  atBottom: boolean;
  currentSegmentId?: string | null;
  scrollTop: number;
  threshold?: number;
};

export type TranscriptDownNavigationDestination =
  | { anchor: TranscriptScrollAnchor; kind: 'message'; scrollTop: number }
  | { kind: 'bottom'; scrollTop: number };

export type MessageAnchorScrollResolution = {
  phase: 'anchored' | 'catching-up';
  runwayHeight: number;
  scrollTop: number;
};


export type TranscriptInitialScrollTarget = {
  intent: TranscriptViewportIntent;
  scrollTop: number;
};

export type TranscriptScrollOwner =
  | 'idle'
  | 'initial-placement'
  | 'programmatic-navigation'
  | 'native-touch'
  | 'native-momentum';

export type TranscriptNativeScrollEvent = 'settle' | 'touch-end' | 'touch-start';

export function sameTranscriptViewportIntent(
  left: TranscriptViewportIntent,
  right: TranscriptViewportIntent,
) {
  return left.kind === right.kind && (
    left.kind !== 'message-anchor' ||
    (
      right.kind === 'message-anchor' &&
      left.phase === right.phase &&
      left.reason === right.reason &&
      left.segmentId === right.segmentId &&
      left.conversationId === right.conversationId &&
      left.turnId === right.turnId
    )
  );
}

export function nativeScrollOwnsViewport(owner: TranscriptScrollOwner) {
  return owner === 'native-touch' || owner === 'native-momentum';
}

export function transcriptScrollOwnerAfterNativeEvent(
  owner: TranscriptScrollOwner,
  event: TranscriptNativeScrollEvent,
): TranscriptScrollOwner {
  if (event === 'touch-start') return 'native-touch';
  if (event === 'touch-end') return 'native-momentum';
  return owner === 'native-touch' ? owner : 'idle';
}
