import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createResourceStore,
  putResource,
  deleteResource,
  readRange,
  readFull,
  fragmentChecksum,
  VersionConflictError,
  InvalidRangeError,
  ResourceNotFoundError,
} from '../src/resource-store.mjs';

test('range response carries a version and exact byte bounds', async () => {
  const store = putResource(createResourceStore(), 'r', Buffer.from('abcdef'));
  const result = await readRange(store, 'r', 1, 4);
  assert.equal(result.version, 1);
  assert.equal(Buffer.from(result.bytes, 'base64').toString(), 'bcd');
  assert.deepEqual([result.start, result.end], [1, 4]);
  assert.equal(result.size, 6);
  assert.equal(result.satisfied, true);
});

test('missing resource cannot be mistaken for an empty range', async () => {
  await assert.rejects(() => readRange(createResourceStore(), 'missing', 0, 1), (e) => e instanceof ResourceNotFoundError);
});

test('updating bumps the version and keeps the old content distinguishable', async () => {
  let store = putResource(createResourceStore(), 'r', Buffer.from('abcdef'));
  const v1 = await readRange(store, 'r', 0, 3);
  assert.equal(v1.version, 1);
  store = putResource(store, 'r', Buffer.from('abcXYZ'));
  const v2 = await readRange(store, 'r', 0, 6);
  assert.equal(v2.version, 2);
  assert.notEqual(v1.checksum, v2.checksum);
  assert.notEqual(v1.version, v2.version);
});

test('expected version conflicts instead of silently returning new bytes', async () => {
  let store = putResource(createResourceStore(), 'r', Buffer.from('abcdef'));
  store = putResource(store, 'r', Buffer.from('ABCDEF'));
  await assert.rejects(
    () => readRange(store, 'r', 0, 3, 1),
    (e) => e instanceof VersionConflictError && e.expected === 1 && e.actual === 2,
  );
  const pinned = await readRange(store, 'r', 0, 3, 2);
  assert.equal(Buffer.from(pinned.bytes, 'base64').toString(), 'ABC');
});

test('checksum binds id, version, bounds and bytes', async () => {
  const store = putResource(createResourceStore(), 'r', Buffer.from('abcdef'));
  const a = await readRange(store, 'r', 0, 3);
  const moved = await readRange(store, 'r', 1, 4);
  assert.notEqual(a.checksum, moved.checksum);
  const expected = await fragmentChecksum('r', 1, 0, 3, Buffer.from('abc'));
  assert.equal(a.checksum, expected);
  assert.notEqual(expected, await fragmentChecksum('r', 1, 0, 3, Buffer.from('abd')));
  assert.notEqual(expected, await fragmentChecksum('r', 2, 0, 3, Buffer.from('abc')));
});

test('invalid ranges throw; out-of-range ranges clamp to an unsatisfied empty window', async () => {
  const store = putResource(createResourceStore(), 'r', Buffer.from('abcdef'));
  await assert.rejects(() => readRange(store, 'r', 4, 2), InvalidRangeError);
  await assert.rejects(() => readRange(store, 'r', -1, 2), InvalidRangeError);
  await assert.rejects(() => readRange(store, 'r', 0, 'x'), InvalidRangeError);
  // 越界不伪造内容：交集为空时 satisfied=false、边界相等，由服务层映射为 416。
  const beyond = await readRange(store, 'r', 100, 110);
  assert.equal(beyond.satisfied, false);
  assert.deepEqual([beyond.start, beyond.end], [6, 6]);
});

test('delete removes content and version; re-put starts at version 1', async () => {
  let store = putResource(createResourceStore(), 'r', Buffer.from('abc'));
  store = putResource(store, 'r', Buffer.from('def'));
  assert.equal(store.versions.get('r'), 2);
  store = deleteResource(store, 'r');
  await assert.rejects(() => readRange(store, 'r', 0, 1), ResourceNotFoundError);
  assert.throws(() => deleteResource(store, 'r'), ResourceNotFoundError);
  store = putResource(store, 'r', Buffer.from('xyz'));
  assert.equal(store.versions.get('r'), 1);
});

test('an empty resource exists and is not a missing resource; full read keeps working', async () => {
  let store = putResource(createResourceStore(), 'r', Buffer.alloc(0));
  assert.equal(store.items.get('r').length, 0);
  const empty = await readRange(store, 'r', 0, 10);
  assert.equal(empty.satisfied, false);
  assert.deepEqual([empty.start, empty.end], [0, 0]);
  const full = await readFull(store, 'r');
  assert.equal(full.complete, true);
  assert.equal(full.size, 0);
  assert.equal(full.bytes, '');
});

test('full read carries whole-resource checksum and version', async () => {
  const store = putResource(createResourceStore(), 'r', Buffer.from('abcdef'));
  const full = await readFull(store, 'r');
  assert.equal(Buffer.from(full.bytes, 'base64').toString(), 'abcdef');
  assert.equal(full.checksum, await fragmentChecksum('r', 1, 0, 6, Buffer.from('abcdef')));
});
