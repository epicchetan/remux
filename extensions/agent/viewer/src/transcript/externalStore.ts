import { useCallback, useRef, useSyncExternalStore } from 'react';

export type ExternalStoreApi<State> = {
  getState: () => State;
  setState: (patch: Partial<State>) => void;
  subscribe: (listener: () => void) => () => void;
  useStore: <Selected>(
    selector: (state: State) => Selected,
    isEqual?: (left: Selected, right: Selected) => boolean,
  ) => Selected;
};

let externalStoreBatchDepth = 0;
const pendingExternalStoreListeners = new Set<() => void>();

export function batchExternalStoreUpdates<T>(update: () => T): T {
  externalStoreBatchDepth += 1;
  try {
    return update();
  } finally {
    externalStoreBatchDepth -= 1;
    if (externalStoreBatchDepth === 0) {
      const listeners = Array.from(pendingExternalStoreListeners);
      pendingExternalStoreListeners.clear();
      for (const listener of listeners) {
        listener();
      }
    }
  }
}

export function createExternalStore<State>(initialState: State): ExternalStoreApi<State> {
  let state = initialState;
  const listeners = new Set<() => void>();

  const getState = () => state;

  const setState = (patch: Partial<State>) => {
    state = {
      ...state,
      ...patch,
    };

    for (const listener of listeners) {
      if (externalStoreBatchDepth > 0) {
        pendingExternalStoreListeners.add(listener);
      } else {
        listener();
      }
    }
  };

  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };

  const useStore = <Selected,>(
    selector: (state: State) => Selected,
    isEqual: (left: Selected, right: Selected) => boolean = Object.is,
  ) => {
    const selectorRef = useRef(selector);
    const isEqualRef = useRef(isEqual);
    const selectedRef = useRef<{ value: Selected } | null>(null);

    selectorRef.current = selector;
    isEqualRef.current = isEqual;

    const getSelectedSnapshot = useCallback(() => {
      const selected = selectorRef.current(state);
      if (
        selectedRef.current !== null &&
        isEqualRef.current(selectedRef.current.value, selected)
      ) {
        return selectedRef.current.value;
      }
      selectedRef.current = { value: selected };
      return selected;
    }, []);

    return useSyncExternalStore(subscribe, getSelectedSnapshot, getSelectedSnapshot);
  };

  return {
    getState,
    setState,
    subscribe,
    useStore,
  };
}
