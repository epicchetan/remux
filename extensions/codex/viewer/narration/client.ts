import {
  createBrowserNarrationAudio,
  createNarrationClient,
  type NarrationClientState,
  type NarrationFocusReason,
} from '@remux/narration-client';
import { useNarrationClientStore } from '@remux/narration-client/react';
import {
  createRemuxNarrationLifecycle,
  createRemuxNarrationTransport,
} from '@remux/narration-client/remux';
import type { StoreApi } from 'zustand/vanilla';

import {
  getTranscriptViewportState,
  subscribeTranscriptViewport,
} from '../transcript/viewportStore';

export type CodexNarrationTarget = {
  assistantMessageId: string;
  messageRevision: string;
  sourceHash: string;
  threadId: string;
  turnId: string;
};

export type { NarrationFocusReason };

export const narrationClient = createNarrationClient<CodexNarrationTarget>({
  audio: createBrowserNarrationAudio(),
  follow: {
    claim: () => {
      getTranscriptViewportState().setAutoScrollMode({ type: 'narration-follow' });
    },
    release: () => {
      const viewport = getTranscriptViewportState();
      if (viewport.autoScrollMode.type === 'narration-follow') {
        viewport.setAutoScrollMode({ type: 'off' });
      }
    },
  },
  lifecycle: createRemuxNarrationLifecycle(),
  transport: createRemuxNarrationTransport(),
});

type CodexNarrationState = NarrationClientState<CodexNarrationTarget>;
type CodexNarrationStore = StoreApi<CodexNarrationState> & {
  <TSelection>(selector: (state: CodexNarrationState) => TSelection): TSelection;
};

export const useNarrationStore = Object.assign(
  <TSelection>(selector: (state: CodexNarrationState) => TSelection) => (
    useNarrationClientStore(narrationClient, selector)
  ),
  narrationClient.store,
) as CodexNarrationStore;

export function attachNarrationClient() {
  const detachClient = narrationClient.attach();
  const unsubscribeViewport = subscribeTranscriptViewport(() => {
    const state = narrationClient.store.getState();
    if (!['buffering', 'paused', 'playing', 'ready'].includes(state.phase)) return;
    if (!state.followEnabled) return;
    if (getTranscriptViewportState().autoScrollMode.type === 'narration-follow') return;
    state.suspendFollowByUser();
  });
  return () => {
    unsubscribeViewport();
    detachClient();
  };
}

export function getNarrationDebugSnapshot() {
  return {
    ...narrationClient.debugSnapshot(),
    visibilityState: document.visibilityState,
  };
}

(globalThis as typeof globalThis & {
  __remuxNarrationDebugSnapshot?: typeof getNarrationDebugSnapshot;
}).__remuxNarrationDebugSnapshot = getNarrationDebugSnapshot;

export function narrationSourceHash(text: string) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}
