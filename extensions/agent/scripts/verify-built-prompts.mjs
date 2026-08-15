import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';

const packageRoot = resolve(import.meta.dirname, '..');
const sourceRoot = resolve(packageRoot, 'server/prompts');
const distRoot = resolve(packageRoot, 'server/dist');

for (const fileName of ['system.md']) {
  const [source, built] = await Promise.all([
    readFile(resolve(sourceRoot, fileName), 'utf8'),
    readFile(resolve(distRoot, fileName), 'utf8'),
  ]);
  assert.equal(built, source, `Built ${fileName} differs from the repository-owned prompt.`);
}

const assetsRoot = resolve(distRoot, 'assets');
const assetNames = await readdir(assetsRoot);
const builtSources = await Promise.all(assetNames.map((fileName) =>
  readFile(resolve(assetsRoot, fileName), 'utf8')));
assert.ok(
  builtSources.some((source) => source.includes('readPrompt("system.md")') || source.includes("readPrompt('system.md')")),
  'The server build did not retain the repository-owned system prompt loader.',
);

process.stdout.write('Built Agent prompts verified.\n');
