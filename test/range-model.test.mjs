import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {
  RangeBrowser,
  base64ToBytes,
  bytesToText,
} from '../public/range-model.mjs';

const sha256 = (bytes) => createHash('sha256').update(Buffer.from(bytes)).digest('hex');

function envelope(version, content, start, end) {
  const slice = Buffer.from(content.subarray(start, end));
  return {
    type: 'range-fragment',
    id: 'r',
    version,
    start,
    end,
    size: content.length,
    contentDigest: sha256(content),
    digest: sha256(slice),
    bytes: slice.toString('base64'),
  };
}

/** Mutable in-memory "server" that records requests and can be delayed. */
function fakeServer(initial, {delay = 0} = {}) {
  const state = {
    content: Buffer.from(initial),
    version: 1,
    deleted: false,
    requests: [],
    // Optional gate: request is held until release(req) is called.
    gate: null,
  };
  const put = (content) => {
    state.content = Buffer.from(content);
    state.version += 1;
    state.deleted = false;
    return state.version;
  };
  const remove = () => {
    state.deleted = true;
    state.version += 1;
  };
  const transport = (request, signal) => new Promise((resolve, reject) => {
    const req = {...request};
    state.requests.push(req);
    const finish = () => {
      if (state.deleted) return resolve({ok: false, kind: 'not-found'});
      if (request.expectedVersion !== undefined &&
          request.expectedVersion !== null &&
          request.expectedVersion !== state.version) {
        return resolve({
          ok: false, kind: 'version-conflict',
          expected: request.expectedVersion, actual: state.version,
          size: state.content.length, contentDigest: sha256(state.content),
        });
      }
      resolve({ok: true, fragment: envelope(state.version, state.content, request.start, request.end)});
    };
    if (signal.aborted) return reject(Object.assign(new Error('aborted'), {name: 'AbortError'}));
    const onAbort = () => reject(Object.assign(new Error('aborted'), {name: 'AbortError'}));
    signal.addEventListener('abort', onAbort, {once: true});
    const go = () => setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      finish();
    }, delay);
    if (state.gate) state.gate(req, go);
    else go();
  });
  return {state, put, remove, transport};
}

function makeBrowser(server, opts = {}) {
  return new RangeBrowser('r', {transport: server.transport, ...opts});
}

test('middle open + adjacent reads stitch contiguous bytes of one version', async () => {
  const content = Buffer.from('0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ');
  const server = fakeServer(content);
  const b = makeBrowser(server);
  await b.open(10, 18);
  assert.equal(b.anchorVersion, 1);
  await b.readAdjacent('before', 10);
  await b.readAdjacent('after', 10);
  const view = b.buildView();
  assert.deepEqual([view.start, view.end], [0, 28]);
  assert.equal(view.tracks.length, 1);
  assert.deepEqual(view.stats, {stitched: 28, gap: 0, foreign: 0});
  const stitched = b.stitchedBytes(0, 28);
  assert.equal(bytesToText(stitched), content.subarray(0, 28).toString());
});

test('overlapping same-version fragments merge (union coverage)', async () => {
  const content = Buffer.from('abcdefghij');
  const server = fakeServer(content);
  const b = makeBrowser(server);
  await b.open(0, 6);
  // Re-select an overlapping window rather than a clean neighbor. The
  // review window moves to the new selection…
  await b.open(4, 10);
  const view = b.buildView();
  assert.deepEqual([view.start, view.end], [4, 10]);
  assert.equal(view.stats.gap, 0);
  assert.equal(view.stats.stitched, 6);
  // …but stored fragments now union-cover 0..10, stitched across overlap.
  assert.equal(bytesToText(b.stitchedBytes(0, 10)), 'abcdefghij');
  const last = b.history.at(-1);
  assert.equal(last.outcome.kind, 'fragment');

  // Duplicate re-delivery of an identical interval is idempotent.
  const countBefore = b.byVersion.get(1).length;
  await b.refetchCurrent(0, 6);
  assert.equal(b.byVersion.get(1).length, countBefore);
});

test('overlapping fragments whose shared bytes contradict are not stitched', async () => {
  const content = Buffer.from('abcdefghij');
  const server = fakeServer(content);
  // Sabotage one response to return bytes that disagree in the overlap,
  // while still carrying a self-consistent digest.
  const rawTransport = server.transport;
  let call = 0;
  server.transport = async (request, signal) => {
    call += 1;
    const result = await rawTransport(request, signal);
    if (call === 2 && result.ok) {
      const bad = Buffer.from('XXXXXXghij');
      result.fragment = envelope(1, bad, 4, 10);
    }
    return result;
  };
  const b = makeBrowser(server);
  await b.open(0, 6);
  const outcome = await b.open(4, 10);
  assert.equal(outcome.kind, 'overlap-conflict');
  assert.ok(b.markers.some((m) => m.kind === 'integrity'));
  // The first fragment remains reviewable; the whole window is not stitched.
  assert.equal(b.stitchedBytes(0, 10), null);
  assert.equal(bytesToText(b.stitchedBytes(0, 6)), 'abcdef');
});

