import {
  dismissHostKeyboard,
  getHostViewportMetrics,
  openHostOverview,
  readHostClipboardText,
  reloadHostView,
  subscribeHostActive,
  subscribeHostConnection,
  type RemuxHostViewportMetrics,
  type RemuxHostConnectionStatus,
  subscribeHostViewportMetrics,
  updateHostTab,
} from '@remux/viewer-kit/host';
import type { RemuxViewerRoute } from '@remux/viewer-kit/route';
import {
  ActionBar,
  ActionButton,
  ActionMenu,
  ActionMenuItem,
} from '@remux/viewer-kit/ui';
import { FitAddon } from '@xterm/addon-fit';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { WebglAddon } from '@xterm/addon-webgl';
import { Terminal } from '@xterm/xterm';
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Check,
  Copy,
  Eraser,
  ClipboardPaste,
  CornerDownLeft,
  Keyboard,
  KeyboardOff,
  LogOut,
  Menu,
  MoreHorizontal,
  NotebookTabs,
  PanelRightOpen,
  Plus,
  RefreshCw,
  TextSelect,
  X,
} from 'lucide-react';
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type TouchEvent as ReactTouchEvent,
} from 'react';

import {
  attachTerminalSession,
  bytesFromBase64,
  getTerminalTmuxContext,
  killTerminalSession,
  readRemuxSystemInfo,
  resizeTerminalSession,
  runTerminalTmuxAction,
  startTerminalSession,
  subscribeTerminalEvents,
  writeTerminalSessionInput,
  type TerminalTmuxAction,
  type TerminalTmuxActionTarget,
  type TerminalTmuxContext,
  type TerminalTmuxSession,
  type TerminalTmuxSocketState,
  type TerminalTmuxWindow,
  type TerminalSessionOutputFrame,
} from './terminalRpc';
import {
  encodeModifiedKey,
  encodeTerminalArrow,
  encodeTerminalEnter,
  encodeTerminalTab,
  isModifierKey,
  terminalControlCBytes,
  terminalKeySequences,
  terminalModifierAutoClearMs,
  type TerminalArrowCode,
} from './keyEncoding';
import { setupTouchScroll } from './touchScroll';

const fontFamily = 'Menlo, Consolas, "Liberation Mono", monospace';
const terminalThemeDark = {
  background: '#09090b',
  black: '#18181b',
  blue: '#60a5fa',
  brightBlack: '#71717a',
  brightBlue: '#93c5fd',
  brightCyan: '#67e8f9',
  brightGreen: '#86efac',
  brightMagenta: '#f0abfc',
  brightRed: '#fca5a5',
  brightWhite: '#fafafa',
  brightYellow: '#fde68a',
  cursor: '#f97316',
  cyan: '#22d3ee',
  foreground: '#e4e4e7',
  green: '#4ade80',
  magenta: '#e879f9',
  red: '#f87171',
  selectionBackground: '#3f3f46',
  white: '#e4e4e7',
  yellow: '#facc15',
} as const;
const textEncoder = new TextEncoder();
const fitDebounceMs = 180;
const commandTitleDelayMs = 500;
const terminalTapEchoMs = 90;
const terminalDoubleTapMs = 300;
const tmuxPollMs = 2_500;
const tmuxScrollHoldDelayMs = 260;
const tmuxScrollMaxQueuedTaps = 6;
const tmuxScrollRepeatLines = 3;
const tmuxScrollRepeatMs = 140;
const tmuxScrollTapLines = 5;

type TerminalSurfaceProps = {
  route: RemuxViewerRoute;
};

type TerminalStatus =
  | { type: 'connecting' }
  | { cwd: string; shell: string; type: 'running' }
  | { code: number | null; signal: string | null; type: 'exited' }
  | { message: string; type: 'error' };

type TerminalShellState = {
  command: string | null;
  commandStartedAt: number | null;
  commandTitleReady: boolean;
  cwd: string | null;
  running: boolean;
  title: string | null;
};

type TerminalSelectionPoint = {
  column: number;
  row: number;
};

type TerminalSelectionDrag = {
  anchor: TerminalSelectionPoint;
  pointerId: number;
};

const emptyShellState: TerminalShellState = {
  command: null,
  commandStartedAt: null,
  commandTitleReady: false,
  cwd: null,
  running: false,
  title: null,
};

