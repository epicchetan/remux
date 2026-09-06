import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { migrateNarrateFileTabs } from '../src/browser/narrateTabMigration.ts';

const pending = {
  focusId: '42', focusKind: 'line', nonce: 'nav:1', resourceId: '/work/readme.md', resourceKind: 'file',
};
const tab = (overrides = {}) => ({
  extensionId: 'narrate', handlerId: 'narrate-viewer', id: 'narrate-1', lastActiveAt: 10,
  pendingNavigation: null, resourceId: '/work/readme.md', resourceKind: 'file', viewId: 'main',
  ...overrides,
});
const extension = (documentViewer = true) => ({
  display: { iconDarkUrl: null, iconUrl: null, title: 'Editor' },
  fileHandlers: documentViewer
    ? [{ extensionId: 'editor', extensions: ['md', 'markdown', 'mdown', 'html', 'htm'], iconDarkUrl: null, iconUrl: null, id: 'document-viewer', label: 'Viewer', view: 'main' }]
    : [{ extensionId: 'editor', extensions: ['*'], iconDarkUrl: null, iconUrl: null, id: 'text-editor', label: 'Editor', view: 'main' }],
  id: 'editor', launchers: [], name: 'Editor',
  views: { main: { entryUrl: '/viewer', hostChrome: 'none', revision: 'new', route: '/viewers/editor', url: 'https://host/viewers/editor' } },
});

const gated = migrateNarrateFileTabs([tab()], 'narrate-1', [extension(false)]);
assert.equal(gated.tabs[0].extensionId, 'narrate', 'an old Editor catalog must not migrate tabs');

const migrated = migrateNarrateFileTabs([tab({ pendingNavigation: pending })], 'narrate-1', [extension()]);
assert.deepEqual(migrated.tabs[0], tab({
  extensionId: 'editor', handlerId: 'document-viewer', pendingNavigation: pending,
}));
assert.equal(migrated.activeTabId, 'narrate-1');
assert.deepEqual([...migrated.migratedTabIds], ['narrate-1']);

const editorDuplicate = tab({
  extensionId: 'editor', handlerId: 'text-editor', id: 'editor-1', lastActiveAt: 20,
  resourceId: '/work/readme.md',
});
const deduped = migrateNarrateFileTabs([tab({ pendingNavigation: pending }), editorDuplicate], null, [extension()]);
assert.equal(deduped.tabs.length, 1);
assert.equal(deduped.tabs[0].id, 'editor-1', 'an existing Editor tab wins when neither duplicate is active');
assert.equal(deduped.tabs[0].pendingNavigation, pending, 'the surviving tab adopts an unconsumed line target');
assert.equal(deduped.tabs[0].handlerId, 'document-viewer');

const activeNarrate = migrateNarrateFileTabs([tab(), editorDuplicate], 'narrate-1', [extension()]);
assert.equal(activeNarrate.tabs.length, 1);
assert.equal(activeNarrate.tabs[0].id, 'narrate-1', 'the active duplicate wins');
assert.equal(activeNarrate.activeTabId, 'narrate-1');

const repeated = migrateNarrateFileTabs(migrated.tabs, migrated.activeTabId, [extension()]);
assert.deepEqual(repeated.tabs, migrated.tabs, 'migration is idempotent');
assert.equal(repeated.migratedTabIds.size, 0);

const storeSource = await readFile(new URL('../src/browser/browserStore.ts', import.meta.url), 'utf8');
assert.match(storeSource, /migrateNarrateFileTabs\(session\.tabs,[\s\S]*?rebuildBrowserTabs\(migrated\.tabs/u,
  'restore must migrate before unavailable extensions are filtered');
assert.match(storeSource, /migrateNarrateFileTabs\(state\.tabs,[\s\S]*?reconcileBrowserTabs\(/u,
  'live catalog refresh must migrate before reconciliation');

console.log(JSON.stringify({ activeSurvivor: true, catalogGate: true, deduplicated: true, idempotent: true, ok: true }));

const distinctPaths = migrateNarrateFileTabs([tab(), {...editorDuplicate, resourceId:'/work/docs/../readme.md'}], null, [extension()]);
assert.equal(distinctPaths.tabs.length, 2, 'lexical path cleanup must not merge symlink-sensitive identities');
const otherView = migrateNarrateFileTabs([tab({viewId:'other'})], null, [extension()]);
assert.equal(otherView.tabs[0].extensionId, 'narrate', 'only the retired main file view is migrated');
const otherEditorView = migrateNarrateFileTabs([tab(), {...editorDuplicate, viewId:'other'}], null, [extension()]);
assert.equal(otherEditorView.tabs.length, 2, 'different Editor views retain distinct resource identity');
