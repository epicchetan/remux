import { existsSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const configured = process.env.REMUX_LINKED_VIEWERS
  ?.split(delimiter)
  .map((candidate) => candidate.trim())
  .filter(Boolean);
const viewers = configured?.length
  ? configured.map((candidate) => resolve(candidate))
  : [resolve(repositoryRoot, '../ledger/lens')];

for (const viewer of viewers) {
  const config = join(viewer, 'tsconfig.app.json');
  if (!existsSync(config)) {
    continue;
  }
  const tsc = join(viewer, 'node_modules/.bin/tsc');
  if (!existsSync(tsc)) {
    throw new Error(`linked viewer dependencies are missing: ${viewer}`);
  }
  const buildInfo = join(tmpdir(), `remux-linked-viewer-${process.pid}.tsbuildinfo`);
  const result = spawnSync(
    tsc,
    ['-p', config, '--noEmit', '--tsBuildInfoFile', buildInfo],
    { cwd: viewer, stdio: 'inherit' },
  );
  if (existsSync(buildInfo)) {
    unlinkSync(buildInfo);
  }
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}
