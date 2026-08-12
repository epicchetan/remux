import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const packageRoot = resolve(import.meta.dirname, '..');
const sourceRoot = resolve(packageRoot, 'server/prompts');
const distRoot = resolve(packageRoot, 'server/dist');

for (const fileName of ['system.md', 'work-unit.md']) {
  const [source, built] = await Promise.all([
    readFile(resolve(sourceRoot, fileName), 'utf8'),
    readFile(resolve(distRoot, fileName), 'utf8'),
  ]);
  assert.equal(built, source, `Built ${fileName} differs from the repository-owned prompt.`);
}

const assetsRoot = resolve(distRoot, 'assets');
const promptAsset = (await readdir(assetsRoot)).find((fileName) => fileName.startsWith('prompts-'));
assert.ok(promptAsset, 'The server build did not emit its prompt-loading module.');
const builtModule = await import(pathToFileURL(resolve(assetsRoot, promptAsset)).href);
assert.ok(
  Object.values(builtModule).some((value) =>
    typeof value === 'string' && value.startsWith('You are Remux Agent')),
  'The built server could not load the repository-owned system prompt.',
);

process.stdout.write('Built Agent prompts verified.\n');
