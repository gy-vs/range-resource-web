import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {
  createResourceStore,
  putResource,
  deleteResource,
  readRange,
  readRangeStrict,
  getResourceInfo,
  ResourceNotFoundError,
  InvalidRangeError,
  VersionConflictError,
} from '../src/resource-store.mjs';

const sha = (b) => createHash('sha256').update(b).digest('hex');

test('range response carries a version and exact byte bounds', () => {
  let store = putResource(createResourceStore(), 'r', Buffer.from('abcdef'));
  const result = readRange(store, 'r', 1, 4);
  assert.equal(result.version, 1);
  assert.equal(Buffer.from(result.bytes, 'base64').toString(), 'bcd');
  assert.deepEqual([result.start, result.end], [1, 4]);
});

test('missing resource cannot be mistaken for an empty range', () => {
  assert.throws(() => readRange(createResourceStore(), 'missing', 0, 1), /not found/);
});

test('strict fragment envelope reports actual returned bounds, size, digests', () => {
  let store = putResource(createResourceStore(), 'r', Buffer.from('abcdef'));
  const frag = readRangeStrict(store, 'r', {start: 2, end: 5});
  assert.equal(frag.type, 'range-fragment');
  assert.deepEqual([frag.start, frag.end, frag.size], [2, 5, 6]);
  assert.equal(Buffer.from(frag.bytes, 'base64').toString(), 'cde');
  assert.equal(frag.digest, sha(Buffer.from('cde')));
  assert.equal(frag.contentDigest, sha(Buffer.from('abcdef')));
  assert.equal(frag.version, 1);
});

test('strict fragment digest changes when the bytes change, content digest ties versions', () => {
  let v1 = putResource(createResourceStore(), 'r', Buffer.from('abcdef'));
  const f1 = readRangeStrict(v1, 'r', {start: 0, end: 6});
  let v2 = putResource(v1, 'r', Buffer.from('abcXYZ'));
  const f2 = readRangeStrict(v2, 'r', {start: 0, end: 6});
  assert.notEqual(f1.digest, f2.digest);
  assert.notEqual(f1.contentDigest, f2.contentDigest);
  assert.equal(f2.version, 2);
  // The overlapping prefix bytes themselves agree…
  const samePrefix = readRangeStrict(v2, 'r', {start: 0, end: 3});
  assert.equal(Buffer.from(samePrefix.bytes, 'base64').toString(), 'abc');
});

test('PUT bumps version monotonically and DELETE removes all traces', () => {
  let store = putResource(createResourceStore(), 'r', Buffer.from('a'));
  store = putResource(store, 'r', Buffer.from('ab'));
  store = putResource(store, 'r', Buffer.from('abc'));
  assert.equal(getResourceInfo(store, 'r').version, 3);
  store = deleteResource(store, 'r');
  assert.throws(() => getResourceInfo(store, 'r'), ResourceNotFoundError);
  assert.throws(() => readRangeStrict(store, 'r', {start: 0, end: 1}), ResourceNotFoundError);
  assert.throws(() => deleteResource(store, 'r'), ResourceNotFoundError);
  // Re-created resource starts back at version 1 — a deleted id can never
  // masquerade as its old self.
  store = putResource(store, 'r', Buffer.from('new'));
  assert.equal(getResourceInfo(store, 'r').version, 1);
});

test('malformed bounds are rejected, not clamped, by the strict protocol', () => {
  let store = putResource(createResourceStore(), 'r', Buffer.from('abcdef'));
  assert.throws(() => readRangeStrict(store, 'r', {start: 1.5, end: 3}), InvalidRangeError);
  assert.throws(() => readRangeStrict(store, 'r', {start: 'x', end: 3}), InvalidRangeError);
  assert.throws(() => readRangeStrict(store, 'r', {start: -1, end: 3}), InvalidRangeError);
  assert.throws(() => readRangeStrict(store, 'r', {start: 4, end: 2}), InvalidRangeError);
  // Past-end is an unsatisfiable range distinct from missing resource.
  assert.throws(() => readRangeStrict(store, 'r', {start: 0, end: 99}), InvalidRangeError);
});

test('expectedVersion pins the read: update yields VersionConflict with current info', () => {
  let store = putResource(createResourceStore(), 'r', Buffer.from('abcdef'));
  store = putResource(store, 'r', Buffer.from('abcdefghij'));
  try {
    readRangeStrict(store, 'r', {start: 0, end: 3, expectedVersion: 1});
    assert.fail('expected conflict');
  } catch (error) {
    assert.ok(error instanceof VersionConflictError);
    assert.equal(error.expected, 1);
    assert.equal(error.actual, 2);
    assert.equal(error.size, 10);
    assert.equal(error.contentDigest, sha(Buffer.from('abcdefghij')));
  }
  // Same-version pin succeeds.
  const frag = readRangeStrict(store, 'r', {start: 1, end: 4, expectedVersion: 2});
  assert.equal(Buffer.from(frag.bytes, 'base64').toString(), 'bcd');
});

test('legacy loose read still clamps and keeps working', () => {
  let store = putResource(createResourceStore(), 'r', Buffer.from('abcdef'));
  const loose = readRange(store, 'r', -5, 99);
  assert.deepEqual([loose.start, loose.end], [0, 6]);
  assert.equal(loose.version, 1);
});
