import { createInterface } from 'node:readline';
import { gunzipSync, gzipSync } from 'node:zlib';

import { SerializeAddon } from '@xterm/addon-serialize';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { Terminal } from '@xterm/headless';

type SessionKey = `${string}:${number}`;

type StateSession = {
  commandBoundaryRecovery: 'alternate' | 'normal' | null;
  bytesSinceCheckpoint: number;
  framesSinceCheckpoint: number;
  journalPosition: number;
  serializer: SerializeAddon;
  terminal: Terminal;
  throughSeq: number;
};

type WorkerMessage = {
  cols?: number;
  dataBase64?: string;
  encoding?: string;
  generation?: number;
  id?: number;
  journalPosition?: number;
  rows?: number;
  seq?: number;
  sessionId?: string;
  type?: string;
  throughSeq?: number;
};

const sessions = new Map<SessionKey, StateSession>();
const safeCommandBoundaryRecovery = '\x1b[!p\x1b[?1l\x1b[?9l\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1004l\x1b[?1006l\x1b[?1016l\x1b[?2004l\x1b[?2026l\x1b>\x1b[0m\x1b[?25h';
const alternateCommandBoundaryRecovery = `\x1b[?1049l\x1b[?1047l${safeCommandBoundaryRecovery}`;
const maxCompressedSnapshotBytes = 768 * 1024;
const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
let queue = Promise.resolve();

input.on('line', (line) => {
  queue = queue.then(() => handleLine(line)).catch((error) => {
    process.stderr.write(`terminal state worker failed: ${errorMessage(error)}\n`);
  });
});

function sessionKey(sessionId: string, generation: number): SessionKey {
  return `${sessionId}:${generation}`;
}

async function handleLine(line: string) {
  if (!line.trim()) {
    return;
  }

  let message: WorkerMessage;
  try {
    message = JSON.parse(line) as WorkerMessage;
  } catch (error) {
    process.stderr.write(`terminal state worker ignored invalid frame: ${errorMessage(error)}\n`);
    return;
  }

  const id = message.id;
  try {
    switch (message.type) {
      case 'create': {
        const { cols, generation, rows, sessionId } = requiredSessionMessage(message);
        const terminal = new Terminal({
          allowProposedApi: true,
          cols,
          convertEol: false,
          rows,
          scrollback: 5000,
        });
        const unicode11 = new Unicode11Addon();
        terminal.loadAddon(unicode11);
        terminal.unicode.activeVersion = '11';
        const serializer = new SerializeAddon();
        terminal.loadAddon(serializer);
        const stateSession: StateSession = {
          bytesSinceCheckpoint: 0,
          commandBoundaryRecovery: null,
          framesSinceCheckpoint: 0,
          journalPosition: 0,
          serializer,
          terminal,
          throughSeq: 0,
        };
        terminal.parser.registerOscHandler(633, (data) => {
          if (data === 'D' || data.startsWith('D;')) {
            stateSession.commandBoundaryRecovery = terminal.buffer.active.type === 'alternate'
              ? 'alternate'
              : 'normal';
          }
          return false;
        });
        sessions.set(sessionKey(sessionId, generation), stateSession);
        respond(id, { ok: true });
        return;
      }
      case 'drop': {
        const { generation, sessionId } = requiredSessionMessage(message);
        const key = sessionKey(sessionId, generation);
        sessions.get(key)?.terminal.dispose();
        sessions.delete(key);
        respond(id, { ok: true });
        return;
      }
      case 'output': {
        const { generation, sessionId } = requiredSessionMessage(message);
        const session = requiredStateSession(sessionId, generation);
        const seq = requiredPositiveInteger(message.seq, 'seq');
        if (seq !== session.throughSeq + 1) {
          throw new Error(
            `terminal output sequence gap: expected ${session.throughSeq + 1}, received ${seq}`,
          );
        }
        const data = Buffer.from(requiredString(message.dataBase64, 'dataBase64'), 'base64');
        await writeTerminal(session.terminal, data);
        if (session.commandBoundaryRecovery) {
          const recovery = session.commandBoundaryRecovery === 'alternate'
            ? alternateCommandBoundaryRecovery
            : safeCommandBoundaryRecovery;
          session.commandBoundaryRecovery = null;
          await writeTerminal(session.terminal, Buffer.from(recovery, 'utf8'));
        }
        session.throughSeq = seq;
        session.journalPosition = requiredPositiveInteger(message.journalPosition, 'journalPosition');
        session.bytesSinceCheckpoint += data.byteLength;
        session.framesSinceCheckpoint += 1;
        if (session.framesSinceCheckpoint >= 256 || session.bytesSinceCheckpoint >= 1024 * 1024) {
          emitCheckpoint(sessionId, generation, session);
          session.bytesSinceCheckpoint = 0;
          session.framesSinceCheckpoint = 0;
        }
        return;
      }
      case 'restore': {
        const { generation, sessionId } = requiredSessionMessage(message);
        const session = requiredStateSession(sessionId, generation);
        const encoding = requiredString(message.encoding, 'encoding');
        if (encoding !== 'gzip-base64') {
          throw new Error(`unsupported terminal snapshot encoding: ${encoding}`);
        }
        const cols = requiredDimension(message.cols, 'cols', 80);
        const rows = requiredDimension(message.rows, 'rows', 24);
        session.terminal.resize(cols, rows);
        const compressed = Buffer.from(requiredString(message.dataBase64, 'dataBase64'), 'base64');
        await writeTerminal(session.terminal, gunzipSync(compressed));
        session.throughSeq = requiredNonNegativeInteger(message.throughSeq, 'throughSeq');
        session.journalPosition = requiredNonNegativeInteger(
          message.journalPosition,
          'journalPosition',
        );
        session.bytesSinceCheckpoint = 0;
        session.framesSinceCheckpoint = 0;
        return;
      }
      case 'resize': {
        const { cols, generation, rows, sessionId } = requiredSessionMessage(message);
        const session = requiredStateSession(sessionId, generation);
        session.terminal.resize(cols, rows);
        session.journalPosition = requiredPositiveInteger(message.journalPosition, 'journalPosition');
        respond(id, { ok: true });
        return;
      }
      case 'snapshot': {
        const { generation, sessionId } = requiredSessionMessage(message);
        const session = requiredStateSession(sessionId, generation);
        const snapshot = serializeBoundedSnapshot(session);
        respond(id, {
          compressedBytes: snapshot.data.byteLength,
          cols: session.terminal.cols,
          dataBase64: snapshot.data.toString('base64'),
          encoding: 'gzip-base64',
          ok: true,
          rows: session.terminal.rows,
          scrollback: snapshot.scrollback,
          throughSeq: session.throughSeq,
          uncompressedBytes: snapshot.uncompressedBytes,
        });
        return;
      }
      default:
        throw new Error(`unknown worker message type: ${String(message.type)}`);
    }
  } catch (error) {
    respond(id, { error: errorMessage(error), ok: false });
  }
}

