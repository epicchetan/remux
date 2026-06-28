const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { promisify } = require('node:util');

const { createFsCore } = require('../core/fs.cjs');

const execFileAsync = promisify(execFile);

test('remux fs core reads directories from the CLI root by default', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'remux-fs-'));
  await fs.mkdir(path.join(root, 'src'));
  await fs.writeFile(path.join(root, 'package.json'), '{}');

  const fsCore = createFsCore({ rootDir: root });
  const result = await fsCore.handleRpc({ method: 'remux/fs/readDirectory' });

  assert.equal(result.path, root);
  assert.equal(result.parentPath, path.dirname(root));
  assert.deepEqual(
    result.entries.map((entry) => ({
      kind: entry.kind,
      name: entry.name,
      path: entry.path,
      sizeBytes: entry.sizeBytes,
    })),
    [
      {
        kind: 'directory',
        name: 'src',
        path: path.join(root, 'src'),
        sizeBytes: null,
      },
      {
        kind: 'file',
        name: 'package.json',
        path: path.join(root, 'package.json'),
        sizeBytes: 2,
      },
    ],
  );
});

test('remux fs core reads requested absolute paths', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'remux-fs-'));
  const child = path.join(root, 'child');
  await fs.mkdir(child);
  await fs.writeFile(path.join(child, 'README.md'), '# hi');

  const fsCore = createFsCore({ rootDir: root });
  const result = await fsCore.handleRpc({
    method: 'remux/fs/readDirectory',
    params: { path: child },
  });

  assert.equal(result.path, child);
  assert.equal(result.parentPath, root);
  assert.equal(result.entries.length, 1);
  assert.equal(result.entries[0].name, 'README.md');
});

test('remux fs core batches directory reads with partial failures', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'remux-fs-batch-'));
  const first = path.join(root, 'first');
  const second = path.join(root, 'second');
  const missing = path.join(root, 'missing');
  await fs.mkdir(first);
  await fs.mkdir(second);
  await fs.writeFile(path.join(first, 'a.txt'), 'a');
  await fs.writeFile(path.join(second, 'b.txt'), 'b');

  const fsCore = createFsCore({ rootDir: root });
  const result = await fsCore.handleRpc({
    method: 'remux/fs/readDirectories',
    params: { paths: [first, missing, second] },
  });

  assert.equal(result.results.length, 3);
  assert.equal(result.results[0].ok, true);
  assert.equal(result.results[0].path, first);
  assert.equal(result.results[0].value.path, first);
  assert.deepEqual(result.results[0].value.entries.map((entry) => entry.name), ['a.txt']);
  assert.equal(result.results[1].ok, false);
  assert.equal(result.results[1].path, missing);
  assert.match(result.results[1].message, /Directory could not be read/u);
  assert.equal(result.results[2].ok, true);
  assert.equal(result.results[2].path, second);
  assert.deepEqual(result.results[2].value.entries.map((entry) => entry.name), ['b.txt']);
});

test('remux fs core caches repeated directory reads briefly', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'remux-fs-cache-'));
  await fs.writeFile(path.join(root, 'first.txt'), 'first');

  const fsCore = createFsCore({ rootDir: root });
  const first = await fsCore.handleRpc({ method: 'remux/fs/readDirectory' });
  await fs.writeFile(path.join(root, 'second.txt'), 'second');
  const second = await fsCore.handleRpc({ method: 'remux/fs/readDirectory' });
  const refreshed = await fsCore.handleRpc({
    method: 'remux/fs/readDirectory',
    params: { force: true },
  });

  assert.deepEqual(
    first.entries.map((entry) => entry.name),
    ['first.txt'],
  );
  assert.equal(typeof first.version, 'string');
  assert.deepEqual(
    second.entries.map((entry) => entry.name),
    ['first.txt'],
  );
  assert.deepEqual(
    refreshed.entries.map((entry) => entry.name),
    ['first.txt', 'second.txt'],
  );
  assert.notEqual(refreshed.version, first.version);
});

