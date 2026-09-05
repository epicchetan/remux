import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

import { createCheckoutResolver, resolveCheckout } from '../server/src/native-runtime/checkout-resolver.ts';

const exec = promisify(execFile);

test('checkout resolver canonicalizes real Git worktrees while retaining requested launch cwd', async () => {
  const root = await mkdtemp(join(tmpdir(), 'remux checkout '));
  try {
    const repo = join(root, 'repo with spaces');
    const sub = join(repo, '..notes');
    const alias = join(root, 'alias');
    const linked = join(root, 'linked worktree');
    await mkdir(sub, { recursive: true });
    await exec('git', ['init', repo]);
    await exec('git', ['-C', repo, 'config', 'user.email', 'fixture@example.invalid']);
    await exec('git', ['-C', repo, 'config', 'user.name', 'Fixture']);
    await exec('git', ['-C', repo, 'commit', '--allow-empty', '-m', 'fixture']);
    await symlink(sub, alias);
    await exec('git', ['-C', repo, 'worktree', 'add', '--detach', linked]);
    const [top, nested, aliased, other] = await Promise.all([
      resolveCheckout(repo), resolveCheckout(sub), resolveCheckout(alias), resolveCheckout(linked),
    ]);
    assert.equal(top.state, 'resolved');
    assert.equal(nested.state, 'resolved');
    assert.equal(aliased.state, 'resolved');
    assert.equal(other.state, 'resolved');
    if (top.state !== 'resolved' || nested.state !== 'resolved' ||
        aliased.state !== 'resolved' || other.state !== 'resolved') return;
    assert.equal(nested.value.checkoutKey, top.value.checkoutKey);
    assert.equal(aliased.value.checkoutKey, top.value.checkoutKey);
    assert.equal(nested.value.launchCwd, await realpath(sub));
    assert.equal(aliased.value.launchCwd, await realpath(alias));
    assert.notEqual(other.value.checkoutKey, top.value.checkoutKey);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('checkout resolver does not classify timed out not-repository stderr as non-Git', async () => {
  const resolver = createCheckoutResolver({
    realpath: async (path) => String(path),
    git: async () => {
      throw Object.assign(new Error('timed out'), {
        code: 128,
        killed: true,
        signal: 'SIGTERM',
        stderr: 'fatal: not a git repository (or any of the parent directories): .git',
      });
    },
  });
  assert.deepEqual(await resolver('/bounded/path'), { state: 'indeterminate', reason: 'timed out' });
});

test('checkout resolver uses real non-Git roots and rejects missing paths', async () => {
  const root = await mkdtemp(join(tmpdir(), 'remux-nongit-'));
  const alias = `${root}-alias`;
  try {
    await symlink(root, alias);
    const [direct, aliased, missing] = await Promise.all([
      resolveCheckout(root), resolveCheckout(alias), resolveCheckout(join(root, 'missing')),
    ]);
    assert.equal(direct.state, 'resolved');
    assert.equal(aliased.state, 'resolved');
    if (direct.state === 'resolved' && aliased.state === 'resolved') {
      assert.equal(direct.value.checkoutKey, aliased.value.checkoutKey);
      assert.match(direct.value.checkoutKey, /^non-git:/u);
    }
    assert.equal(missing.state, 'indeterminate');
  } finally {
    await rm(alias, { force: true });
    await rm(root, { recursive: true, force: true });
  }
});