function serializeBoundedSnapshot(session: StateSession) {
  for (const scrollback of [1000, 500, 250, 100, 0]) {
    const serialized = session.serializer.serialize({
      excludeAltBuffer: false,
      excludeModes: false,
      scrollback,
    });
    const data = gzipSync(Buffer.from(serialized, 'utf8'));
    if (data.byteLength <= maxCompressedSnapshotBytes) {
      return { data, scrollback, uncompressedBytes: Buffer.byteLength(serialized, 'utf8') };
    }
  }
  throw new Error('terminal snapshot exceeds the transport limit');
}

function emitCheckpoint(sessionId: string, generation: number, session: StateSession) {
  const snapshot = serializeBoundedSnapshot(session);
  process.stdout.write(`${JSON.stringify({
    dataBase64: snapshot.data.toString('base64'),
    encoding: 'gzip-base64',
    generation,
    cols: session.terminal.cols,
    journalPosition: session.journalPosition,
    rows: session.terminal.rows,
    sessionId,
    throughSeq: session.throughSeq,
    type: 'checkpoint',
  })}\n`);
}

function requiredSessionMessage(message: WorkerMessage) {
  return {
    cols: requiredDimension(message.cols, 'cols', 80),
    generation: requiredPositiveInteger(message.generation, 'generation'),
    rows: requiredDimension(message.rows, 'rows', 24),
    sessionId: requiredString(message.sessionId, 'sessionId'),
  };
}

function requiredStateSession(sessionId: string, generation: number) {
  const session = sessions.get(sessionKey(sessionId, generation));
  if (!session) {
    throw new Error(`terminal state session not found: ${sessionId}:${generation}`);
  }
  return session;
}

function requiredString(value: unknown, field: string) {
  if (typeof value !== 'string' || !value) {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value;
}

function requiredPositiveInteger(value: unknown, field: string) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${field} must be a positive integer`);
  }
  return value;
}

function requiredNonNegativeInteger(value: unknown, field: string) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative integer`);
  }
  return value;
}

function requiredDimension(value: unknown, field: string, fallback: number) {
  if (value === undefined) {
    return fallback;
  }
  return requiredPositiveInteger(value, field);
}

function writeTerminal(terminal: Terminal, data: Uint8Array) {
  return new Promise<void>((resolve) => terminal.write(data, resolve));
}

function respond(id: number | undefined, result: Record<string, unknown>) {
  if (id === undefined) {
    return;
  }
  process.stdout.write(`${JSON.stringify({ id, ...result })}\n`);
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
