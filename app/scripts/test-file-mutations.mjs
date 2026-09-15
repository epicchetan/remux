import assert from 'node:assert/strict';

import {
  isValidEntryName,
  joinPath,
  mutationErrorKind,
  parentPath,
} from '../src/files/fileMutations.ts';
import {
  rawFileUploadUrl,
  uploadResultForStatus,
} from '../src/files/fileUploadResult.ts';

assert.equal(joinPath('/home/user', 'notes.md'), '/home/user/notes.md');
assert.equal(joinPath('/home/user/', 'notes.md'), '/home/user/notes.md');
assert.equal(joinPath('/', 'notes.md'), '/notes.md');
assert.equal(joinPath('/a//', 'b'), '/a/b');

assert.equal(parentPath('/home/user/notes.md'), '/home/user');
assert.equal(parentPath('/home/user/'), '/home');
assert.equal(parentPath('/home'), '/');
assert.equal(parentPath('/'), '/');

for (const name of ['notes.md', '.gitignore', 'a b', 'x..y', '...']) {
  assert.ok(isValidEntryName(name), `expected a valid entry name: ${JSON.stringify(name)}`);
}
for (const name of ['', '.', '..', 'a/b', '/', 'a\u0000b']) {
  assert.ok(!isValidEntryName(name), `expected an invalid entry name: ${JSON.stringify(name)}`);
}

assert.equal(mutationErrorKind(Object.assign(new Error('x'), { data: { kind: 'notEmpty' } })), 'notEmpty');
assert.equal(mutationErrorKind(Object.assign(new Error('x'), { data: { kind: '' } })), null);
assert.equal(mutationErrorKind(Object.assign(new Error('x'), { data: 'notEmpty' })), null);
assert.equal(mutationErrorKind(new Error('x')), null);
assert.equal(mutationErrorKind(null), null);

assert.equal(
  rawFileUploadUrl('http://remux.local:4000/', joinPath('/home/user/my docs', 'a&b.png')),
  'http://remux.local:4000/remux/fs/raw?path=%2Fhome%2Fuser%2Fmy%20docs%2Fa%26b.png',
);
assert.equal(
  rawFileUploadUrl('http://remux.local:4000', joinPath('/tmp', 'a.png'), { overwrite: true }),
  'http://remux.local:4000/remux/fs/raw?path=%2Ftmp%2Fa.png&overwrite=1',
);

assert.deepEqual(uploadResultForStatus(201, '{}'), { status: 'created' });
assert.deepEqual(uploadResultForStatus(200, '{}'), { status: 'replaced' });
assert.deepEqual(uploadResultForStatus(409, '{"error":"Target exists"}'), { status: 'conflict' });
assert.deepEqual(uploadResultForStatus(413, '{"error":"Too large"}'), { status: 'tooLarge' });
assert.deepEqual(uploadResultForStatus(500, '{"error":"Disk failed"}'), {
  reason: 'Disk failed',
  status: 'failed',
});
assert.deepEqual(uploadResultForStatus(502, '<html>bad gateway</html>'), {
  reason: 'Upload failed (502)',
  status: 'failed',
});
assert.deepEqual(uploadResultForStatus(401, ''), {
  reason: 'Upload failed (401)',
  status: 'failed',
});

process.stdout.write(
  `${JSON.stringify({
    ok: true, entryNames: true, pathHelpers: true, uploadStatusMapping: true,
  })}\n`,
);
