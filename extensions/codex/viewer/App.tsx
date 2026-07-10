import { useCallback, useEffect, useRef, useState, type CSSProperties, type PointerEvent } from 'react';

import type { CodexThreadRuntimeStatus } from '../shared/threads';
import { ComposerContent } from './composer/content';
import { composerResourcesFromSnapshot } from './composer/model/userInputInterop';
import { ComposerMentionPicker } from './composer/mentions/MentionPicker';
import { parseComposerMentionQuery } from './composer/mentions/mentionSearch';
import { useComposerStore } from './composer/store';
import { subscribeHostNavigate, updateHostTab } from '@remux/viewer-kit/host';
import { useHostStore } from './ipc/hostStore';
import { subscribeCodexResourceInvalidations } from './ipc/resourceInvalidations';
import type { RemuxHostViewportMetrics } from './ipc/types';
import { useThreadHistoryStore } from './threads/historyStore';
import { readThreadComposerPreference, useThreadComposerStateStore } from './threads/composerStateStore';
import { useThreadRuntimeStore } from './threads/runtimeStore';
import { useOperationQueueStore } from './threads/operationQueueStore';
import { useThreadsStore } from './threads/store';
import { useCodexResumeSync } from './resumeSync';
import { NewChatDirectoryPicker } from './threads/newChat/DirectoryPicker';
import { CodexSidebar } from './threads/Sidebar';
import { shortenPath, threadTitle } from './threads/threadFormat';
import { CodexTranscript } from './transcript';
import { requestTranscriptTurnScroll } from './transcript/viewportStore';