export function TerminalSurface({ route }: TerminalSurfaceProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const lastResizeRef = useRef<{ cols: number; rows: number } | null>(null);
  const lastSeqRef = useRef(0);
  const sessionIdRef = useRef<string | null>(null);
  const connectedEventSeenRef = useRef(false);
  const connectionRef = useRef<RemuxHostConnectionStatus>('connecting');
  const hostActiveRef = useRef(true);
  const terminalRef = useRef<Terminal | null>(null);
  const fitTimerRef = useRef<number | null>(null);
  const hostViewportMetricsRef = useRef<RemuxHostViewportMetrics | null>(null);
  const initialAttachCompletedRef = useRef(false);
  const resyncInFlightRef = useRef(false);
  const modifierTimerRef = useRef<number | null>(null);
  const commandTitleTimerRef = useRef<number | null>(null);
  const suppressedTerminalDataWritesRef = useRef(0);
  const keyboardOpenRef = useRef(false);
  const lastTerminalTapMsRef = useRef(Number.NEGATIVE_INFINITY);
  const selectionDragRef = useRef<TerminalSelectionDrag | null>(null);
  const selectionModeRef = useRef(false);
  const tmuxAttachedRef = useRef(false);
  const [altActive, setAltActive] = useState(false);
  const [ctrlActive, setCtrlActive] = useState(false);
  const [connected, setConnected] = useState(true);
  const [hostActive, setHostActive] = useState(true);
  const [shiftActive, setShiftActive] = useState(false);
  const [keyboardOffset, setKeyboardOffset] = useState(0);
  const [keyboardOpen, setKeyboardOpen] = useState(false);
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectionText, setSelectionText] = useState('');
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [shellState, setShellState] = useState<TerminalShellState>(emptyShellState);
  const [status, setStatus] = useState<TerminalStatus>({ type: 'connecting' });
  const [replayGap, setReplayGap] = useState(false);
  const [tmuxContext, setTmuxContext] = useState<TerminalTmuxContext | null>(null);

  const resetModifiers = useCallback(() => {
    setCtrlActive(false);
    setAltActive(false);
    setShiftActive(false);
  }, []);

  const clearModifierTimer = useCallback(() => {
    if (modifierTimerRef.current !== null) {
      window.clearTimeout(modifierTimerRef.current);
      modifierTimerRef.current = null;
    }
  }, []);

  useEffect(() => {
    clearModifierTimer();
    if (!ctrlActive && !altActive && !shiftActive) {
      return undefined;
    }

    modifierTimerRef.current = window.setTimeout(() => {
      modifierTimerRef.current = null;
      resetModifiers();
    }, terminalModifierAutoClearMs);

    return clearModifierTimer;
  }, [altActive, clearModifierTimer, ctrlActive, resetModifiers, shiftActive]);

  useEffect(() => {
    keyboardOpenRef.current = keyboardOpen;
  }, [keyboardOpen]);

  useEffect(() => {
    selectionModeRef.current = selectionMode;
  }, [selectionMode]);

  const currentSize = useCallback(() => {
    const terminal = terminalRef.current;
    if (!terminal) {
      return { cols: 80, rows: 24 };
    }

    return {
      cols: clampSize(terminal.cols, 2, 500),
      rows: clampSize(terminal.rows, 2, 200),
    };
  }, []);

  const sendResize = useCallback((cols: number, rows: number) => {
    const normalized = {
      cols: clampSize(cols, 2, 500),
      rows: clampSize(rows, 2, 200),
    };
    const lastResize = lastResizeRef.current;
    if (lastResize && lastResize.cols === normalized.cols && lastResize.rows === normalized.rows) {
      return;
    }

    lastResizeRef.current = normalized;
    const currentSessionId = sessionIdRef.current;
    if (!currentSessionId) {
      return;
    }

    void resizeTerminalSession({
      cols: normalized.cols,
      rows: normalized.rows,
      sessionId: currentSessionId,
    }).catch(() => undefined);
  }, []);

  const fitTerminal = useCallback(() => {
    const container = containerRef.current;
    const fitAddon = fitAddonRef.current;
    const terminal = terminalRef.current;
    if (!container || !fitAddon || !terminal || container.clientWidth <= 0 || container.clientHeight <= 0) {
      return currentSize();
    }

    try {
      terminal.scrollToBottom();
      fitAddon.fit();
    } catch {
      return currentSize();
    }

    const size = currentSize();
    sendResize(size.cols, size.rows);
    return size;
  }, [currentSize, sendResize]);

  const scheduleFit = useCallback((delayMs = fitDebounceMs) => {
    if (fitTimerRef.current !== null) {
      window.clearTimeout(fitTimerRef.current);
    }

    fitTimerRef.current = window.setTimeout(() => {
      fitTimerRef.current = null;
      fitTerminal();
    }, delayMs);
  }, [fitTerminal]);

  const updateKeyboardOffset = useCallback((metrics?: RemuxHostViewportMetrics) => {
    if (metrics) {
      hostViewportMetricsRef.current = metrics;
    }

    const nextOffset = normalizedKeyboardOffset(hostViewportMetricsRef.current);
    setKeyboardOffset((currentOffset) => (
      Math.abs(currentOffset - nextOffset) < 2 ? currentOffset : nextOffset
    ));
    scheduleFit(220);
  }, [scheduleFit]);

  const writeTerminalOutput = useCallback((data: Uint8Array, options: { suppressTerminalData?: boolean } = {}) => {
    const terminal = terminalRef.current;
    if (!terminal) {
      return;
    }

    if (!options.suppressTerminalData) {
      terminal.write(data);
      return;
    }

    suppressedTerminalDataWritesRef.current += 1;
    terminal.write(data, () => {
      suppressedTerminalDataWritesRef.current = Math.max(0, suppressedTerminalDataWritesRef.current - 1);
    });
  }, []);

  const writeFrame = useCallback((
    frame: TerminalSessionOutputFrame,
    options: { suppressTerminalData?: boolean } = {},
  ) => {
    if (frame.seq <= lastSeqRef.current) {
      return;
    }

    lastSeqRef.current = frame.seq;
    writeTerminalOutput(bytesFromBase64(frame.dataBase64), options);
  }, [writeTerminalOutput]);

  const writeReplay = useCallback((frames: TerminalSessionOutputFrame[]) => {
    for (const frame of frames) {
      writeFrame(frame, { suppressTerminalData: true });
    }
  }, [writeFrame]);

  const bindSession = useCallback((nextSessionId: string) => {
    sessionIdRef.current = nextSessionId;
    setSessionId(nextSessionId);
  }, []);

  const sendBytes = useCallback((data: Uint8Array, options: { clearModifiers?: boolean } = {}) => {
    const currentSessionId = sessionIdRef.current;
    if (!currentSessionId || data.length === 0) {
      return;
    }

    writeTerminalSessionInput(currentSessionId, data);

    if (options.clearModifiers) {
      resetModifiers();
    }
  }, [resetModifiers]);

  const sendText = useCallback((value: string, options: { clearModifiers?: boolean } = {}) => {
    sendBytes(textEncoder.encode(value), options);
  }, [sendBytes]);

  const resetShellState = useCallback(() => {
    setShellState(emptyShellState);
  }, []);

  const handleShellIntegrationSequence = useCallback((data: string) => {
    const nextState = shellStateFromOsc633(data);
    if (!nextState) {
      return false;
    }

    setShellState((current) => nextState(current));
    return true;
  }, []);

  const handleCurrentDirectory = useCallback((cwd: string | null) => {
    const normalized = normalizeTerminalMetadataValue(cwd);
    if (!normalized) {
      return false;
    }

    setShellState((current) => ({ ...current, cwd: normalized }));
    return true;
  }, []);

  const handleTerminalTitle = useCallback((title: string) => {
    setShellState((current) => ({
      ...current,
      title: normalizeTerminalMetadataValue(title),
    }));
  }, []);

  const startOrAttachSession = useCallback(async (options: { forceStart?: boolean } = {}) => {
    const terminal = terminalRef.current;
    if (!terminal) {
      return;
    }

    initialAttachCompletedRef.current = false;
    setReplayGap(false);
    resetShellState();
    setStatus({ type: 'connecting' });
    const size = fitTerminal();
    const preferredSessionId = preferredTerminalSessionId(route);
    const attachSessionId = preferredSessionId && !options.forceStart ? preferredSessionId : null;

    if (attachSessionId) {
      try {
        const attached = await attachTerminalSession({
          cols: size.cols,
          replaySeq: lastSeqRef.current > 0 ? lastSeqRef.current + 1 : null,
          rows: size.rows,
          sessionId: attachSessionId,
        });

        bindSession(attached.sessionId);
        writeReplay(attached.replay);
        initialAttachCompletedRef.current = true;
        await updateHostTab({
          resourceId: attached.sessionId,
          resourceKind: 'terminalSession',
        });

        if (attached.status === 'exited') {
          setStatus({
            code: attached.exitCode ?? null,
            signal: attached.exitSignal ?? null,
            type: 'exited',
          });
        } else {
          setStatus({ cwd: '', shell: '', type: 'running' });
          sendResize(size.cols, size.rows);
        }
        return;
      } catch {
        lastSeqRef.current = 0;
        terminal.clear();
      }
    }

    const systemInfo = await readRemuxSystemInfo();
    const started = await startTerminalSession({
      cols: size.cols,
      cwd: systemInfo.cwd,
      rows: size.rows,
      sessionId: preferredSessionId,
    });

    bindSession(started.sessionId);
    initialAttachCompletedRef.current = true;
    await updateHostTab({
      resourceId: started.sessionId,
      resourceKind: 'terminalSession',
    });
    setStatus({
      cwd: started.cwd,
      shell: started.shell,
      type: 'running',
    });
    sendResize(started.cols, started.rows);
  }, [bindSession, fitTerminal, resetShellState, route, sendResize, writeReplay]);

  const resyncSession = useCallback(async () => {
    const currentSessionId = sessionIdRef.current;
    if (!currentSessionId || resyncInFlightRef.current) {
      return;
    }

    resyncInFlightRef.current = true;
    try {
      const size = currentSize();
      const attached = await attachTerminalSession({
        cols: size.cols,
        replaySeq: lastSeqRef.current > 0 ? lastSeqRef.current + 1 : null,
        rows: size.rows,
        sessionId: currentSessionId,
      });

      if (attached.replayTruncated) {
        terminalRef.current?.clear();
        lastSeqRef.current = 0;
        setReplayGap(true);
        return;
      }

      setReplayGap(false);
      writeReplay(attached.replay);
      if (attached.status === 'exited') {
        setStatus({
          code: attached.exitCode ?? null,
          signal: attached.exitSignal ?? null,
          type: 'exited',
        });
      }
    } catch {
      // A server restart can make the previously bound session disappear.
    } finally {
      resyncInFlightRef.current = false;
    }
  }, [currentSize, writeReplay]);

  const restartSession = useCallback(() => {
    const currentSessionId = sessionIdRef.current;
    terminalRef.current?.clear();
    lastSeqRef.current = 0;
    setReplayGap(false);
    if (currentSessionId) {
      void killTerminalSession(currentSessionId)
        .catch(() => undefined)
        .finally(() => {
          void startOrAttachSession({ forceStart: true }).catch((error) => {
            setStatus({ message: errorMessage(error), type: 'error' });
          });
        });
      return;
    }

    void startOrAttachSession({ forceStart: true }).catch((error) => {
      setStatus({ message: errorMessage(error), type: 'error' });
    });
  }, [startOrAttachSession]);

  const sendArrow = useCallback((code: TerminalArrowCode) => {
    sendBytes(encodeTerminalArrow(code, {
      alt: altActive,
      ctrl: ctrlActive,
      shift: shiftActive,
    }), { clearModifiers: altActive || ctrlActive || shiftActive });
  }, [altActive, ctrlActive, sendBytes, shiftActive]);

  const sendTab = useCallback(() => {
    sendBytes(encodeTerminalTab({
      alt: altActive,
      ctrl: ctrlActive,
      shift: shiftActive,
    }), { clearModifiers: altActive || ctrlActive || shiftActive });
  }, [altActive, ctrlActive, sendBytes, shiftActive]);

  const sendEnter = useCallback(() => {
    sendBytes(encodeTerminalEnter({
      alt: altActive,
      ctrl: ctrlActive,
      shift: shiftActive,
    }), { clearModifiers: altActive || ctrlActive || shiftActive });
  }, [altActive, ctrlActive, sendBytes, shiftActive]);

  const pasteClipboard = useCallback(async () => {
    try {
      const text = await readClipboardText();
      if (text) {
        sendText(text, { clearModifiers: true });
      }
    } catch {
      resetModifiers();
    }
  }, [resetModifiers, sendText]);

  const refreshTmuxContext = useCallback(async () => {
    const currentSessionId = sessionIdRef.current;
    if (!currentSessionId) {
      setTmuxContext(null);
      return null;
    }

    const response = await getTerminalTmuxContext(currentSessionId);
    setTmuxContext(response.context);
    return response.context;
  }, []);

  const runTmuxAction = useCallback(async (
    action: TerminalTmuxAction,
    options: {
      lines?: number | null;
      socketPath?: string | null;
      target?: TerminalTmuxActionTarget | null;
    } = {},
  ) => {
    const currentSessionId = sessionIdRef.current;
    if (!currentSessionId) {
      return;
    }

    try {
      const response = await runTerminalTmuxAction({
        action,
        lines: options.lines ?? null,
        sessionId: currentSessionId,
        socketPath: options.socketPath ?? null,
        target: options.target ?? null,
      });
      if (response.context) {
        setTmuxContext(response.context);
      } else {
        await refreshTmuxContext();
      }
    } catch (error) {
      // Tmux helper failures should not put the terminal itself in an error state.
      console.warn(errorMessage(error));
    }
  }, [refreshTmuxContext]);

  const helperTextarea = useCallback(() => {
    return containerRef.current?.querySelector('.xterm-helper-textarea') as HTMLTextAreaElement | null;
  }, []);

  const closeKeyboard = useCallback(() => {
    const textarea = helperTextarea();
    textarea?.setAttribute('inputmode', 'none');
    textarea?.blur();
    setKeyboardOpen(false);
    void dismissHostKeyboard().catch(() => undefined);
  }, [helperTextarea]);

  const openKeyboard = useCallback(() => {
    if (selectionModeRef.current || keyboardOpenRef.current) {
      return;
    }

    const textarea = helperTextarea();
    if (!textarea) {
      return;
    }

    textarea.removeAttribute('inputmode');
    textarea.setAttribute('autocomplete', 'off');
    textarea.setAttribute('autocorrect', 'off');
    textarea.setAttribute('autocapitalize', 'off');
    textarea.setAttribute('spellcheck', 'false');
    textarea.style.transform = 'translateY(-9999px)';
    textarea.focus({ preventScroll: true });
    window.setTimeout(() => {
      textarea.style.transform = '';
    }, 0);
    setKeyboardOpen(true);
  }, [helperTextarea]);

  const toggleKeyboard = useCallback(() => {
    if (keyboardOpenRef.current) {
      closeKeyboard();
      return;
    }

    openKeyboard();
  }, [closeKeyboard, openKeyboard]);

  const handleTerminalTap = useCallback(() => {
    if (selectionModeRef.current) {
      return;
    }

    const now = performance.now();
    const sinceLastTap = now - lastTerminalTapMsRef.current;
    // Collapse the touchend + synthetic-click pair fired by a single physical tap.
    if (sinceLastTap < terminalTapEchoMs) {
      return;
    }

    lastTerminalTapMsRef.current = now;

    // Single tap brings the keyboard up; only a deliberate double tap dismisses it,
    // so a stray tap while typing can't drop the keyboard.
    if (keyboardOpenRef.current) {
      if (sinceLastTap < terminalDoubleTapMs) {
        closeKeyboard();
      }
      return;
    }

    openKeyboard();
  }, [closeKeyboard, openKeyboard]);

  const refreshSelectionState = useCallback(() => {
    const terminal = terminalRef.current;
    setSelectionText(terminal?.hasSelection() ? terminal.getSelection() : '');
  }, []);

  const clearTerminalSelection = useCallback(() => {
    selectionDragRef.current = null;
    terminalRef.current?.clearSelection();
    setSelectionText('');
  }, []);

  const exitSelectionMode = useCallback(() => {
    selectionDragRef.current = null;
    setSelectionMode(false);
    terminalRef.current?.clearSelection();
    setSelectionText('');
  }, []);

  const enterSelectionMode = useCallback(() => {
    closeKeyboard();
    resetModifiers();
    selectionDragRef.current = null;
    terminalRef.current?.clearSelection();
    setSelectionText('');
    setSelectionMode(true);
  }, [closeKeyboard, resetModifiers]);

  const copyTerminalSelection = useCallback(async () => {
    const text = terminalRef.current?.getSelection() || selectionText;
    if (!text) {
      return;
    }

    await writeClipboardText(text);
    exitSelectionMode();
  }, [exitSelectionMode, selectionText]);

  const handleTerminalClick = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    if (selectionModeRef.current || event.defaultPrevented) {
      return;
    }

    handleTerminalTap();
  }, [handleTerminalTap]);

  const handleSelectionPointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (!selectionModeRef.current || (event.pointerType === 'mouse' && event.button !== 0)) {
      return;
    }

    const terminal = terminalRef.current;
    const container = containerRef.current;
    const point = terminalSelectionPoint(terminal, container, event.clientX, event.clientY);
    if (!terminal || !point) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    selectionDragRef.current = {
      anchor: point,
      pointerId: event.pointerId,
    };

    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // Pointer capture is best-effort; move/up handlers still cover normal browsers.
    }

    selectTerminalRange(terminal, point, point);
    refreshSelectionState();
  }, [refreshSelectionState]);

  const handleSelectionPointerMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = selectionDragRef.current;
    if (!selectionModeRef.current || !drag || drag.pointerId !== event.pointerId) {
      return;
    }

    const terminal = terminalRef.current;
    const point = terminalSelectionPoint(terminal, containerRef.current, event.clientX, event.clientY);
    if (!terminal || !point) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    selectTerminalRange(terminal, drag.anchor, point);
    refreshSelectionState();
  }, [refreshSelectionState]);

  const handleSelectionPointerEnd = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = selectionDragRef.current;
    if (!selectionModeRef.current || !drag || drag.pointerId !== event.pointerId) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    selectionDragRef.current = null;
    try {
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
    } catch {
      // Ignore browsers that do not expose capture state for synthetic events.
    }
  }, []);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return undefined;
    }
    const terminalContainer = container;

    let disposed = false;
    let cleanupTouch: (() => void) | null = null;
    let resizeObserver: ResizeObserver | null = null;

    async function initializeTerminal() {
      const fontSize = terminalFontSize();
      await document.fonts?.load?.(`${fontSize}px ${fontFamily}`);
      await document.fonts?.load?.(`bold ${fontSize}px ${fontFamily}`);
      if (disposed) {
        return;
      }

      const terminal = new Terminal({
        allowProposedApi: true,
        convertEol: false,
        cursorBlink: true,
        cursorStyle: 'block',
        customGlyphs: true,
        fontFamily,
        fontSize,
        lineHeight: 1.16,
        rescaleOverlappingGlyphs: true,
        scrollback: 5000,
        theme: terminalThemeDark,
      });

      const unicode11 = new Unicode11Addon();
      terminal.loadAddon(unicode11);
      terminal.unicode.activeVersion = '11';
      terminal.loadAddon(new WebLinksAddon());

      const fitAddon = new FitAddon();
      terminal.loadAddon(fitAddon);
      terminal.open(terminalContainer);

      const textarea = helperTextarea();
      textarea?.setAttribute('inputmode', 'none');

      try {
        const webgl = new WebglAddon();
        webgl.onContextLoss(() => webgl.dispose());
        terminal.loadAddon(webgl);
      } catch {
        // The canvas renderer is the fallback when WebGL is unavailable.
      }

      terminalRef.current = terminal;
      fitAddonRef.current = fitAddon;
      fitTerminal();

      terminal.attachCustomKeyEventHandler((event) => {
        if (selectionModeRef.current) {
          return false;
        }

        if (event.type === 'keydown' && event.key === 'Enter' && event.shiftKey) {
          sendText(terminalKeySequences.shiftEnter, { clearModifiers: true });
          return false;
        }

        return true;
      });

      const dataDisposable = terminal.onData((data) => {
        if (selectionModeRef.current || suppressedTerminalDataWritesRef.current > 0) {
          return;
        }

        sendBytes(textEncoder.encode(data));
      });
      const resizeDisposable = terminal.onResize(({ cols, rows }) => {
        sendResize(cols, rows);
      });
      const selectionDisposable = terminal.onSelectionChange(refreshSelectionState);
      const titleDisposable = terminal.onTitleChange(handleTerminalTitle);
      const osc633Disposable = terminal.parser.registerOscHandler(633, handleShellIntegrationSequence);
      const osc7Disposable = terminal.parser.registerOscHandler(7, (data) => (
        handleCurrentDirectory(parseOsc7CurrentDirectory(data))
      ));
      const osc1337Disposable = terminal.parser.registerOscHandler(1337, (data) => (
        handleCurrentDirectory(parseOsc1337CurrentDirectory(data))
      ));

      cleanupTouch = setupTouchScroll(terminalContainer, terminal, {
        // Touch scroll now routes through xterm's wheel pipeline, so it works inside
        // tmux when its mouse mode is on. Tmux without mouse keeps the copy-mode
        // buttons (bare arrows would just move the cursor), and selection owns the pointer.
        disabled: () => (
          selectionModeRef.current
          || (tmuxAttachedRef.current && terminal.modes.mouseTrackingMode === 'none')
        ),
        onTap: handleTerminalTap,
      });
      resizeObserver = new ResizeObserver(() => scheduleFit());
      resizeObserver.observe(terminalContainer);

      void startOrAttachSession().catch((error) => {
        setStatus({ message: errorMessage(error), type: 'error' });
      });

      if (disposed) {
        dataDisposable.dispose();
        resizeDisposable.dispose();
        selectionDisposable.dispose();
        titleDisposable.dispose();
        osc633Disposable.dispose();
        osc7Disposable.dispose();
        osc1337Disposable.dispose();
        cleanupTouch?.();
        resizeObserver?.disconnect();
        terminal.dispose();
        return;
      }

      return () => {
        dataDisposable.dispose();
        resizeDisposable.dispose();
        selectionDisposable.dispose();
        titleDisposable.dispose();
        osc633Disposable.dispose();
        osc7Disposable.dispose();
        osc1337Disposable.dispose();
        cleanupTouch?.();
        resizeObserver?.disconnect();
        suppressedTerminalDataWritesRef.current = 0;
        terminal.dispose();
      };
    }

    let cleanup: (() => void) | undefined;
    void initializeTerminal().then((nextCleanup) => {
      if (disposed) {
        nextCleanup?.();
        return;
      }

      cleanup = nextCleanup;
    });

    return () => {
      disposed = true;
      if (fitTimerRef.current !== null) {
        window.clearTimeout(fitTimerRef.current);
        fitTimerRef.current = null;
      }
      cleanup?.();
      suppressedTerminalDataWritesRef.current = 0;
      terminalRef.current = null;
      fitAddonRef.current = null;
    };
  }, [
    fitTerminal,
    handleCurrentDirectory,
    handleShellIntegrationSequence,
    handleTerminalTap,
    handleTerminalTitle,
    helperTextarea,
    refreshSelectionState,
    scheduleFit,
    sendBytes,
    sendResize,
    sendText,
    startOrAttachSession,
  ]);

  useEffect(() => subscribeTerminalEvents((event) => {
    const currentSessionId = sessionIdRef.current;
    if (!currentSessionId) {
      return;
    }

    if (event.type === 'output' && event.event.sessionId === currentSessionId) {
      writeFrame(event.event.frame);
      setReplayGap(false);
      return;
    }

    if (event.type === 'exited' && event.event.sessionId === currentSessionId) {
      setStatus({
        code: event.event.exitCode,
        signal: event.event.exitSignal,
        type: 'exited',
      });
      setTmuxContext(null);
    }
  }), [writeFrame]);

  useEffect(() => subscribeHostConnection((nextStatus) => {
    setConnected(nextStatus === 'connected');

    const previousStatus = connectionRef.current;
    connectionRef.current = nextStatus;
    const hadSeenConnected = connectedEventSeenRef.current;
    if (nextStatus === 'connected') {
      connectedEventSeenRef.current = true;
    }
    if (
      nextStatus === 'connected' &&
      hadSeenConnected &&
      previousStatus !== 'connected' &&
      initialAttachCompletedRef.current
    ) {
      void resyncSession();
    }
  }), [resyncSession]);

  useEffect(() => subscribeHostActive((active) => {
    const wasActive = hostActiveRef.current;
    hostActiveRef.current = active;
    setHostActive(active);
    // Resync only on a real background→foreground transition. Reconnects are
    // owned by the connection handler, which re-posts active and would otherwise
    // trigger a redundant attach here.
    if (active && !wasActive) {
      void resyncSession();
    }
  }), [resyncSession]);

  useEffect(() => {
    if (!sessionId || status.type !== 'running' || !hostActive || !connected) {
      setTmuxContext(null);
      return undefined;
    }

    const currentSessionId = sessionId;
    let disposed = false;
    async function pollTmuxContext() {
      try {
        const response = await getTerminalTmuxContext(currentSessionId);
        if (disposed) {
          return;
        }

        setTmuxContext(response.context);
      } catch {
        if (!disposed) {
          setTmuxContext(null);
        }
      }
    }

    void pollTmuxContext();
    const interval = window.setInterval(() => {
      void pollTmuxContext();
    }, tmuxPollMs);

    return () => {
      disposed = true;
      window.clearInterval(interval);
    };
  }, [connected, hostActive, sessionId, status.type]);

  useEffect(() => {
    tmuxAttachedRef.current = tmuxContext?.mode === 'attached';
  }, [tmuxContext?.mode]);

  useEffect(() => {
    if (commandTitleTimerRef.current !== null) {
      window.clearTimeout(commandTitleTimerRef.current);
      commandTitleTimerRef.current = null;
    }

    if (!shellState.running || !shellState.command || shellState.commandTitleReady) {
      return undefined;
    }

    const startedAt = shellState.commandStartedAt ?? Date.now();
    const delayMs = Math.max(0, commandTitleDelayMs - (Date.now() - startedAt));
    commandTitleTimerRef.current = window.setTimeout(() => {
      commandTitleTimerRef.current = null;
      setShellState((current) => {
        if (!current.running || !current.command) {
          return current;
        }

        return { ...current, commandTitleReady: true };
      });
    }, delayMs);

    return () => {
      if (commandTitleTimerRef.current !== null) {
        window.clearTimeout(commandTitleTimerRef.current);
        commandTitleTimerRef.current = null;
      }
    };
  }, [shellState.command, shellState.commandStartedAt, shellState.commandTitleReady, shellState.running]);

  useEffect(() => {
    void updateHostTab(terminalTabMetadata(status, sessionId, tmuxContext, shellState)).catch(() => undefined);
  }, [sessionId, shellState, status, tmuxContext]);

  useEffect(() => {
    const unsubscribe = subscribeHostViewportMetrics((metrics) => updateKeyboardOffset(metrics));
    void getHostViewportMetrics()
      .then((metrics) => updateKeyboardOffset(metrics))
      .catch(() => updateKeyboardOffset());
    return unsubscribe;
  }, [updateKeyboardOffset]);

  useEffect(() => {
    const handleViewportChange = () => updateKeyboardOffset();
    window.addEventListener('resize', handleViewportChange);
    window.visualViewport?.addEventListener('resize', handleViewportChange);
    window.visualViewport?.addEventListener('scroll', handleViewportChange);
    handleViewportChange();

    return () => {
      window.removeEventListener('resize', handleViewportChange);
      window.visualViewport?.removeEventListener('resize', handleViewportChange);
      window.visualViewport?.removeEventListener('scroll', handleViewportChange);
    };
  }, [updateKeyboardOffset]);

  useEffect(() => {
    const onFocusOut = (event: FocusEvent) => {
      const target = event.target as Element | null;
      if (target?.classList?.contains('xterm-helper-textarea')) {
        target.setAttribute('inputmode', 'none');
        setKeyboardOpen(false);
      }
    };

    document.addEventListener('focusout', onFocusOut);
    return () => document.removeEventListener('focusout', onFocusOut);
  }, []);

  useEffect(() => {
    if (!ctrlActive && !altActive && !shiftActive) {
      return undefined;
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.repeat || isModifierKey(event.key)) {
        return;
      }

      const encoded = encodeModifiedKey(event, {
        alt: altActive,
        ctrl: ctrlActive,
        shift: shiftActive,
      });
      if (!encoded) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      sendBytes(encoded, { clearModifiers: true });
    };

    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [altActive, ctrlActive, sendBytes, shiftActive]);

  return (
    <main className="remux-terminal-shell" style={terminalShellStyle(keyboardOffset)}>
      <section className="remux-terminal-stage">
        <div
          className={[
            'remux-terminal-container',
            selectionMode ? 'is-selecting' : '',
          ].filter(Boolean).join(' ')}
          onClickCapture={handleTerminalClick}
          onPointerCancelCapture={handleSelectionPointerEnd}
          onPointerDownCapture={handleSelectionPointerDown}
          onPointerMoveCapture={handleSelectionPointerMove}
          onPointerUpCapture={handleSelectionPointerEnd}
          ref={containerRef}
        />
        <TerminalOverlay replayGap={replayGap} status={status} />
      </section>
      <ActionBar
        className={[
          'remux-terminal-action-bar',
          keyboardOffset > 0 ? 'is-keyboard-offset' : '',
        ].filter(Boolean).join(' ')}
        left={(
          <div className="remux-terminal-action-stack">
            {tmuxContext?.mode === 'attached' ? (
              <TerminalTmuxControls
                context={tmuxContext}
                onRunAction={runTmuxAction}
              />
            ) : null}
            <div className="remux-terminal-key-row">
              <div className="remux-terminal-key-fixed">
                <TerminalKey label="Open tabs" onPress={() => void openHostOverview()}>
                  <PanelRightOpen />
                </TerminalKey>
                <TerminalActionMenu
                  keyboardOpen={keyboardOpen}
                  onEnterSelectionMode={enterSelectionMode}
                  onExitSelectionMode={exitSelectionMode}
                  onPaste={() => void pasteClipboard()}
                  onReload={() => void reloadHostView()}
                  onRestart={restartSession}
                  onToggleKeyboard={toggleKeyboard}
                  selectionMode={selectionMode}
                  status={status}
                />
              </div>
              <div className="remux-terminal-key-scroll">
                {selectionMode ? (
                  <>
                    <TerminalKey
                      disabled={!selectionText}
                      label="Copy selection"
                      onPress={() => void copyTerminalSelection()}
                    >
                      <Copy />
                    </TerminalKey>
                    <TerminalKey
                      disabled={!selectionText}
                      label="Clear selection"
                      onPress={clearTerminalSelection}
                    >
                      <Eraser />
                    </TerminalKey>
                    <TerminalKey label="Done selecting" onPress={exitSelectionMode}>
                      <Check />
                    </TerminalKey>
                  </>
                ) : (
                  <>
                    <TerminalKey label="Escape" onPress={() => sendText(terminalKeySequences.escape, { clearModifiers: true })}>
                      <span className="remux-terminal-key-text">Esc</span>
                    </TerminalKey>
                    <TerminalKey label="Tab" onPress={sendTab}>
                      <span className="remux-terminal-key-text">Tab</span>
                    </TerminalKey>
                    <TerminalKey
                      active={shiftActive}
                      label="Sticky shift"
                      onPress={() => setShiftActive((value) => !value)}
                    >
                      <span className="remux-terminal-key-text">Shift</span>
                    </TerminalKey>
                    <TerminalKey
                      active={ctrlActive}
                      label="Sticky control"
                      onPress={() => setCtrlActive((value) => !value)}
                    >
                      <span className="remux-terminal-key-text">Ctrl</span>
                    </TerminalKey>
                    <TerminalKey
                      active={altActive}
                      label="Sticky alt"
                      onPress={() => setAltActive((value) => !value)}
                    >
                      <span className="remux-terminal-key-text">Alt</span>
                    </TerminalKey>
                    <TerminalKey label="Arrow up" onPress={() => sendArrow('A')}>
                      <ArrowUp />
                    </TerminalKey>
                    <TerminalKey label="Arrow down" onPress={() => sendArrow('B')}>
                      <ArrowDown />
                    </TerminalKey>
                    <TerminalKey label="Arrow left" onPress={() => sendArrow('D')}>
                      <ArrowLeft />
                    </TerminalKey>
                    <TerminalKey label="Arrow right" onPress={() => sendArrow('C')}>
                      <ArrowRight />
                    </TerminalKey>
                    <TerminalKey label="Enter" onPress={sendEnter}>
                      <CornerDownLeft />
                    </TerminalKey>
                    <TerminalKey label="Control C" onPress={() => sendBytes(terminalControlCBytes(), { clearModifiers: true })}>
                      <span className="remux-terminal-key-text">^C</span>
                    </TerminalKey>
                    {status.type === 'error' || status.type === 'exited' ? (
                      <TerminalKey label="Start new shell" onPress={restartSession}>
                        <RefreshCw />
                      </TerminalKey>
                    ) : null}
                  </>
                )}
              </div>
            </div>
          </div>
        )}
      />
    </main>
  );
}

