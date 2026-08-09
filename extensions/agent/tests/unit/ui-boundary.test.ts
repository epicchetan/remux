import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { extname, join } from 'node:path';
import { test } from '@playwright/test';

test('Agent source does not import Codex or narration implementations', () => {
  const source = sourceText([
    new URL('../../viewer/src/', import.meta.url),
    new URL('../../server/src/', import.meta.url),
    new URL('../../shared/', import.meta.url),
  ]);

  assert.doesNotMatch(source, /(?:@remux\/codex|extensions\/codex|@remux\/narration-client|narration-client)/u);
  assert.doesNotMatch(source, /remux\/codex\//u);
  assert.doesNotMatch(source, /codex-app-server|app-server-protocol/u);
});

test('the temporary flat transcript resource model stays removed', () => {
  const protocol = readFileSync(new URL('../../shared/protocol.ts', import.meta.url), 'utf8');
  const server = sourceText([new URL('../../server/src/', import.meta.url)]);

  assert.doesNotMatch(protocol, /type\s+Transcript(?:Item|Value)\b/u);
  assert.doesNotMatch(protocol, /transcript:\s*\(conversationId/u);
  assert.doesNotMatch(server, /flatTranscript|legacyTranscript|transcriptItems/u);
});

test('the Agent composer owns the applicable interaction surface without Codex-only modes', () => {
  const root = new URL('../../', import.meta.url);
  const packageJson = JSON.parse(readFileSync(new URL('package.json', root), 'utf8')) as {
    dependencies: Record<string, string>;
  };
  const forbiddenDependencies = ['@remux/codex', '@remux/narration-client'];
  for (const dependency of forbiddenDependencies) {
    assert.equal(packageJson.dependencies[dependency], undefined);
  }
  assert.ok(packageJson.dependencies.lexical);
  assert.ok(packageJson.dependencies['@lexical/react']);

  const composerRoot = new URL('viewer/src/composer/', root);
  for (const name of ['attachments', 'edit', 'mentions', 'queue']) {
    assert.equal(existsSync(new URL(`${name}/`, composerRoot)), true, `${name} must be Agent-owned`);
  }
  for (const name of ['editor/commands.ts', 'editor/nodes.tsx']) {
    assert.equal(existsSync(new URL(name, composerRoot)), true, `${name} must support structured input`);
  }

  const source = sourceText([new URL('viewer/src/', root)]);
  assert.doesNotMatch(source, /reviewMode|auto-review|compactThread|NarrationBar|NarrationPlayback/u);
});

function sourceText(roots: URL[]) {
  return roots.flatMap((root) => filesUnder(root.pathname)).map((path) => readFileSync(path, 'utf8')).join('\n');
}

function filesUnder(path: string): string[] {
  return readdirSync(path, { withFileTypes: true }).flatMap((entry) => {
    const child = join(path, entry.name);
    if (entry.isDirectory()) return filesUnder(child);
    return ['.ts', '.tsx'].includes(extname(entry.name)) ? [child] : [];
  });
}