export function App() {
  const connectionStatus = useHostStore((state) => state.connectionStatus);
  const hostDefaultCwd = connectionStatus.type === 'connected' ? connectionStatus.cwd : null;
  const getHostViewportMetrics = useHostStore((state) => state.getHostViewportMetrics);
  const hostViewportMetrics = useHostStore((state) => state.hostViewportMetrics);
  const activeDraftId = useThreadsStore((state) => state.activeDraftId);
  const activeThreadId = useThreadsStore((state) => state.activeThreadId);
  const activeThreadSummary = useThreadHistoryStore((state) => (
    activeThreadId && state.threadsById[activeThreadId]
      ? state.threadsById[activeThreadId]
      : null
  ));
  const activeThreadTitle = activeThreadSummary ? threadTitle(activeThreadSummary) : null;
  const latestThread = useThreadHistoryStore((state) => {
    const threadId = state.threadOrder[0];
    return threadId ? state.threadsById[threadId] ?? null : null;
  });
  const latestThreadDefaultCwd = latestThread?.cwd ?? null;
  const latestThreadId = latestThread?.id ?? null;
  const newChatDefaultCwd = latestThreadDefaultCwd ?? hostDefaultCwd;
  const ensureThreadSummary = useThreadHistoryStore((state) => state.ensureThreadSummary);
  const activeThreadComposerPreference = useThreadComposerStateStore((state) => state.preference);
  const activeThreadRuntimeStatus = useThreadRuntimeStore((state) => state.status);
  const setRuntimeThreadId = useThreadRuntimeStore((state) => state.setActiveThreadId);
  const setOperationQueueThreadId = useOperationQueueStore((state) => state.setActiveThreadId);
  const setComposerStateThreadId = useThreadComposerStateStore((state) => state.setActiveThreadId);
  const directoryPickerOpen = useThreadsStore((state) => state.directoryPickerOpen);
  const activeDraftCwd = useThreadsStore((state) =>
    state.activeDraftId && state.draft?.id === state.activeDraftId ? state.draft.cwd : null);
  const activeDraftVisible = useThreadsStore((state) =>
    Boolean(state.activeDraftId && state.draft?.id === state.activeDraftId));
  const loadThreadHistory = useThreadHistoryStore((state) => state.loadThreadHistory);
  const applyServerComposerConfig = useComposerStore((state) => state.applyServerConfig);
  const loadComposerConfig = useComposerStore((state) => state.loadServerConfig);
  const saveActiveDraftSnapshot = useThreadsStore((state) => state.saveActiveDraftSnapshot);
  const setDefaultCwd = useThreadsStore((state) => state.setDefaultCwd);
  const composerPresentationRequest = useComposerStore((state) => state.composerPresentationRequest);
  const editTarget = useComposerStore((state) => state.editTarget);
  const focusComposer = useComposerStore((state) => state.focusComposer);
  const forkTarget = useComposerStore((state) => state.forkTarget);
  const mentionSession = useComposerStore((state) => state.mentionSession);
  const setComposerDocument = useComposerStore((state) => state.setComposerDocument);
  const snapshot = useComposerStore((state) => state.snapshot);
  const mainPaneRef = useRef<HTMLElement | null>(null);
  const bottomBarSlotRef = useRef<HTMLDivElement | null>(null);
  const draftRestorePendingRef = useRef<string | null>(null);
  const historyInitialLoadRequestedRef = useRef(false);
  const hostViewportMetricsRef = useRef<RemuxHostViewportMetrics | null>(hostViewportMetrics);
  const composerPresentationActive = Boolean(editTarget || forkTarget || mentionSession);
  const composerPresentationActiveRef = useRef(composerPresentationActive);
  const [composerDomFocused, setComposerDomFocused] = useState(false);
  const [composerLiftPx, setComposerLiftPx] = useState(0);
  const [mentionOverlayStyle, setMentionOverlayStyle] = useState<CSSProperties | null>(null);
  const mentionQuery = mentionSession ? parseComposerMentionQuery(mentionSession.query).normalizedQuery : '';
  const mentionPickerVisible = mentionQuery.length > 0;
  const directoryPickerVisible = Boolean(activeDraftVisible && directoryPickerOpen);
  const draftCwd = activeDraftCwd;
  const pickerOverlayVisible = mentionPickerVisible || directoryPickerVisible;
  const composerShouldLift = composerPresentationActive || directoryPickerVisible || composerDomFocused;
  const mainPaneStyle = {
    '--remux-composer-lift': `${composerLiftPx}px`,
  } as CSSProperties;

  useCodexResumeSync({
    activeThreadId,
    ensureThreadSummary,
    loadComposerConfig,
    loadThreadHistory,
  });

  const updateMentionOverlayGeometry = useCallback(() => {
    if (!pickerOverlayVisible) {
      setMentionOverlayStyle(null);
      return;
    }

    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        const mainPane = mainPaneRef.current;
        const bottomBar = bottomBarSlotRef.current;

        if (!mainPane || !bottomBar) {
          return;
        }

        const mainRect = mainPane.getBoundingClientRect();
        const bottomBarRect = bottomBar.getBoundingClientRect();

        void getHostViewportMetrics()
          .then((metrics) => {
            setMentionOverlayStyle(measureMentionOverlay(mainRect, bottomBarRect, metrics));
          })
          .catch(() => {
            setMentionOverlayStyle(measureMentionOverlay(mainRect, bottomBarRect, null));
          });
      });
    });
  }, [getHostViewportMetrics, pickerOverlayVisible]);

  const updateComposerLiftGeometry = useCallback(() => {
    window.requestAnimationFrame(() => {
      const mainPane = mainPaneRef.current;
      if (!mainPane || !composerPresentationActiveRef.current) {
        return;
      }

      const mainRect = mainPane.getBoundingClientRect();
      const metrics = hostViewportMetricsRef.current;

      if (metrics) {
        setComposerLiftPx(measureComposerLift(mainRect, metrics));
        return;
      }

      void getHostViewportMetrics()
        .then((metrics) => {
          if (composerPresentationActiveRef.current) {
            setComposerLiftPx(measureComposerLift(mainRect, metrics));
          }
        })
        .catch(() => {
          if (composerPresentationActiveRef.current) {
            setComposerLiftPx(measureVisualViewportComposerLift(mainRect));
          }
        });
    });
  }, [getHostViewportMetrics]);

  useEffect(() => {
    hostViewportMetricsRef.current = hostViewportMetrics;
    composerPresentationActiveRef.current = composerShouldLift;
    if (composerShouldLift) {
      updateComposerLiftGeometry();
    }
  }, [hostViewportMetrics, composerShouldLift, updateComposerLiftGeometry]);

  useEffect(() => {
    composerPresentationActiveRef.current = composerShouldLift;
  }, [composerShouldLift]);

  useEffect(() => {
    let raf = 0;

    const updateComposerFocusState = () => {
      setComposerDomFocused(activeElementInComposer());
    };
    const scheduleComposerFocusStateUpdate = () => {
      if (raf !== 0) {
        window.cancelAnimationFrame(raf);
      }
      raf = window.requestAnimationFrame(() => {
        raf = 0;
        updateComposerFocusState();
      });
    };

    document.addEventListener('focusin', updateComposerFocusState);
    document.addEventListener('focusout', scheduleComposerFocusStateUpdate);
    updateComposerFocusState();

    return () => {
      if (raf !== 0) {
        window.cancelAnimationFrame(raf);
      }
      document.removeEventListener('focusin', updateComposerFocusState);
      document.removeEventListener('focusout', scheduleComposerFocusStateUpdate);
    };
  }, []);

  useEffect(() => {
    if (!composerShouldLift) {
      setComposerLiftPx(0);
      return;
    }

    updateComposerLiftGeometry();

    const visualViewport = window.visualViewport;
    const resizeObserver = new ResizeObserver(updateComposerLiftGeometry);
    const mainPane = mainPaneRef.current;
    const bottomBar = bottomBarSlotRef.current;
    const timers = [50, 150, 300, 500].map((delay) => window.setTimeout(updateComposerLiftGeometry, delay));

    if (mainPane) {
      resizeObserver.observe(mainPane);
    }

    if (bottomBar) {
      resizeObserver.observe(bottomBar);
    }

    window.addEventListener('resize', updateComposerLiftGeometry);
    visualViewport?.addEventListener('resize', updateComposerLiftGeometry);
    visualViewport?.addEventListener('scroll', updateComposerLiftGeometry);

    return () => {
      timers.forEach((timer) => window.clearTimeout(timer));
      resizeObserver.disconnect();
      window.removeEventListener('resize', updateComposerLiftGeometry);
      visualViewport?.removeEventListener('resize', updateComposerLiftGeometry);
      visualViewport?.removeEventListener('scroll', updateComposerLiftGeometry);
    };
  }, [composerShouldLift, updateComposerLiftGeometry]);

  useEffect(() => {
    if (composerPresentationRequest.id === 0) {
      return;
    }

    let cancelled = false;
    const rafs: number[] = [];
    const timers: number[] = [];
    const scheduleRaf = (callback: FrameRequestCallback) => {
      const raf = window.requestAnimationFrame(callback);
      rafs.push(raf);
      return raf;
    };
    const focusAfterLayout = () => {
      scheduleRaf(() => {
        scheduleRaf(() => {
          if (!cancelled) {
            focusComposer();
          }
        });
      });
    };
    const presentComposer = () => {
      if (cancelled) {
        return;
      }

      updateComposerLiftGeometry();
      focusAfterLayout();
    };

    presentComposer();
    for (const delay of [50, 150, 300]) {
      timers.push(window.setTimeout(presentComposer, delay));
    }

    return () => {
      cancelled = true;
      rafs.forEach((raf) => window.cancelAnimationFrame(raf));
      timers.forEach((timer) => window.clearTimeout(timer));
    };
  }, [composerPresentationRequest.id, focusComposer, updateComposerLiftGeometry]);

  useEffect(() => {
    if (!pickerOverlayVisible) {
      setMentionOverlayStyle(null);
      return;
    }

    updateMentionOverlayGeometry();

    const visualViewport = window.visualViewport;
    const resizeObserver = new ResizeObserver(updateMentionOverlayGeometry);
    const mainPane = mainPaneRef.current;
    const bottomBar = bottomBarSlotRef.current;
    const timers = [50, 150, 300].map((delay) => window.setTimeout(updateMentionOverlayGeometry, delay));

    if (mainPane) {
      resizeObserver.observe(mainPane);
    }

    if (bottomBar) {
      resizeObserver.observe(bottomBar);
    }

    window.addEventListener('resize', updateMentionOverlayGeometry);
    visualViewport?.addEventListener('resize', updateMentionOverlayGeometry);
    visualViewport?.addEventListener('scroll', updateMentionOverlayGeometry);

    return () => {
      timers.forEach((timer) => window.clearTimeout(timer));
      resizeObserver.disconnect();
      window.removeEventListener('resize', updateMentionOverlayGeometry);
      visualViewport?.removeEventListener('resize', updateMentionOverlayGeometry);
      visualViewport?.removeEventListener('scroll', updateMentionOverlayGeometry);
    };
  }, [pickerOverlayVisible, updateMentionOverlayGeometry]);

  useEffect(() => {
    if (pickerOverlayVisible) {
      updateMentionOverlayGeometry();
    }
  }, [hostViewportMetrics, composerLiftPx, pickerOverlayVisible, updateMentionOverlayGeometry]);

  useEffect(() => {
    if (historyInitialLoadRequestedRef.current) {
      return;
    }

    historyInitialLoadRequestedRef.current = true;
    void loadThreadHistory();
  }, [loadThreadHistory]);

  useEffect(() => subscribeCodexResourceInvalidations(), []);

  useEffect(() => subscribeHostNavigate((navigation) => {
    if (navigation.resourceKind !== 'thread' || !navigation.resourceId) {
      return;
    }

    void useThreadsStore.getState().selectThread(navigation.resourceId);
    if (navigation.focusKind === 'turn' && navigation.focusId) {
      requestTranscriptTurnScroll(navigation.resourceId, navigation.focusId);
    }
  }), []);

  useEffect(() => {
    if (newChatDefaultCwd) {
      setDefaultCwd(newChatDefaultCwd);
    }
  }, [newChatDefaultCwd, setDefaultCwd]);

  useEffect(() => {
    void setRuntimeThreadId(activeThreadId);
    void setOperationQueueThreadId(activeThreadId);
    void setComposerStateThreadId(activeThreadId);
  }, [activeThreadId, setComposerStateThreadId, setOperationQueueThreadId, setRuntimeThreadId]);

  useEffect(() => {
    if (activeThreadComposerPreference) {
      applyServerComposerConfig(activeThreadComposerPreference);
      return;
    }

    if (!activeThreadId && !latestThreadId) {
      void loadComposerConfig();
    }
  }, [activeThreadComposerPreference, activeThreadId, applyServerComposerConfig, latestThreadId, loadComposerConfig]);

  useEffect(() => {
    if (activeThreadId || !latestThreadId) {
      return;
    }

    let disposed = false;
    void readThreadComposerPreference(latestThreadId)
      .then((preference) => {
        if (disposed) {
          return;
        }

        if (preference) {
          applyServerComposerConfig(preference);
          return;
        }

        void loadComposerConfig();
      })
      .catch(() => {
        if (!disposed) {
          void loadComposerConfig();
        }
      });

    return () => {
      disposed = true;
    };
  }, [activeThreadId, applyServerComposerConfig, latestThreadId, loadComposerConfig]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const resource = resourceFromLocationParams(params);
    if (!resource) {
      return;
    }

    attachCodexResource(resource);
    params.delete('remuxLaunch');
    const search = params.toString();
    window.history.replaceState(null, '', `${window.location.pathname}${search ? `?${search}` : ''}`);
  }, []);

  useEffect(() => {
    if (!activeDraftId || !activeDraftCwd) {
      return;
    }

    const draft = useThreadsStore.getState().draft;
    if (!draft || draft.id !== activeDraftId) {
      return;
    }

    draftRestorePendingRef.current = activeDraftId;
    setComposerDocument(draft.snapshot.document, composerResourcesFromSnapshot(draft.snapshot));
  }, [activeDraftCwd, activeDraftId, setComposerDocument]);

  useEffect(() => {
    if (!activeDraftId || !activeDraftCwd) {
      return;
    }

    if (draftRestorePendingRef.current === activeDraftId) {
      const draft = useThreadsStore.getState().draft;
      if (draft?.id === activeDraftId && !draftSnapshotMatches(snapshot, draft.snapshot)) {
        return;
      }

      draftRestorePendingRef.current = null;
    }

    saveActiveDraftSnapshot(snapshot);
  }, [activeDraftCwd, activeDraftId, saveActiveDraftSnapshot, snapshot]);

  useEffect(() => {
    if (!activeThreadId) {
      return;
    }

    void ensureThreadSummary(activeThreadId).catch(() => undefined);

    void syncCodexTabLocation({
      resourceId: activeThreadId,
      resourceKind: 'thread',
      status: codexRuntimeStatusLabel(activeThreadRuntimeStatus),
      title: activeThreadTitle ?? 'Codex',
    }).catch(() => undefined);
  }, [activeThreadId, activeThreadRuntimeStatus, activeThreadTitle, ensureThreadSummary]);

  useEffect(() => {
    if (!activeDraftId) {
      return;
    }

    void syncCodexTabLocation({
      resourceId: activeDraftId,
      resourceKind: 'draft',
      status: 'Draft',
      title: 'New chat',
    }).catch(() => undefined);
  }, [activeDraftId]);

  return (
    <main
      className="flex h-[100dvh] min-h-[100svh] w-full overflow-hidden bg-background text-foreground"
      onPointerDownCapture={blurComposerOnOutsideTap}
    >
      <CodexSidebar />
      <CodexSidebar.Mobile />

      <section className="remux-main-pane" ref={mainPaneRef} style={mainPaneStyle}>
        <div className="remux-transcript-slot">
          {activeDraftVisible ? <NewChatEmptyState cwd={activeDraftCwd} /> : <CodexTranscript threadId={activeThreadId} />}
        </div>
        <div className="remux-bottom-bar-slot" ref={bottomBarSlotRef}>
          <ComposerContent />
        </div>
        {pickerOverlayVisible ? (
          <div
            className="remux-file-mention-overlay"
            data-remux-no-composer-focus
            style={mentionOverlayStyle ?? undefined}
          >
            {mentionPickerVisible && mentionSession ? (
              <ComposerMentionPicker session={mentionSession} />
            ) : directoryPickerVisible ? (
              <NewChatDirectoryPicker />
            ) : null}
          </div>
        ) : null}
      </section>
    </main>
  );
}