type TerminalTmuxControlsProps = {
  context: TerminalTmuxContext;
  onRunAction: TerminalTmuxRunAction;
};

type TerminalTmuxRunAction = (
  action: TerminalTmuxAction,
  options?: {
    lines?: number | null;
    socketPath?: string | null;
    target?: TerminalTmuxActionTarget | null;
  },
) => Promise<void> | void;

type TerminalRepeatPressKind = 'repeat' | 'tap';

function TerminalActionMenu({
  keyboardOpen,
  onEnterSelectionMode,
  onExitSelectionMode,
  onPaste,
  onReload,
  onRestart,
  onToggleKeyboard,
  selectionMode,
  status,
}: {
  keyboardOpen: boolean;
  onEnterSelectionMode: () => void;
  onExitSelectionMode: () => void;
  onPaste: () => void;
  onReload: () => void;
  onRestart: () => void;
  onToggleKeyboard: () => void;
  selectionMode: boolean;
  status: TerminalStatus;
}) {
  return (
    <ActionMenu
      align="start"
      className="remux-terminal-action-menu"
      icon={<Menu />}
      label="Terminal menu"
      panelClassName="remux-terminal-action-menu-panel"
      preserveFocus
      triggerClassName="remux-terminal-key"
    >
      <ActionMenuItem
        disabled={selectionMode}
        icon={keyboardOpen ? <KeyboardOff /> : <Keyboard />}
        label={keyboardOpen ? 'Hide keyboard' : 'Show keyboard'}
        onSelect={onToggleKeyboard}
      />
      <ActionMenuItem
        icon={selectionMode ? <X /> : <TextSelect />}
        label={selectionMode ? 'Exit selection' : 'Select text'}
        onSelect={selectionMode ? onExitSelectionMode : onEnterSelectionMode}
      />
      <ActionMenuItem
        disabled={selectionMode}
        icon={<ClipboardPaste />}
        label="Paste"
        onSelect={onPaste}
      />
      <ActionMenuItem
        icon={<RefreshCw />}
        label="Reload viewer"
        onSelect={onReload}
      />
      {status.type === 'error' || status.type === 'exited' ? (
        <ActionMenuItem
          icon={<RefreshCw />}
          label="Start new shell"
          onSelect={onRestart}
        />
      ) : null}
    </ActionMenu>
  );
}