test('server returning a narrower fragment leaves an explicit gap, not fake bytes', async () => {
  const content = Buffer.from('abcdefghijklmnopqrstuvwxyz');
  const server = fakeServer(content);
  const rawTransport = server.transport;
  server.transport = async (request, signal) => {
    const result = await rawTransport(request, signal);
    if (result.ok && request.end - request.start > 10) {
      // Report the actually-returned smaller slice honestly.
      result.fragment = envelope(1, content, request.start, request.start + 10);
    }
    return result;
  };
  const b = makeBrowser(server);
  await b.open(0, 20);
  const view = b.buildView();
  assert.deepEqual([view.start, view.end], [0, 20]);
  assert.equal(view.stats.stitched, 10);
  assert.equal(view.stats.gap, 10);
  const gapRun = view.tracks[0].runs.find((r) => r.kind === 'gap');
  assert.deepEqual([gapRun.start, gapRun.end], [10, 20]);
  assert.equal(b.stitchedBytes(0, 20), null);
});

test('version moves during reading: adjacent read conflicts and is never stitched', async () => {
  const content = Buffer.from('0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ');
  const server = fakeServer(content);
  const b = makeBrowser(server);
  await b.open(0, 10);
  server.put(Buffer.from('UPDATED-CONTENT-'.repeat(4)));
  const outcome = await b.readAdjacent('after', 10);
  assert.equal(outcome.kind, 'version-conflict');
  assert.equal(outcome.actual, 2);
  const view = b.buildView();
  // v1 bytes stay stitched; the new neighborhood is a gap + conflict marker.
  assert.equal(view.stats.stitched, 10);
  assert.equal(view.stats.gap, 10);
  const marker = view.markers.find((m) => m.kind === 'conflict');
  assert.deepEqual([marker.start, marker.end], [10, 20]);
  assert.equal(marker.expected, 1);
  assert.equal(marker.actual, 2);
  assert.ok(view.message.includes('v2'));
  // Preview refuses to show fake content across the conflict.
  assert.equal(b.stitchedBytes(0, 20), null);
});

test('after conflict, fetching at latest yields a separate comparison track', async () => {
  const v1 = Buffer.from('0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ');
  const server = fakeServer(v1);
  const b = makeBrowser(server);
  await b.open(0, 10);
  server.put(Buffer.from('UPDATED-CONTENT-'.repeat(4)));
  await b.readAdjacent('after', 10); // conflict
  // Re-select the ORIGINAL interval against latest: old v1 fragment is kept,
  // v2 fragment appears as a foreign track — both visible for comparison.
  const outcome = await b.refetchCurrent(0, 10);
  assert.equal(outcome.kind, 'fragment');
  assert.equal(outcome.fragment.version, 2);
  const view = b.buildView();
  const versions = view.tracks.map((t) => t.version).sort();
  assert.deepEqual(versions, [1, 2]);
  assert.equal(view.stats.foreign, 10);
  // Adopt v2: anchor flips, v1 becomes the foreign track, nothing lost.
  b.adoptVersion(2);
  const view2 = b.buildView();
  assert.equal(view2.tracks.find((t) => t.anchor).version, 2);
  assert.equal(view2.stats.stitched, 10);
  assert.equal(view2.stats.foreign, 10);
});

test('late-arriving response from an old selection never overwrites the new one', async () => {
  const content = Buffer.from('abcdefghijklmnopqrstuvwxyz012345');
  let releaseFirst = null;
  const server = fakeServer(content, {delay: 0});
  const rawTransport = server.transport;
  server.transport = (request, signal) => {
    if (request.start === 0) {
      return new Promise((resolve) => {
        releaseFirst = () => resolve(rawTransport(request, signal));
      });
    }
    return rawTransport(request, signal);
  };
  const b = makeBrowser(server);
  const first = b.open(0, 10);         // pinned, slow
  const second = b.open(20, 30);       // newer selection, fast
  await second;
  // Old request resolves after the new selection is already displayed.
  await releaseFirst();
  await first;
  const view = b.buildView();
  assert.deepEqual([view.start, view.end], [20, 30]);
  // Stale response is recorded as ignored and contributed no fragment…
  assert.ok(b.history.some((h) => h.outcome.kind === 'ignored-stale'));
  // …but its bytes must not be present at all (no global cache pollution).
  assert.ok(!b.byVersion.has(1) ||
    b.byVersion.get(1).every((f) => f.start !== 0 || f.end !== 10));
});

