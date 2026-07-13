import { expect, test } from '@playwright/test';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { createInterface } from 'node:readline';
import { gunzipSync } from 'node:zlib';
import { SerializeAddon } from '@xterm/addon-serialize';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import type { Terminal as HeadlessTerminal } from '@xterm/headless';

const { Terminal } = createRequire(import.meta.url)('@xterm/headless') as {
  Terminal: typeof HeadlessTerminal;
};

test('headless serialization restores alternate screen, cursor, and terminal modes', async () => {
  const source = createTerminal(40, 10);
  await write(source.terminal, 'normal-buffer\r\n');
  await write(
    source.terminal,
    '\x1b[?1049h\x1b[2;4HALT\x1b[?1h\x1b[?1002h\x1b[?1004h\x1b[?2004h',
  );

  const serialized = source.serializer.serialize({
    excludeAltBuffer: false,
    excludeModes: false,
  });
  const restored = createTerminal(40, 10);
  await write(restored.terminal, serialized);

  expect(restored.terminal.buffer.active.type).toBe('alternate');
  expect(restored.terminal.buffer.active.getLine(1)?.translateToString(true)).toContain('ALT');
  expect(restored.terminal.buffer.active.cursorX).toBe(6);
  expect(restored.terminal.buffer.active.cursorY).toBe(1);
  expect(restored.terminal.modes.applicationCursorKeysMode).toBe(true);
  expect(restored.terminal.modes.bracketedPasteMode).toBe(true);
  expect(restored.terminal.modes.mouseTrackingMode).toBe('drag');
  expect(restored.terminal.modes.sendFocusMode).toBe(true);

  source.terminal.dispose();
  restored.terminal.dispose();
});

test('state worker conditionally exits an abandoned alternate screen and emits gzip snapshots', async () => {
  const workerPath = new URL('../state-worker/dist/main.mjs', import.meta.url);
  const child = spawn(process.execPath, [workerPath.pathname], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const lines = createInterface({ input: child.stdout });
  const responses = new Map<number, (value: Record<string, unknown>) => void>();
  let resolveCheckpoint: ((value: Record<string, unknown>) => void) | null = null;
  lines.on('line', (line) => {
    const response = JSON.parse(line) as Record<string, unknown>;
    if (response.type === 'checkpoint') {
      resolveCheckpoint?.(response);
      resolveCheckpoint = null;
    }
    if (typeof response.id === 'number') {
      responses.get(response.id)?.(response);
      responses.delete(response.id);
    }
  });
  const request = (message: Record<string, unknown>) => new Promise<Record<string, unknown>>((resolve) => {
    const id = Number(message.id);
    responses.set(id, resolve);
    child.stdin.write(`${JSON.stringify(message)}\n`);
  });

  try {
    await request({ cols: 40, generation: 1, id: 1, rows: 10, sessionId: 'worker-test', type: 'create' });
    child.stdin.write(`${JSON.stringify({
      dataBase64: Buffer.from(
        '\x1b[4;7HBASE\x1b[?1049h\x1b[2;2HALT\x1b[?1h\x1b[?1004h\x1b]633;D;0\x07',
      ).toString('base64'),
      generation: 1,
      journalPosition: 1,
      seq: 1,
      sessionId: 'worker-test',
      type: 'output',
    })}\n`);
    const snapshot = await request({ generation: 1, id: 2, sessionId: 'worker-test', type: 'snapshot' });
    expect(snapshot.ok).toBe(true);
    expect(snapshot.encoding).toBe('gzip-base64');
    expect(Number(snapshot.compressedBytes)).toBeLessThanOrEqual(768 * 1024);

    const restored = createTerminal(40, 10);
    const serialized = gunzipSync(Buffer.from(String(snapshot.dataBase64), 'base64')).toString('utf8');
    await write(restored.terminal, serialized);
    expect(restored.terminal.buffer.active.type).toBe('normal');
    expect(terminalContents(restored.terminal)).toContain('BASE');
    expect(terminalContents(restored.terminal)).not.toContain('ALT');
    expect(restored.terminal.modes.applicationCursorKeysMode).toBe(false);
    expect(restored.terminal.modes.sendFocusMode).toBe(false);
    restored.terminal.dispose();

    child.stdin.write(`${JSON.stringify({
      cols: 72,
      generation: 1,
      journalPosition: 2,
      rows: 18,
      sessionId: 'worker-test',
      type: 'resize',
    })}\n`);
    const checkpointPromise = new Promise<Record<string, unknown>>((resolve) => {
      resolveCheckpoint = resolve;
    });
    for (let seq = 2; seq <= 256; seq += 1) {
      child.stdin.write(`${JSON.stringify({
        dataBase64: Buffer.from(seq === 256 ? 'checkpoint-geometry' : '.').toString('base64'),
        generation: 1,
        journalPosition: seq + 1,
        seq,
        sessionId: 'worker-test',
        type: 'output',
      })}\n`);
    }
    const checkpoint = await checkpointPromise;
    expect(checkpoint.cols).toBe(72);
    expect(checkpoint.rows).toBe(18);
    expect(checkpoint.journalPosition).toBe(257);

    await request({ generation: 1, id: 3, sessionId: 'worker-test', type: 'drop' });
    await request({ cols: 40, generation: 1, id: 4, rows: 10, sessionId: 'worker-test', type: 'create' });
    child.stdin.write(`${JSON.stringify({
      cols: checkpoint.cols,
      dataBase64: checkpoint.dataBase64,
      encoding: checkpoint.encoding,
      generation: 1,
      journalPosition: checkpoint.journalPosition,
      rows: checkpoint.rows,
      sessionId: 'worker-test',
      throughSeq: checkpoint.throughSeq,
      type: 'restore',
    })}\n`);
    const restoredCheckpoint = await request({
      generation: 1,
      id: 5,
      sessionId: 'worker-test',
      type: 'snapshot',
    });
    expect(restoredCheckpoint.cols).toBe(72);
    expect(restoredCheckpoint.rows).toBe(18);
    expect(
      gunzipSync(Buffer.from(String(restoredCheckpoint.dataBase64), 'base64')).toString('utf8'),
    ).toContain('checkpoint-geometry');
  } finally {
    lines.close();
    child.kill();
  }
});

function createTerminal(cols: number, rows: number) {
  const terminal = new Terminal({ allowProposedApi: true, cols, rows, scrollback: 100 });
  const unicode = new Unicode11Addon();
  terminal.loadAddon(unicode);
  terminal.unicode.activeVersion = '11';
  const serializer = new SerializeAddon();
  terminal.loadAddon(serializer);
  return { serializer, terminal };
}

function write(terminal: HeadlessTerminal, data: string) {
  return new Promise<void>((resolve) => terminal.write(data, resolve));
}

function terminalContents(terminal: HeadlessTerminal) {
  const buffer = terminal.buffer.active;
  const lines: string[] = [];
  for (let index = 0; index < buffer.length; index += 1) {
    lines.push(buffer.getLine(index)?.translateToString(true) ?? '');
  }
  return lines.join('\n');
}
