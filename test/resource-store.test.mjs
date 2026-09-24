import test from 'node:test';
import assert from 'node:assert/strict';
import {createResourceStore, putResource, readRange} from '../src/resource-store.mjs';
test('range response carries a version and exact byte bounds', () => { let store = putResource(createResourceStore(), 'r', Buffer.from('abcdef')); const result = readRange(store, 'r', 1, 4); assert.equal(result.version, 1); assert.equal(Buffer.from(result.bytes, 'base64').toString(), 'bcd'); assert.deepEqual([result.start, result.end], [1, 4]); });
test('missing resource cannot be mistaken for an empty range', () => { assert.throws(() => readRange(createResourceStore(), 'missing', 0, 1), /not found/); });