test('remux fs core annotates directory entries with git status', async (t) => {
  if (!await isGitAvailable()) {
    t.skip('git is not available');
    return;
  }

  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'remux-fs-git-'));
  const canonicalRoot = await fs.realpath(root);
  await fs.mkdir(path.join(root, 'nested'));
  await fs.writeFile(path.join(root, 'tracked.txt'), 'base\n');
  await fs.writeFile(path.join(root, 'nested', 'clean.txt'), 'base\n');

  await git(root, 'init');
  await git(root, 'config', 'user.email', 'remux@example.invalid');
  await git(root, 'config', 'user.name', 'Remux Test');
  await git(root, 'add', '.');
  await git(root, 'commit', '-m', 'initial');

  await fs.writeFile(path.join(root, 'tracked.txt'), 'changed\n');
  await fs.writeFile(path.join(root, 'loose.txt'), 'new\n');
  await fs.writeFile(path.join(root, 'staged.txt'), 'new\n');
  await fs.mkdir(path.join(root, 'nested', 'untracked'));
  await fs.writeFile(path.join(root, 'nested', 'untracked', 'child.txt'), 'new\n');
  await git(root, 'add', 'staged.txt');

  const fsCore = createFsCore({ rootDir: root });
  const result = await fsCore.handleRpc({ method: 'remux/fs/readDirectory' });
  const entries = new Map(result.entries.map((entry) => [entry.name, entry]));

  assert.deepEqual(entries.get('tracked.txt')?.git, {
    staged: false,
    status: 'modified',
  });
  assert.deepEqual(entries.get('loose.txt')?.git, {
    staged: false,
    status: 'untracked',
  });
  assert.deepEqual(entries.get('staged.txt')?.git, {
    staged: true,
    status: 'added',
  });
  assert.deepEqual(entries.get('nested')?.git, {
    staged: false,
    status: 'untracked',
  });

  const trackedFile = await fsCore.handleRpc({
    method: 'remux/fs/readFile',
    params: {
      git: { includeBase: true, includeStatus: true },
      path: path.join(root, 'tracked.txt'),
    },
  });
  assert.equal(trackedFile.content, 'changed\n');
  assert.equal(trackedFile.git.status, 'modified');
  assert.equal(trackedFile.git.repoRoot, canonicalRoot);
  assert.equal(trackedFile.git.base.status, 'modified');
  assert.equal(trackedFile.git.base.content, 'base\n');
  assert.equal(trackedFile.git.base.encoding, 'utf8');
  assert.equal(trackedFile.git.base.isBinary, false);
  assert.equal(trackedFile.git.base.tooLarge, false);

  const stagedFile = await fsCore.handleRpc({
    method: 'remux/fs/readFile',
    params: {
      git: { includeBase: true, includeStatus: true },
      path: path.join(root, 'staged.txt'),
    },
  });
  assert.equal(stagedFile.content, 'new\n');
  assert.equal(stagedFile.git.status, 'added');
  assert.equal(stagedFile.git.base.status, 'added');
  assert.equal(stagedFile.git.base.content, '');
  assert.equal(stagedFile.git.base.encoding, 'utf8');

  const untrackedFile = await fsCore.handleRpc({
    method: 'remux/fs/readFile',
    params: {
      git: { includeBase: true, includeStatus: true },
      path: path.join(root, 'loose.txt'),
    },
  });
  assert.equal(untrackedFile.content, 'new\n');
  assert.equal(untrackedFile.git.status, 'untracked');
  assert.equal(untrackedFile.git.base.status, 'untracked');
  assert.equal(untrackedFile.git.base.content, '');
  assert.equal(untrackedFile.git.base.encoding, 'utf8');
});

