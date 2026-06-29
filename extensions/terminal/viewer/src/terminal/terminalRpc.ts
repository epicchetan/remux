import { requestIpc, subscribeIpcEvents, type JsonRpcMessage } from '@remux/extension-api/ipc';

const terminalRequestTimeoutMs = 300_000;
const terminalTmuxRequestTimeoutMs = 5_000;

export type TerminalSessionOutputFrame = {
  dataBase64: string;
  seq: number;
};

export type TerminalSessionStatus = 'exited' | 'running';

export type TerminalSessionStartResponse = {
  cols: number;
  cwd: string;
  pid: number | null;
  rows: number;
  sessionId: string;
  shell: string;
  tty?: string | null;
};

export type TerminalSessionAttachResponse = {
  exitCode?: number | null;
  exitSignal?: string | null;
  nextSeq: number;
  replay: TerminalSessionOutputFrame[];
  replayTruncated?: boolean;
  sessionId: string;
  status: TerminalSessionStatus;
};

export type TerminalSessionExitedEvent = {
  exitCode: number | null;
  exitSignal: string | null;
  sessionId: string;
};

export type TerminalSessionOutputEvent = {
  frame: TerminalSessionOutputFrame;
  sessionId: string;
};

export type TerminalTmuxMode = 'attached' | 'available' | 'none';

export type TerminalTmuxContext = {
  currentClient: TerminalTmuxClient | null;
  generatedAt: number;
  mode: TerminalTmuxMode;
  sockets: TerminalTmuxSocketState[];
  terminalSessionId: string;
  terminalTty: string | null;
};

export type TerminalTmuxSocketState = {
  available: boolean;
  error: string | null;
  options: {
    mouse: boolean | null;
    prefix: string | null;
    prefix2: string | null;
  };
  sessions: TerminalTmuxSession[];
  socketPath: string | null;
};

export type TerminalTmuxClient = {
  controlMode: boolean;
  height: number | null;
  pid: number | null;
  sessionId: string | null;
  sessionName: string;
  socketPath: string | null;
  tty: string;
  width: number | null;
};

export type TerminalTmuxSession = {
  activeWindowId: string | null;
  attached: number;
  id: string;
  name: string;
  windowCount: number;
  windows: TerminalTmuxWindow[];
};

export type TerminalTmuxWindow = {
  active: boolean;
  id: string;
  index: number;
  last: boolean;
  layout: string;
  name: string;
  paneCount: number;
  panes: TerminalTmuxPane[];
  sessionId: string;
};

export type TerminalTmuxPane = {
  active: boolean;
  currentCommand: string;
  currentPath: string;
  height: number;
  id: string;
  inMode: boolean;
  index: number;
  pid: number | null;
  tty: string;
  width: number;
  windowId: string;
};

export type TerminalTmuxAction =
  | 'close-window'
  | 'exit-tmux'
  | 'new-window'
  | 'refresh'
  | 'scroll-down'
  | 'scroll-up'
  | 'select-window'
  | 'switch-session';

export type TerminalTmuxActionTarget = {
  tmuxSessionId?: string | null;
  tmuxWindowId?: string | null;
};

export type TerminalEvent =
  | { event: TerminalSessionExitedEvent; type: 'exited' }
  | { event: TerminalSessionOutputEvent; type: 'output' };

export function startTerminalSession(params: {
  cols: number;
  cwd?: string | null;
  rows: number;
  sessionId?: string | null;
  shell?: string | null;
}) {
  return requestIpc<TerminalSessionStartResponse>(
    'remux/terminal/session/start',
    params,
    terminalRequestTimeoutMs,
  );
}

export function attachTerminalSession(params: {
  cols: number;
  replaySeq?: number | null;
  rows: number;
  sessionId: string;
}) {
  return requestIpc<TerminalSessionAttachResponse>(
    'remux/terminal/session/attach',
    params,
    terminalRequestTimeoutMs,
  );
}

export function writeTerminalSession(sessionId: string, data: Uint8Array) {
  return requestIpc<{ ok: boolean }>(
    'remux/terminal/session/write',
    {
      dataBase64: bytesToBase64(data),
      sessionId,
    },
    terminalRequestTimeoutMs,
  );
}

export function resizeTerminalSession(params: {
  cols: number;
  pixelHeight?: number | null;
  pixelWidth?: number | null;
  rows: number;
  sessionId: string;
}) {
  return requestIpc<{ ok: boolean }>(
    'remux/terminal/session/resize',
    params,
    5_000,
  );
}

export function killTerminalSession(sessionId: string) {
  return requestIpc<{ ok: boolean }>(
    'remux/terminal/session/kill',
    { sessionId },
    2_000,
  );
}

export function getTerminalTmuxContext(sessionId: string) {
  return requestIpc<{ context: TerminalTmuxContext }>(
    'remux/terminal/tmux/context/get',
    { sessionId },
    terminalTmuxRequestTimeoutMs,
  );
}

export function runTerminalTmuxAction(params: {
  action: TerminalTmuxAction;
  lines?: number | null;
  sessionId: string;
  socketPath?: string | null;
  target?: TerminalTmuxActionTarget | null;
}) {
  return requestIpc<{ context?: TerminalTmuxContext; ok: boolean }>(
    'remux/terminal/tmux/action',
    params,
    terminalTmuxRequestTimeoutMs,
  );
}

export async function readRemuxSystemInfo() {
  try {
    const result = await requestIpc<unknown>('remux/system/info', undefined, 2_000);
    if (isRecord(result) && (typeof result.cwd === 'string' || result.cwd === null)) {
      return {
        cwd: typeof result.cwd === 'string' && result.cwd.trim().length > 0 ? result.cwd : null,
      };
    }
  } catch {
    // Older hosts may not expose system info. The server will fall back to its cwd.
  }

  return { cwd: null };
}

export function subscribeTerminalEvents(subscriber: (event: TerminalEvent) => void) {
  return subscribeIpcEvents((events) => {
    for (const event of events) {
      const terminalEvent = parseTerminalEvent(event);
      if (terminalEvent) {
        subscriber(terminalEvent);
      }
    }
  });
}

export function bytesFromBase64(value: string) {
  const binary = window.atob(value);
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return bytes;
}

function bytesToBase64(bytes: Uint8Array) {
  let binary = '';
  const chunkSize = 0x8000;

  for (let index = 0; index < bytes.length; index += chunkSize) {
    const chunk = bytes.subarray(index, index + chunkSize);
    binary += String.fromCharCode(...chunk);
  }

  return window.btoa(binary);
}

function parseTerminalEvent(message: JsonRpcMessage): TerminalEvent | null {
  if (message.method === 'remux/terminal/session/output' && isRecord(message.params)) {
    const params = message.params;
    const frame = isRecord(params.frame) ? params.frame : null;
    if (
      typeof params.sessionId === 'string' &&
      frame &&
      typeof frame.seq === 'number' &&
      typeof frame.dataBase64 === 'string'
    ) {
      return {
        event: {
          frame: {
            dataBase64: frame.dataBase64,
            seq: frame.seq,
          },
          sessionId: params.sessionId,
        },
        type: 'output',
      };
    }
  }

  if (message.method === 'remux/terminal/session/exited' && isRecord(message.params)) {
    const params = message.params;
    if (typeof params.sessionId === 'string') {
      return {
        event: {
          exitCode: typeof params.exitCode === 'number' ? params.exitCode : null,
          exitSignal: typeof params.exitSignal === 'string' ? params.exitSignal : null,
          sessionId: params.sessionId,
        },
        type: 'exited',
      };
    }
  }

  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
