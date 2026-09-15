import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { MAX_WATCHED_CHANGES_PER_TURN, WorkspaceFileChanges, type WatchedFileChange } from '../server/src/providers/claude/workspace-file-changes.ts';

test('build artifact burst respects nested ignores, tracked ignored files, and per-turn coalescing', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'remux-watcher-'));
  const received: WatchedFileChange[] = [];
  const queue = new WorkspaceFileChanges(cwd, (batch) => received.push(...batch));
  const change = (path: string, turnId = 'turn-1'): WatchedFileChange => ({ path, turnId, nativeTurnId: turnId, kind: 'update' });
  try {
    execFileSync('git', ['init', '-q'], { cwd });
    await mkdir(join(cwd, 'src'));
    await writeFile(join(cwd, '.gitignore'), 'target/\n*.generated\n');
    await writeFile(join(cwd, 'src', '.gitignore'), 'cache/\n');
    await writeFile(join(cwd, 'tracked.generated'), 'tracked despite ignore');
    execFileSync('git', ['add', '-f', 'tracked.generated'], { cwd });
    let heartbeats = 0;
    const heartbeat = setInterval(() => heartbeats++, 1);
    try {
      for (let index = 0; index < 12_000; index++) await queue.add(change(`target/debug/${index}.o`));
      for (let index = 0; index < 100; index++) await queue.add(change('src/main.rs'));
      await queue.add(change('src/main.rs', 'turn-2'));
      await queue.add(change('tracked.generated'));
      await queue.add(change('src/cache/ignored'));
      await queue.add(change('../outside'));
      await queue.add(change('.git/index'));
      await queue.close();
    } finally { clearInterval(heartbeat); }
    assert.ok(heartbeats > 0, 'filtering leaves the event loop responsive');
    assert.deepEqual(received.map(({ path, turnId }) => [path, turnId]).sort(), [
      ['src/main.rs', 'turn-1'], ['src/main.rs', 'turn-2'], ['tracked.generated', 'turn-1'],
    ]);
  } finally { await queue.close(); await rm(cwd, { recursive: true, force: true }); }
});

test('non-Git workspaces retain edits and close drains pending changes', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'remux-watcher-nongit-'));
  const received: WatchedFileChange[] = [];
  const queue = new WorkspaceFileChanges(cwd, (batch) => received.push(...batch));
  try {
    await queue.add({ path: join(cwd, 'file.txt'), kind: 'delete', turnId: 'old-turn', nativeTurnId: 'native-old' });
    await queue.close();
    assert.deepEqual(received, [{ path: 'file.txt', kind: 'delete', turnId: 'old-turn', nativeTurnId: 'native-old' }]);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('a symlinked path never lets a build burst past the ignore check, and repeats are bounded per turn', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'remux-watcher-symlink-'));
  const received: WatchedFileChange[] = [];
  const queue = new WorkspaceFileChanges(cwd, (batch) => received.push(...batch));
  const change = (path: string, kind: WatchedFileChange['kind'] = 'update', turnId = 'turn-1'): WatchedFileChange =>
    ({ path, turnId, nativeTurnId: turnId, kind });
  try {
    execFileSync('git', ['init', '-q'], { cwd });
    await mkdir(join(cwd, 'extensions', 'agent', 'src'), { recursive: true });
    await mkdir(join(cwd, 'node_modules', '@remux'), { recursive: true });
    await symlink(join('..', '..', 'extensions', 'agent'), join(cwd, 'node_modules', '@remux', 'agent'));
    await writeFile(join(cwd, '.gitignore'), 'node_modules/\ndist/\n');
    await writeFile(join(cwd, 'extensions', 'agent', 'src', 'main.ts'), 'export {};');
    // One batch: the real edit, its symlinked twin, and a build burst.
    await queue.add(change('extensions/agent/src/main.ts'));
    await queue.add(change('node_modules/@remux/agent/src/main.ts'));
    for (let index = 0; index < 300; index++) await queue.add(change(`extensions/agent/dist/${index}.js`, 'add'));
    await queue.add(change('node_modules/@remux/agent/dist/gone.js', 'delete'));
    await queue.flush();
    // Later flushes repeat the same observation and add a genuinely new one.
    await queue.add(change('extensions/agent/src/main.ts'));
    await queue.flush();
    await queue.add(change('extensions/agent/src/main.ts', 'delete'));
    await queue.add(change('extensions/agent/src/main.ts', 'delete', 'turn-2'));
    await queue.close();
    assert.deepEqual(received.map(({ path, kind, turnId }) => [path, kind, turnId]), [
      ['extensions/agent/src/main.ts', 'update', 'turn-1'],
      ['extensions/agent/src/main.ts', 'delete', 'turn-1'],
      ['extensions/agent/src/main.ts', 'delete', 'turn-2'],
    ]);
  } finally { await queue.close(); await rm(cwd, { recursive: true, force: true }); }
});

test('a turn stops reporting new files past the per-turn bound', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'remux-watcher-bound-'));
  const received: WatchedFileChange[] = [];
  const queue = new WorkspaceFileChanges(cwd, (batch) => received.push(...batch), async () => new Set());
  try {
    for (let index = 0; index < MAX_WATCHED_CHANGES_PER_TURN + 50; index++) {
      await queue.add({ path: `generated/${index}.txt`, kind: 'add', turnId: 'turn-1', nativeTurnId: 'turn-1' });
    }
    await queue.add({ path: 'generated/0.txt', kind: 'delete', turnId: 'turn-1', nativeTurnId: 'turn-1' });
    await queue.add({ path: 'generated/new.txt', kind: 'add', turnId: 'turn-2', nativeTurnId: 'turn-2' });
    await queue.close();
    assert.equal(received.filter(({ turnId }) => turnId === 'turn-1').length, MAX_WATCHED_CHANGES_PER_TURN + 1);
    assert.deepEqual(received.at(-1), { path: 'generated/new.txt', kind: 'add', turnId: 'turn-2', nativeTurnId: 'turn-2' });
  } finally { await rm(cwd, { recursive: true, force: true }); }
});
