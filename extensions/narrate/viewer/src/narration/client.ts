import {
  createBrowserNarrationAudio,
  createNarrationClient,
  type NarrationClientState,
} from '@remux/narration-client';
import { useNarrationClientStore } from '@remux/narration-client/react';
import {
  createRemuxNarrationLifecycle,
  createRemuxNarrationTransport,
} from '@remux/narration-client/remux';
import type { StoreApi } from 'zustand/vanilla';

import { getNarrationDomSnapshot } from './domIndex';
import { getNarrationPaintSnapshot } from './paintSnapshot';

export type MarkdownNarrationTarget = {
  filePath: string;
  modifiedAtMs: number | null;
  sourceHash: string;
};

export const narrationClient = createNarrationClient<MarkdownNarrationTarget>({
  audio: createBrowserNarrationAudio(),
  lifecycle: createRemuxNarrationLifecycle(),
  transport: createRemuxNarrationTransport(),
});

type MarkdownNarrationState = NarrationClientState<MarkdownNarrationTarget>;
type MarkdownNarrationStore = StoreApi<MarkdownNarrationState> & {
  <TSelection>(selector: (state: MarkdownNarrationState) => TSelection): TSelection;
};

export const useNarrationStore = Object.assign(
  <TSelection>(selector: (state: MarkdownNarrationState) => TSelection) => (
    useNarrationClientStore(narrationClient, selector)
  ),
  narrationClient.store,
) as MarkdownNarrationStore;

export function attachNarrationClient() {
  return narrationClient.attach();
}

export function getNarrationDebugSnapshot() {
  const dom = getNarrationDomSnapshot();
  const state = narrationClient.store.getState();
  const target = state.target;
  const client = narrationClient.debugSnapshot();
  return {
    client: {
      ...client,
      store: {
        ...client.store,
        followEnabled: state.followEnabled,
        followSuspendedByUser: state.followSuspendedByUser,
        playbackRate: state.playbackRate,
      },
    },
    dom: {
      blockCount: dom.blocks.size,
      error: dom.error,
      sourceHash: dom.sourceHash,
      status: dom.status,
    },
    paint: getNarrationPaintSnapshot(),
    target,
    visibilityState: document.visibilityState,
  };
}

(globalThis as typeof globalThis & {
  __remuxNarrationDebugSnapshot?: typeof getNarrationDebugSnapshot;
}).__remuxNarrationDebugSnapshot = getNarrationDebugSnapshot;