function NewChatEmptyState({ cwd }: { cwd: string | null }) {
  return (
    <div className="remux-new-chat-empty">
      <div className="remux-new-chat-empty-card">
        <div className="remux-new-chat-empty-title">New chat</div>
        <div className="remux-new-chat-empty-path">
          {cwd ? shortenPath(cwd) : 'Pick a working directory to start'}
        </div>
      </div>
    </div>
  );
}

type CodexLaunchResource = {
  focusId: string | null;
  focusKind: string | null;
  launch: string | null;
  resourceId: string | null;
  resourceKind: string | null;
};

function resourceFromLocationParams(params: URLSearchParams): CodexLaunchResource | null {
  const resourceKind = params.get('remuxResourceKind');
  const resourceId = params.get('remuxResourceId');
  const launch = params.get('remuxLaunch');

  if (!resourceKind && launch !== 'new-chat') {
    return null;
  }

  return {
    focusId: params.get('remuxFocusId'),
    focusKind: params.get('remuxFocusKind'),
    launch,
    resourceId,
    resourceKind,
  };
}

function attachCodexResource(resource: CodexLaunchResource) {
  if (resource.resourceKind === 'thread' && resource.resourceId) {
    void useThreadsStore.getState().selectThread(resource.resourceId);
    if (resource.focusKind === 'turn' && resource.focusId) {
      requestTranscriptTurnScroll(resource.resourceId, resource.focusId);
    }
    return;
  }

  if (resource.resourceKind === 'draft' && resource.resourceId) {
    useThreadsStore.getState().startNewChat({ draftId: resource.resourceId });
    return;
  }

  if (resource.launch === 'new-chat') {
    useThreadsStore.getState().startNewChat({
      draftId: resource.resourceId,
    });
  }
}

