import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {once} from 'node:events';
import {app} from '../server.mjs';

const sha = (b) => createHash('sha256').update(Buffer.from(b)).digest('hex');

const server = app.listen(0);
await once(server, 'listening');
const port = server.address().port;
const base = `http://localhost:${port}`;

test.after(() => server.close());

const api = (path, init) => fetch(`${base}${path}`, init);
const rid = `http-test-${process.pid}`;

test('PUT creates versioned resource; strict range reports version, bounds, digests', async () => {
  const content = Buffer.from('0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ');
  const put = await api(`/api/resources/${rid}`, {method: 'PUT', body: content});
  assert.equal(put.status, 201);
  const meta = await put.json();
  assert.equal(meta.version, 1);
  assert.equal(meta.size, content.length);
  assert.equal(meta.contentDigest, sha(content));

  const res = await api(`/api/resources/${rid}/ranges?start=4&end=12`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('x-resource-version'), '1');
  assert.equal(res.headers.get('content-range'), 'bytes 4-11/36');
  const frag = await res.json();
  assert.equal(frag.type, 'range-fragment');
  assert.deepEqual([frag.start, frag.end, frag.size, frag.version], [4, 12, 36, 1]);
  const bytes = Buffer.from(frag.bytes, 'base64');
  assert.equal(bytes.toString(), content.subarray(4, 12).toString());
  assert.equal(frag.digest, sha(content.subarray(4, 12)));
  assert.equal(frag.contentDigest, sha(content));
  assert.equal(res.headers.get('etag'), '"1"');
  assert.equal(res.headers.get('x-fragment-digest'), frag.digest);
});

test('If-Match version pin: fresh version 200, stale version 412 with current info', async () => {
  const ok = await api(`/api/resources/${rid}/ranges?start=0&end=4`, {
    headers: {'If-Match': '"1"'},
  });
  assert.equal(ok.status, 200);

  const updated = Buffer.from('UPDATED-CONTENT-HERE-!!');
  const put = await api(`/api/resources/${rid}`, {method: 'PUT', body: updated});
  assert.equal((await put.json()).version, 2);

  const stale = await api(`/api/resources/${rid}/ranges?start=0&end=4&expectedVersion=1`);
  assert.equal(stale.status, 412);
  assert.equal(stale.headers.get('x-resource-version'), '2');
  const body = await stale.json();
  assert.equal(body.error, 'VERSION_CONFLICT');
  assert.equal(body.expected, 1);
  assert.equal(body.actual, 2);
  assert.equal(body.size, updated.length);
  assert.equal(body.contentDigest, sha(updated));
  // Crucially, no bytes of the new content leak inside a conflict response.
  assert.equal(body.bytes, undefined);
});

test('bad ranges: 400 for malformed, 416 past end; neither looks like empty content', async () => {
  const bad = await api(`/api/resources/${rid}/ranges?start=1.5&end=3`);
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).error, 'INVALID_RANGE');

  const past = await api(`/api/resources/${rid}/ranges?start=0&end=999999`);
  assert.equal(past.status, 416);
  const pastBody = await past.json();
  assert.equal(pastBody.error, 'INVALID_RANGE');
  assert.equal(pastBody.size, 23);
  assert.equal(past.headers.get('content-range'), 'bytes */23');
});

test('deleted resource yields 404 on both endpoints, not an empty 200', async () => {
  const del = await api(`/api/resources/${rid}`, {method: 'DELETE'});
  assert.equal(del.status, 200);
  const range = await api(`/api/resources/${rid}/ranges?start=0&end=4`);
  assert.equal(range.status, 404);
  assert.equal((await range.json()).error, 'RESOURCE_NOT_FOUND');
  const legacy = await api(`/api/resources/${rid}`);
  assert.equal(legacy.status, 404);
  assert.equal((await legacy.json()).error, 'RESOURCE_NOT_FOUND');
});

test('legacy full/loose range interface keeps its shape and still works', async () => {
  const legacyId = `${rid}-legacy`;
  await api(`/api/resources/${legacyId}`, {method: 'PUT', body: Buffer.from('resource-content-for-range-review')});
  const res = await api(`/api/resources/${legacyId}?start=4&end=12`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.version, 1);
  assert.deepEqual([body.start, body.end], [4, 12]);
  assert.equal(Buffer.from(body.bytes, 'base64').toString(), 'urce-con');

  // No params: original default window behavior (0..1024 clamped to size).
  const full = await (await api(`/api/resources/${legacyId}`)).json();
  assert.deepEqual([full.start, full.end], [0, 33]);
  assert.equal(Buffer.from(full.bytes, 'base64').toString(), 'resource-content-for-range-review');
});

test('static page and browser module are served', async () => {
  const page = await api('/');
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type'), /text\/html/);
  const model = await api('/range-model.mjs');
  assert.equal(model.status, 200);
  assert.match(model.headers.get('content-type'), /javascript/);
});