function TerminalTmuxControls({
  context,
  onRunAction,
}: TerminalTmuxControlsProps) {
  const active = activeTmuxState(context);
  if (!active?.session) {
    return null;
  }

  return (
    <TerminalTmuxAttachedControls
      active={active}
      onRunAction={onRunAction}
    />
  );
}

function TerminalTmuxAttachedControls({
  active,
  onRunAction,
}: {
  active: ActiveTmuxState;
  onRunAction: TerminalTmuxRunAction;
}) {
  const socketPath = active.socket.socketPath;
  const scrollUp = useCallback((pressKind: TerminalRepeatPressKind) => onRunAction('scroll-up', {
    lines: pressKind === 'tap' ? tmuxScrollTapLines : tmuxScrollRepeatLines,
    socketPath,
    target: null,
  }), [onRunAction, socketPath]);
  const scrollDown = useCallback((pressKind: TerminalRepeatPressKind) => onRunAction('scroll-down', {
    lines: pressKind === 'tap' ? tmuxScrollTapLines : tmuxScrollRepeatLines,
    socketPath,
    target: null,
  }), [onRunAction, socketPath]);

  return (
    <section className="remux-terminal-tmux-row" aria-label="tmux controls">
      <div className="remux-terminal-tmux-session">
        <TerminalTmuxSessionMenu
          active={active}
          onRunAction={onRunAction}
          socketPath={socketPath}
        />
      </div>
      <div className="remux-terminal-tmux-tabs" aria-label="tmux windows">
        {active.session.windows.map((window) => (
          <TerminalKey
            active={window.active}
            className="remux-terminal-tmux-tab-key"
            key={window.id}
            label={`tmux window ${window.index}: ${window.name || window.id}`}
            onPress={() => onRunAction('select-window', {
              socketPath,
              target: { tmuxWindowId: window.id },
            })}
          >
            <span className="remux-terminal-tmux-tab-content">
              <span className="remux-terminal-tmux-tab-index">{window.index}</span>
              <span className="remux-terminal-tmux-tab-name">{window.name || window.id}</span>
            </span>
          </TerminalKey>
        ))}
      </div>
      <div className="remux-terminal-tmux-fixed">
        <TerminalRepeatKey
          label="Scroll tmux up"
          onPress={scrollUp}
        >
          <ArrowUp />
        </TerminalRepeatKey>
        <TerminalRepeatKey
          label="Scroll tmux down"
          onPress={scrollDown}
        >
          <ArrowDown />
        </TerminalRepeatKey>
        <TerminalTmuxActionMenu
          active={active}
          onRunAction={onRunAction}
          socketPath={socketPath}
        />
      </div>
    </section>
  );
}