test('cancel aborts pending requests; cancelled bytes never land in state', async () => {
  const content = Buffer.from('abcdefghijklmnopqrstuvwxyz');
  let resolveTransport;
  const server = fakeServer(content);
  server.transport = (request, signal) => new Promise((resolve, reject) => {
    resolveTransport = {resolve, reject, signal};
    signal.addEventListener('abort', () =>
      reject(Object.assign(new Error('aborted'), {name: 'AbortError'})), {once: true});
  });
  const b = makeBrowser(server);
  const pending = b.open(0, 10);
  assert.equal(b.pendingCount, 1);
  b.cancel();
  assert.ok(resolveTransport.signal.aborted);
  const outcome = await pending;
  assert.equal(outcome.kind, 'cancelled');
  assert.equal(b.pendingCount, 0);
  assert.equal(b.byVersion.size, 0);
  // A fresh selection after cancel works normally.
  server.transport = fakeServer(content).transport;
  const server2 = fakeServer(content);
  b.transport = server2.transport;
  await b.open(2, 6);
  assert.equal(bytesToText(b.stitchedBytes(2, 6)), 'cdef');
});

test('deleted resource is a tombstone marker, never empty content', async () => {
  const server = fakeServer(Buffer.from('abcdefghij'));
  const b = makeBrowser(server);
  await b.open(0, 5);
  server.remove();
  // A pinned continuation hits 404 because the resource is gone.
  const outcome = await b.readAdjacent('after', 5);
  assert.equal(outcome.kind, 'not-found');
  const view = b.buildView();
  const tomb = view.markers.find((m) => m.kind === 'tombstone');
  assert.deepEqual([tomb.start, tomb.end], [5, 10]);
  // No empty bytes were appended; the preview still refuses the window.
  assert.equal(b.stitchedBytes(0, 10), null);
  assert.equal(bytesToText(b.stitchedBytes(0, 5)), 'abcde');
});

test('fragment digest mismatch is surfaced as an integrity failure', async () => {
  const server = fakeServer(Buffer.from('abcdefghij'));
  const rawTransport = server.transport;
  server.transport = async (request, signal) => {
    const result = await rawTransport(request, signal);
    if (result.ok) {
      result.fragment.bytes = Buffer.from('XXXXXXXXXX').subarray(0,
        result.fragment.end - result.fragment.start).toString('base64');
    }
    return result;
  };
  const b = makeBrowser(server);
  const outcome = await b.open(0, 5);
  assert.equal(outcome.kind, 'integrity-mismatch');
  assert.equal(b.byVersion.size, 0);
  assert.ok(b.markers.some((m) => m.kind === 'integrity'));
});

test('failed request is retryable and succeeds once the transport recovers', async () => {
  const server = fakeServer(Buffer.from('abcdefghij'));
  let failing = true;
  server.transport = (request, signal) => failing
    ? Promise.reject(new Error('network down'))
    : fakeServer(Buffer.from('abcdefghij')).transport(request, signal);
  const b = makeBrowser(server);
  const first = await b.open(0, 5);
  assert.equal(first.kind, 'network-error');
  assert.ok(b.markers.some((m) => m.kind === 'error' && m.retryable));
  failing = false;
  const retried = await b.retry();
  assert.equal(retried.kind, 'fragment');
  assert.equal(bytesToText(b.stitchedBytes(0, 5)), 'abcde');
  assert.equal(b.buildView().stats.gap, 0);
});

test('re-selecting an old interval keeps the explored window and its conflict visible', async () => {
  const server = fakeServer(Buffer.from('0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ'));
  const b = makeBrowser(server);
  await b.open(0, 10);
  server.put(Buffer.from('UPDATED-CONTENT-'.repeat(4)));
  await b.readAdjacent('after', 10); // conflict on 10-20
  await b.refetchCurrent(0, 10);     // comparison fetch, must not shrink window
  const view = b.buildView();
  assert.deepEqual([view.start, view.end], [0, 20]);
  assert.ok(view.markers.some((m) => m.kind === 'conflict' && m.start === 10 && m.end === 20));
});

test('stitched preview exists only for fully-covered intervals', async () => {
  const server = fakeServer(Buffer.from('abcdefghij'));
  const b = makeBrowser(server);
  await b.open(2, 7);
  assert.equal(b.stitchedBytes(0, 5), null);   // starts before coverage
  assert.equal(bytesToText(b.stitchedBytes(2, 7)), 'cdefg');
  assert.equal(b.stitchedBytes(2, 8), null);   // extends past coverage
});

test('every fragment envelope is decodable exactly as its bounds claim', async () => {
  const content = Buffer.from('0123456789ABCDEF');
  const frag = envelope(3, content, 4, 12);
  const bytes = base64ToBytes(frag.bytes);
  assert.equal(bytes.length, frag.end - frag.start);
  assert.equal(sha256(bytes), frag.digest);
  assert.equal(Buffer.from(bytes).toString(), '456789AB');
});