type CodexTabLocation = {
  resourceId: string;
  resourceKind: string;
  status?: string | null;
  title: string | null;
};

async function syncCodexTabLocation(location: CodexTabLocation) {
  replaceCodexLocation(location);
  await updateHostTab({ ...location, launch: null });
}

function codexRuntimeStatusLabel(status: CodexThreadRuntimeStatus) {
  switch (status) {
    case 'failed':
      return 'Failed';
    case 'running':
      return 'Working';
    case 'stopping':
      return 'Stopping';
    case 'ready':
      return null;
  }
}

function replaceCodexLocation({ resourceId, resourceKind }: CodexTabLocation) {
  const url = new URL(window.location.href);
  url.searchParams.delete('remuxLaunch');
  url.searchParams.set('remuxResourceKind', resourceKind);
  url.searchParams.set('remuxResourceId', resourceId);

  window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
}

type DraftSnapshotComparable = {
  contentKey: string;
  error: string | null;
  isReadingImages: boolean;
};

function draftSnapshotMatches(left: DraftSnapshotComparable, right: DraftSnapshotComparable) {
  return left.contentKey === right.contentKey &&
    left.error === right.error &&
    left.isReadingImages === right.isReadingImages;
}

function hostKeyboardActive(hostMetrics: RemuxHostViewportMetrics | null) {
  return Boolean(
    hostMetrics &&
      (hostMetrics.keyboardVisible ||
        hostMetrics.keyboardHeight > 0 ||
        hostMetrics.visibleBottom < hostMetrics.viewportHeight),
  );
}