function TerminalTmuxSessionMenu({
  active,
  onRunAction,
  socketPath,
}: {
  active: ActiveTmuxState;
  onRunAction: TerminalTmuxRunAction;
  socketPath: string | null;
}) {
  return (
    <ActionMenu
      align="start"
      className="remux-terminal-tmux-session-menu"
      icon={<NotebookTabs />}
      label="tmux sessions"
      panelClassName="remux-terminal-tmux-session-menu-panel"
      preserveFocus
      triggerClassName="remux-terminal-key remux-terminal-tmux-session-trigger"
    >
      {active.socket.sessions.map((session) => {
        const isActiveSession = session.id === active.session.id;
        return (
          <ActionMenuItem
            icon={isActiveSession ? <Check /> : <NotebookTabs />}
            key={session.id}
            label={tmuxSessionMenuLabel(session)}
            onSelect={() => {
              if (isActiveSession) {
                return;
              }

              onRunAction('switch-session', {
                socketPath,
                target: { tmuxSessionId: session.id },
              });
            }}
          />
        );
      })}
    </ActionMenu>
  );
}

function TerminalTmuxActionMenu({
  active,
  onRunAction,
  socketPath,
}: {
  active: ActiveTmuxState;
  onRunAction: TerminalTmuxRunAction;
  socketPath: string | null;
}) {
  const activeWindowTarget = active.window ? { tmuxWindowId: active.window.id } : null;

  return (
    <ActionMenu
      align="end"
      className="remux-terminal-tmux-action-menu"
      icon={<MoreHorizontal />}
      label="tmux actions"
      panelClassName="remux-terminal-tmux-action-menu-panel"
      preserveFocus
      triggerClassName="remux-terminal-key"
    >
      <ActionMenuItem
        icon={<Plus />}
        label="New tab"
        onSelect={() => onRunAction('new-window', {
          socketPath,
          target: { tmuxSessionId: active.session.id },
        })}
      />
      <ActionMenuItem
        disabled={!activeWindowTarget}
        icon={<X />}
        label="Close tab"
        onSelect={() => {
          if (!activeWindowTarget) {
            return;
          }

          onRunAction('close-window', {
            socketPath,
            target: activeWindowTarget,
          });
        }}
      />
      <ActionMenuItem
        icon={<LogOut />}
        label="Exit tmux"
        onSelect={() => onRunAction('exit-tmux', {
          socketPath,
          target: null,
        })}
      />
    </ActionMenu>
  );
}

