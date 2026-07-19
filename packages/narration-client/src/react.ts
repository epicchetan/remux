import { useStore } from 'zustand';

import type { NarrationClient, NarrationClientState } from './controller';

export function useNarrationClientStore<TTarget, TSelection>(
  client: NarrationClient<TTarget>,
  selector: (state: NarrationClientState<TTarget>) => TSelection,
): TSelection {
  return useStore(client.store, selector);
}
