import {describe, test} from 'node:test';
import assert from 'node:assert/strict';
import {app, resetStore} from '../server.mjs';

function listen() {
  return new Promise((resolve) => {
    const server = app.listen(0, () => resolve({server, port: server.address().port}));
  });
}

async function api(port, path, options = {}) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, options);
  const body = await res.json().catch(() => null);
  return {status: res.status, headers: res.headers, body};
}

// 所有用例共享 server.mjs 的内存存储且会 PUT/DELETE，必须串行。
describe('http range protocol', {concurrency: false}, () => {
  let server;
  let port;

  test.beforeEach(async () => {
    resetStore();
    const l = await listen();
    server = l.server;
    port = l.port;
  });
  test.afterEach(() => new Promise((resolve) => server.close(resolve)));

  test('range endpoint returns 206 with version, exact bounds and checksum observable in headers', async () => {
    const r = await api(port, '/api/resources/sample/range?start=400&end=500');
    assert.equal(r.status, 206);
    assert.equal(r.headers.get('content-range'), 'bytes 400-499/1000');
    assert.equal(r.headers.get('x-resource-id'), 'sample');
    assert.equal(r.headers.get('x-resource-version'), '1');
    assert.equal(r.headers.get('x-range-start'), '400');
    assert.equal(r.headers.get('x-range-end'), '500');
    assert.equal(r.headers.get('x-range-satisfied'), 'true');
    assert.match(r.headers.get('x-fragment-checksum') ?? '', /^[0-9a-f]{64}$/);
    assert.equal(r.headers.get('accept-ranges'), 'bytes');
    assert.equal(r.body.id, 'sample');
    assert.equal(r.body.version, 1);
    assert.equal(Buffer.from(r.body.bytes, 'base64').length, 100);
    assert.equal(r.body.checksum, r.headers.get('x-fragment-checksum'));
  });

  test('partial range clamps at resource end and still reports actual returned bounds', async () => {
    const r = await api(port, '/api/resources/sample/range?start=990&end=1200');
    assert.equal(r.status, 206);
    assert.deepEqual([r.body.start, r.body.end], [990, 1000]);
    assert.equal(r.headers.get('content-range'), 'bytes 990-999/1000');
    assert.equal(Buffer.from(r.body.bytes, 'base64').length, 10);
  });

  test('update bumps version; conditional read of old version is 409, never silent new bytes', async () => {
    const before = await api(port, '/api/resources/sample/range?start=0&end=10');
    assert.equal(before.body.version, 1);
    const put = await api(port, '/api/resources/sample', {method: 'PUT', body: 'changed-content'});
    assert.equal(put.status, 201);
    assert.equal(put.body.version, 2);

    const conflict = await api(port, '/api/resources/sample/range?start=0&end=10&version=1');
    assert.equal(conflict.status, 409);
    assert.equal(conflict.body.type, 'VersionConflictError');
    assert.equal(conflict.body.expectedVersion, 1);
    assert.equal(conflict.body.currentVersion, 2);
    assert.equal(conflict.body.bytes, undefined, '409 不携带任何字节，无法被伪装成内容');

    const latest = await api(port, '/api/resources/sample/range?start=0&end=10&version=2');
    assert.equal(latest.status, 206);
    assert.equal(latest.body.version, 2);
  });

  test('delete yields 404 for range reads; re-created resource restarts at version 1', async () => {
    const del = await api(port, '/api/resources/sample', {method: 'DELETE'});
    assert.equal(del.status, 200);
    const missing = await api(port, '/api/resources/sample/range?start=0&end=10');
    assert.equal(missing.status, 404);
    assert.equal(missing.body.bytes, undefined, '404 must not carry a fake empty fragment');
    const fullMissing = await api(port, '/api/resources/sample');
    assert.equal(fullMissing.status, 404);
    const put = await api(port, '/api/resources/sample', {method: 'PUT', body: 'new'});
    assert.equal(put.body.version, 1);
    assert.equal(put.body.size, 3);
  });

  test('bad range is 400; fully out-of-range is 416 instead of an empty 200', async () => {
    const noEnd = await api(port, '/api/resources/sample/range?start=0');
    assert.equal(noEnd.status, 400);
    const inverted = await api(port, '/api/resources/sample/range?start=50&end=10');
    assert.equal(inverted.status, 400);
    const beyond = await api(port, '/api/resources/sample/range?start=5000&end=5100');
    assert.equal(beyond.status, 416);
    assert.equal(beyond.body.size, 1000);
    assert.equal(beyond.body.type, 'UnsatisfiableRangeError');
    assert.equal(beyond.headers.get('content-range'), 'bytes */1000');
    assert.equal(beyond.body.bytes, undefined, '416 用显式状态表达，不携带空字节');
  });

  test('legacy full read keeps working and carries whole-resource version + checksum', async () => {
    const full = await api(port, '/api/resources/sample');
    assert.equal(full.status, 200);
    assert.equal(full.body.complete, true);
    assert.equal(full.body.size, 1000);
    assert.equal(Buffer.from(full.body.bytes, 'base64').length, 1000);
    assert.equal(full.headers.get('x-resource-version'), '1');
    assert.match(full.headers.get('x-fragment-checksum') ?? '', /^[0-9a-f]{64}$/);

    // 旧的带 start/end 的 GET 调用方式仍然可用
    const legacy = await api(port, '/api/resources/sample?start=4&end=12');
    assert.equal(legacy.status, 200);
    assert.deepEqual([legacy.body.start, legacy.body.end], [4, 12]);
    assert.equal(Buffer.from(legacy.body.bytes, 'base64').length, 8);
  });

  test('checksum distinguishes different bounds and is stable across identical reads', async () => {
    const a = await api(port, '/api/resources/sample/range?start=0&end=10&version=1');
    const b = await api(port, '/api/resources/sample/range?start=10&end=20&version=1');
    assert.notEqual(a.body.checksum, b.body.checksum);
    const a2 = await api(port, '/api/resources/sample/range?start=0&end=10&version=1');
    assert.equal(a.body.checksum, a2.body.checksum);
  });
});