function tmuxSessionMenuLabel(session: TerminalTmuxSession) {
  const name = session.name || session.id;
  const tabs = session.windows
    .map((window) => window.name || window.id)
    .filter(Boolean);
  if (tabs.length === 0) {
    return name;
  }

  return `${name}: ${tabs.join(', ')}`;
}

function TerminalOverlay({ replayGap, status }: { replayGap: boolean; status: TerminalStatus }) {
  if (replayGap) {
    return (
      <div className="remux-terminal-overlay remux-terminal-overlay-bottom">
        <span>Terminal output replay was truncated; waiting for fresh output.</span>
      </div>
    );
  }

  if (status.type === 'running') {
    return null;
  }

  if (status.type === 'connecting') {
    return (
      <div className="remux-terminal-overlay">
        <div className="remux-terminal-spinner" aria-hidden="true" />
      </div>
    );
  }

  const message = status.type === 'error'
    ? status.message
    : status.signal
      ? `Exited: ${status.signal}`
      : `Exited ${status.code ?? 0}`;

  return (
    <div className="remux-terminal-overlay remux-terminal-overlay-bottom">
      <span>{message}</span>
    </div>
  );
}

function TerminalKey({
  active,
  children,
  className,
  disabled,
  label,
  onPress,
}: {
  active?: boolean;
  children: ReactNode;
  className?: string;
  disabled?: boolean;
  label: string;
  onPress: () => void;
}) {
  return (
    <ActionButton
      className={[
        'remux-terminal-key',
        active ? 'is-active' : '',
        className ?? '',
      ].filter(Boolean).join(' ')}
      disabled={disabled}
      icon={children}
      label={label}
      onClick={onPress}
      preserveFocus
    />
  );
}