function measureComposerLift(mainRect: DOMRect, hostMetrics: RemuxHostViewportMetrics | null) {
  if (!hostKeyboardActive(hostMetrics) || !hostMetrics || hostMetrics.viewportHeight <= 0) {
    return measureVisualViewportComposerLift(mainRect);
  }

  const visibleBottom = Math.max(0, Math.min(hostMetrics.viewportHeight, hostMetrics.visibleBottom));
  if (visibleBottom <= 0) {
    return measureVisualViewportComposerLift(mainRect);
  }

  return Math.max(0, Math.ceil(mainRect.bottom - visibleBottom));
}

function measureVisualViewportComposerLift(mainRect: DOMRect) {
  const visualViewport = window.visualViewport;
  if (!visualViewport) {
    return 0;
  }

  const visibleBottom = visualViewport.offsetTop + visualViewport.height;
  return Math.max(0, Math.ceil(mainRect.bottom - visibleBottom));
}

function measureMentionOverlay(
  mainRect: DOMRect,
  bottomBarRect: DOMRect,
  hostMetrics: RemuxHostViewportMetrics | null,
): CSSProperties {
  const bottomBarHeight = bottomBarRect.height;
  const top = Math.max(0, -mainRect.top);
  const fallbackBottom = Math.max(top, bottomBarRect.top - mainRect.top);
  const maxBottom = Math.max(top, mainRect.height - bottomBarHeight);
  const hasHostMetrics = hostMetrics !== null && hostMetrics.viewportHeight > 0;
  const keyboardActive = hostKeyboardActive(hostMetrics);
  const hostBottom = hasHostMetrics
    ? hostMetrics.visibleBottom - bottomBarHeight - mainRect.top
    : fallbackBottom;
  const bottom = Math.max(top, Math.min(keyboardActive ? hostBottom : fallbackBottom, maxBottom));
  const height = Math.max(0, bottom - top);

  return {
    height,
    top,
  };
}

function activeElementInComposer() {
  const activeElement = document.activeElement;
  return activeElement instanceof Element && Boolean(activeElement.closest('[data-remux-composer-root]'));
}

function blurComposerOnOutsideTap(event: PointerEvent<HTMLElement>) {
  if (event.defaultPrevented || event.button !== 0) {
    return;
  }

  const target = event.target;
  if (
    !(target instanceof Element) ||
    target.closest('.remux-bottom-bar, .remux-file-mention-picker, [data-remux-no-composer-focus]')
  ) {
    return;
  }

  const activeElement = document.activeElement;
  if (isEditableElement(activeElement)) {
    activeElement.blur();
  }
}

function isEditableElement(element: Element | null): element is HTMLElement {
  return (
    element instanceof HTMLTextAreaElement ||
    element instanceof HTMLInputElement ||
    (element instanceof HTMLElement && element.isContentEditable)
  );
}
