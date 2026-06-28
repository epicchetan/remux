import { useEffect, useRef, useState } from 'react';

export type ExternalStoreApi<State> = {
  getState: () => State;
  setState: (patch: Partial<State>) => void;
  subscribe: (listener: () => void) => () => void;
  useStore: <Selected>(
    selector: (state: State) => Selected,
    isEqual?: (left: Selected, right: Selected) => boolean,
  ) => Selected;
};

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
      listener();
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
    const [, setRevision] = useState(0);

    selectorRef.current = selector;
    isEqualRef.current = isEqual;

    const selected = selector(state);
    if (selectedRef.current === null || !isEqualRef.current(selectedRef.current.value, selected)) {
      selectedRef.current = { value: selected };
    }

    useEffect(() => {
      return subscribe(() => {
        const next = selectorRef.current(state);
        if (selectedRef.current !== null && isEqualRef.current(selectedRef.current.value, next)) {
          return;
        }

        selectedRef.current = { value: next };
        setRevision((revision) => revision + 1);
      });
    }, []);

    return selectedRef.current.value;
  };

  return {
    getState,
    setState,
    subscribe,
    useStore,
  };
}