function TerminalRepeatKey({
  active,
  children,
  className,
  label,
  onPress,
}: {
  active?: boolean;
  children: ReactNode;
  className?: string;
  label: string;
  onPress: (pressKind: TerminalRepeatPressKind) => Promise<void> | void;
}) {
  const handlers = useRepeatingPress(onPress, {
    holdDelayMs: tmuxScrollHoldDelayMs,
    intervalMs: tmuxScrollRepeatMs,
  });

  return (
    <button
      aria-label={label}
      className={[
        'remux-extension-action-button',
        'remux-terminal-key',
        active ? 'is-active' : '',
        className ?? '',
      ].filter(Boolean).join(' ')}
      data-remux-preserve-focus="true"
      type="button"
      {...handlers}
    >
      {children}
    </button>
  );
}

function useRepeatingPress(
  onPress: (pressKind: TerminalRepeatPressKind) => Promise<void> | void,
  { holdDelayMs, intervalMs }: { holdDelayMs: number; intervalMs: number },
) {
  const activeRef = useRef(false);
  const intervalRef = useRef<number | null>(null);
  const onPressRef = useRef(onPress);
  const queuedTapCountRef = useRef(0);
  const runningRef = useRef(false);
  const timeoutRef = useRef<number | null>(null);

  useEffect(() => {
    onPressRef.current = onPress;
  }, [onPress]);

  const clearTimers = useCallback(() => {
    if (timeoutRef.current !== null) {
      window.clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
    if (intervalRef.current !== null) {
      window.clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
  }, []);

  const runPress = useCallback((pressKind: TerminalRepeatPressKind) => {
    if (runningRef.current) {
      if (pressKind === 'tap') {
        queuedTapCountRef.current = Math.min(
          queuedTapCountRef.current + 1,
          tmuxScrollMaxQueuedTaps,
        );
      }
      return;
    }

    runningRef.current = true;
    void Promise.resolve(onPressRef.current(pressKind))
      .catch((error) => console.warn(errorMessage(error)))
      .finally(() => {
        runningRef.current = false;
        if (queuedTapCountRef.current > 0) {
          queuedTapCountRef.current -= 1;
          runPress('tap');
        }
      });
  }, []);

  const stopPress = useCallback(() => {
    activeRef.current = false;
    clearTimers();
  }, [clearTimers]);

  const startPress = useCallback(() => {
    if (activeRef.current) {
      return;
    }

    activeRef.current = true;
    runPress('tap');
    timeoutRef.current = window.setTimeout(() => {
      timeoutRef.current = null;
      intervalRef.current = window.setInterval(() => runPress('repeat'), intervalMs);
    }, holdDelayMs);
  }, [holdDelayMs, intervalMs, runPress]);

  useEffect(() => () => {
    queuedTapCountRef.current = 0;
    stopPress();
  }, [stopPress]);

  const onPointerDown = useCallback((event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // Pointer capture is best-effort; the release handlers still cover normal browsers.
    }
    startPress();
  }, [startPress]);

  const onPointerUp = useCallback((event: ReactPointerEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    try {
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
    } catch {
      // Ignore browsers that do not expose capture state for synthetic events.
    }
    stopPress();
  }, [stopPress]);

  const onKeyDown = useCallback((event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== 'Enter' && event.key !== ' ') {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    if (!event.repeat) {
      startPress();
    }
  }, [startPress]);

  const onKeyUp = useCallback((event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== 'Enter' && event.key !== ' ') {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    stopPress();
  }, [stopPress]);

  return {
    onKeyDown,
    onKeyUp,
    onMouseDown: (event: ReactMouseEvent<HTMLButtonElement>) => event.preventDefault(),
    onPointerCancel: onPointerUp,
    onPointerDown,
    onPointerUp,
    onTouchStart: (event: ReactTouchEvent<HTMLButtonElement>) => event.preventDefault(),
    onLostPointerCapture: stopPress,
  };
}

type ActiveTmuxState = {
  session: TerminalTmuxSession;
  socket: TerminalTmuxSocketState;
  window: TerminalTmuxWindow | null;
};

function activeTmuxState(context: TerminalTmuxContext): ActiveTmuxState | null {
  const currentClient = context.currentClient;
  const preferredSocket = context.sockets.find((socket) => (
    socket.available && socket.socketPath === (currentClient?.socketPath ?? null)
  ));

  if (!preferredSocket) {
    return null;
  }

  const session = preferredSocket.sessions.find((candidate) => (
    currentClient?.sessionId ? candidate.id === currentClient.sessionId : candidate.attached > 0
  )) ?? null;

  if (!session) {
    return null;
  }

  const window = session.windows.find((candidate) => candidate.active)
    ?? session.windows.find((candidate) => candidate.id === session.activeWindowId)
    ?? session.windows[0]
    ?? null;

  return {
    session,
    socket: preferredSocket,
    window,
  };
}

function terminalSelectionPoint(
  terminal: Terminal | null,
  container: HTMLElement | null,
  clientX: number,
  clientY: number,
): TerminalSelectionPoint | null {
  if (!terminal || !container || terminal.cols <= 0 || terminal.rows <= 0) {
    return null;
  }

  const screen = container.querySelector('.xterm-screen') as HTMLElement | null;
  const rect = screen?.getBoundingClientRect();
  if (!rect || rect.width <= 0 || rect.height <= 0) {
    return null;
  }

  const cellWidth = rect.width / terminal.cols;
  const cellHeight = rect.height / terminal.rows;
  if (cellWidth <= 0 || cellHeight <= 0) {
    return null;
  }

  const column = clampSelectionValue(
    Math.ceil((clientX - rect.left + cellWidth / 2) / cellWidth) - 1,
    0,
    terminal.cols,
  );
  const visibleRow = clampSelectionValue(
    Math.ceil((clientY - rect.top) / cellHeight) - 1,
    0,
    terminal.rows - 1,
  );

  return {
    column,
    row: terminal.buffer.active.viewportY + visibleRow,
  };
}

function selectTerminalRange(
  terminal: Terminal,
  anchor: TerminalSelectionPoint,
  focus: TerminalSelectionPoint,
) {
  const cols = terminal.cols;
  if (cols <= 0) {
    return;
  }

  const bufferEnd = Math.max(1, terminal.buffer.active.length * cols);
  const anchorLinear = clampSelectionValue((anchor.row * cols) + anchor.column, 0, bufferEnd);
  const focusLinear = clampSelectionValue((focus.row * cols) + focus.column, 0, bufferEnd);
  const startLinear = Math.min(Math.min(anchorLinear, focusLinear), bufferEnd - 1);
  const endLinear = Math.max(anchorLinear, focusLinear);
  const length = Math.max(1, Math.min(bufferEnd - startLinear, endLinear - startLinear || 1));

  terminal.select(startLinear % cols, Math.floor(startLinear / cols), length);
}

function clampSelectionValue(value: number, min: number, max: number) {
  if (!Number.isFinite(value)) {
    return min;
  }

  return Math.max(min, Math.min(max, Math.floor(value)));
}

async function writeClipboardText(text: string) {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // Fall back for WebView contexts where Clipboard API exists but rejects.
    }
  }

  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  textarea.style.pointerEvents = 'none';
  document.body.append(textarea);
  textarea.select();

  try {
    document.execCommand('copy');
  } finally {
    textarea.remove();
  }
}