test('remux fs core reports git status for large untracked file reads', async (t) => {
  if (!await isGitAvailable()) {
    t.skip('git is not available');
    return;
  }

  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'remux-fs-git-large-'));
  const filePath = path.join(root, 'large.txt');
  await git(root, 'init');
  await fs.writeFile(filePath, `${'x'.repeat(300 * 1024)}\n`);

  const fsCore = createFsCore({ rootDir: root });
  const result = await fsCore.handleRpc({
    method: 'remux/fs/readFile',
    params: {
      git: { includeBase: true, includeStatus: true },
      path: filePath,
    },
  });

  assert.equal(result.tooLarge, false);
  assert.equal(result.git.status, 'untracked');
  assert.equal(result.git.base.content, '');
  assert.equal(result.git.base.status, 'untracked');
});

test('remux fs core reads utf8 file content', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'remux-fs-'));
  const filePath = path.join(root, 'README.md');
  await fs.writeFile(filePath, '# hello\n');

  const fsCore = createFsCore({ rootDir: root });
  const result = await fsCore.handleRpc({
    method: 'remux/fs/readFile',
    params: { path: 'README.md' },
  });

  assert.equal(result.path, filePath);
  assert.equal(result.name, 'README.md');
  assert.equal(result.content, '# hello\n');
  assert.equal(result.encoding, 'utf8');
  assert.equal(result.isBinary, false);
  assert.equal(result.sizeBytes, 8);
  assert.equal(result.tooLarge, false);
  assert.equal(typeof result.modifiedAtMs, 'number');
});

test('remux fs core reads file content as base64 when requested', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'remux-fs-base64-'));
  const filePath = path.join(root, 'image.png');
  const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]);
  await fs.writeFile(filePath, bytes);

  const fsCore = createFsCore({ rootDir: root });
  const result = await fsCore.handleRpc({
    method: 'remux/fs/readFile',
    params: {
      format: 'base64',
      path: 'image.png',
    },
  });

  assert.equal(result.path, filePath);
  assert.equal(result.name, 'image.png');
  assert.equal(result.content, null);
  assert.equal(result.dataBase64, bytes.toString('base64'));
  assert.equal(result.encoding, 'base64');
  assert.equal(result.isBinary, true);
  assert.equal(result.mimeType, 'image/png');
  assert.equal(result.sizeBytes, bytes.length);
  assert.equal(result.tooLarge, false);
});

async function isGitAvailable() {
  try {
    await execFileAsync('git', ['--version'], {
      encoding: 'utf8',
      windowsHide: true,
    });
    return true;
  } catch {
    return false;
  }
}

async function git(cwd, ...args) {
  await execFileAsync('git', args, {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
  });
}

test('remux fs core does not return binary file content', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'remux-fs-'));
  const filePath = path.join(root, 'image.bin');
  await fs.writeFile(filePath, Buffer.from([0x00, 0x01, 0x02, 0x03]));

  const fsCore = createFsCore({ rootDir: root });
  const result = await fsCore.handleRpc({
    method: 'remux/fs/readFile',
    params: { path: filePath },
  });

  assert.equal(result.path, filePath);
  assert.equal(result.content, null);
  assert.equal(result.encoding, null);
  assert.equal(result.isBinary, true);
  assert.equal(result.sizeBytes, 4);
  assert.equal(result.tooLarge, false);
});

test('remux fs core does not return oversized file content', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'remux-fs-'));
  const filePath = path.join(root, 'large.txt');
  await fs.writeFile(filePath, Buffer.alloc((1024 * 1024) + 1, 'a'));

  const fsCore = createFsCore({ rootDir: root });
  const result = await fsCore.handleRpc({
    method: 'remux/fs/readFile',
    params: { path: filePath },
  });

  assert.equal(result.path, filePath);
  assert.equal(result.content, null);
  assert.equal(result.encoding, null);
  assert.equal(result.isBinary, false);
  assert.equal(result.sizeBytes, (1024 * 1024) + 1);
  assert.equal(result.tooLarge, true);
});