async function readClipboardText() {
  try {
    const result = await readHostClipboardText();
    if (result.text) {
      return result.text;
    }
  } catch {
    // Fall back for browser contexts without a Remux host clipboard bridge.
  }

  try {
    return await navigator.clipboard.readText();
  } catch {
    return '';
  }
}

function terminalTabMetadata(
  status: TerminalStatus,
  sessionId: string | null,
  tmuxContext: TerminalTmuxContext | null,
  shellState: TerminalShellState,
) {
  const tmux = tmuxContext?.mode === 'attached' ? activeTmuxState(tmuxContext) : null;
  const pane = tmux?.window?.panes.find((candidate) => candidate.active) ?? tmux?.window?.panes[0] ?? null;
  const tmuxCwd = pane?.currentPath || null;
  const tmuxCommand = pane?.currentCommand || null;
  const initialCwd = status.type === 'running' ? status.cwd : null;
  const cwd = tmuxCwd || shellState.cwd || initialCwd;
  const command = tmuxCommand || (status.type === 'running' ? shellName(status.shell) : null);
  const titleCommand = tmux && command && !isShellCommand(command) ? command : null;
  const shellCommandTitle = !tmux && shellState.running && shellState.commandTitleReady
    ? shellState.command
    : null;

  if (status.type === 'connecting') {
    return {
      status: 'Starting',
      title: 'Terminal',
    };
  }

  if (status.type === 'exited') {
    return {
      status: status.signal ? `Exited: ${status.signal}` : `Exited ${status.code ?? 0}`,
      title: cwd ? compactPathTitle(cwd) : 'Terminal',
    };
  }

  if (status.type === 'error') {
    return {
      status: 'Error',
      title: 'Terminal',
    };
  }

  return {
    status: tmux ? tmuxTabStatus(tmux, command) : shellCommandTitle || command,
    title: titleCommand ||
      shellCommandTitle ||
      (tmuxCwd ? compactPathTitle(tmuxCwd) : null) ||
      (shellState.cwd ? compactPathTitle(shellState.cwd) : null) ||
      shellState.title ||
      (initialCwd ? compactPathTitle(initialCwd) : command || 'Terminal'),
  };
}

function tmuxTabStatus(tmux: ActiveTmuxState, command: string | null) {
  const windowName = tmux.window ? `${tmux.window.index}:${tmux.window.name}` : null;
  const base = windowName ? `tmux ${tmux.session.name}/${windowName}` : `tmux ${tmux.session.name}`;
  return command ? `${base} - ${command}` : base;
}

function basename(path: string) {
  const normalized = path.replace(/[\\/]+$/u, '');
  const parts = normalized.split(/[\\/]/u);
  return parts.at(-1) || normalized;
}

function compactPathTitle(path: string) {
  const normalized = path.replace(/[\\/]+$/u, '');
  const parts = normalized.split(/[\\/]/u).filter(Boolean);
  if (parts.length === 0) {
    return normalized || path;
  }

  return parts.slice(-2).join('/');
}

function shellName(shell: string) {
  return basename(shell) || shell || null;
}

function isShellCommand(command: string) {
  return /^(?:-|)(?:bash|cmd|fish|nu|pwsh|powershell|sh|tcsh|zsh)$/iu.test(command);
}

function shellStateFromOsc633(data: string): ((current: TerminalShellState) => TerminalShellState) | null {
  if (data.startsWith('P;Cwd=')) {
    const cwd = normalizeTerminalMetadataValue(data.slice('P;Cwd='.length));
    if (!cwd) {
      return null;
    }

    return (current) => ({ ...current, cwd });
  }

  if (data.startsWith('E;')) {
    const command = normalizeCommandTitle(data.slice(2));
    if (!command) {
      return null;
    }

    return (current) => ({
      ...current,
      command,
      commandStartedAt: null,
      commandTitleReady: false,
    });
  }

  if (data === 'C') {
    return (current) => ({
      ...current,
      commandStartedAt: Date.now(),
      commandTitleReady: false,
      running: true,
    });
  }

  if (data === 'D' || data.startsWith('D;')) {
    return (current) => ({
      ...current,
      commandStartedAt: null,
      commandTitleReady: false,
      running: false,
    });
  }

  return null;
}

function parseOsc7CurrentDirectory(data: string) {
  const value = data.trim();
  if (!value.startsWith('file://')) {
    return null;
  }

  try {
    const url = new URL(value);
    return url.protocol === 'file:' ? decodeURIComponent(url.pathname) : null;
  } catch {
    return null;
  }
}

function parseOsc1337CurrentDirectory(data: string) {
  const prefix = 'CurrentDir=';
  return data.startsWith(prefix) ? data.slice(prefix.length) : null;
}

function normalizeTerminalMetadataValue(value: string | null | undefined) {
  const normalized = value?.replace(/[\u0000-\u001f\u007f]/gu, '').trim();
  return normalized ? normalized.slice(0, 240) : null;
}

function normalizeCommandTitle(value: string | null | undefined) {
  const normalized = value
    ?.replace(/[\u0000-\u001f\u007f]/gu, '')
    .replace(/\s+/gu, ' ')
    .trim();
  return normalized ? normalized.slice(0, 120) : null;
}

function preferredTerminalSessionId(route: RemuxViewerRoute) {
  if (route.resourceKind === 'terminalSession' && route.resourceId) {
    return route.resourceId;
  }

  return route.tabId;
}

function terminalFontSize() {
  if (window.matchMedia('(max-width: 420px)').matches) {
    return 11;
  }

  if (window.matchMedia('(max-width: 820px)').matches) {
    return 12;
  }

  return 13;
}

function terminalShellStyle(keyboardOffset: number) {
  return {
    '--remux-terminal-keyboard-offset': `${keyboardOffset}px`,
  } as CSSProperties;
}

function normalizedKeyboardOffset(hostMetrics: RemuxHostViewportMetrics | null) {
  const hostOffset = hostMetrics
    ? Math.max(
        0,
        hostMetrics.keyboardHeight,
        hostMetrics.viewportHeight - hostMetrics.visibleBottom,
      )
    : 0;
  const visualOffset = visualViewportKeyboardOffset();
  const maxOffset = Math.max(0, window.innerHeight - 96);

  return Math.round(Math.min(Math.max(hostOffset, visualOffset), maxOffset));
}

function visualViewportKeyboardOffset() {
  const viewport = window.visualViewport;
  if (!viewport) {
    return 0;
  }

  return Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop);
}

function clampSize(value: number, min: number, max: number) {
  if (!Number.isFinite(value)) {
    return min;
  }

  return Math.max(min, Math.min(max, Math.floor(value)));
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
