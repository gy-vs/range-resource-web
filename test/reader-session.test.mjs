import test from 'node:test';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {ReaderSession, computeChecksum, computeBlocks} from '../public/reader.mjs';

// Node 20 已内置 Web Crypto；仅补齐 atob/btoa 供 reader.mjs 使用。
if (!globalThis.crypto) Object.defineProperty(globalThis, 'crypto', {value: webcrypto});
globalThis.atob = (s) => Buffer.from(s, 'base64').toString('binary');
globalThis.btoa = (s) => Buffer.from(s, 'binary').toString('base64');

function makeResource(size, fill = (i) => 65 + (i % 26)) {
  return new Uint8Array(size).map((_, i) => fill(i));
}

async function envelope(id, version, bytes, start, end, size) {
  return {
    id, version, start, end, size,
    requestedStart: start, requestedEnd: end,
    satisfied: true, rangeCovered: true,
    bytes: Buffer.from(bytes).toString('base64'),
    checksum: await computeChecksum(id, version, start, end, bytes),
  };
}

// 可控传输层：按版本存放资源，支持延迟闸门与请求计数。
function makeTransport(initial) {
  const calls = [];
  const gates = [];
  const state = {versions: initial};
  const api = {
    calls,
    state,
    async transport({id, start, end, version, signal}) {
      calls.push({start, end, version});
      const gate = {};
      gate.promise = new Promise((resolve, reject) => {
        gate.resolve = resolve;
        gate.reject = reject;
        signal.addEventListener('abort', () => {
          const err = new Error('aborted');
          err.name = 'AbortError';
          reject(err);
        });
      });
      gates.push(gate);
      await gate.promise;
      const current = Math.max(...state.versions.keys());
      if (version != null && !state.versions.has(version)) {
        return {status: 409, body: {error: 'version conflict', expectedVersion: version, currentVersion: current}};
      }
      const chosen = version ?? current;
      const data = state.versions.get(chosen);
      if (!data) return {status: 404, body: {error: 'resource not found'}};
      if (start >= data.length || end <= 0) {
        return {status: 416, body: {error: 'range has no overlap with the resource', type: 'UnsatisfiableRangeError', size: data.length, version: chosen}};
      }
      // 与真实服务器一致：部分越界时夹紧到资源末端，206 返回实际边界。
      const slice = data.subarray(start, Math.min(end, data.length));
      return {status: 206, body: await envelope(id, chosen, slice, start, Math.min(end, data.length), data.length)};
    },
    release(n = 1) {
      for (let i = 0; i < n; i++) gates.shift()?.resolve();
    },
    releaseAll() {
      for (const g of gates.splice(0)) g.resolve();
    },
    pending: () => gates.length,
  };
  return api;
}

async function settled(session, n = 1) {
  // 等待 n 个微任务周期，让 async accept 链（含 digest）跑完。
  for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0));
}

const activeView = (snap) => snap.views.find((v) => v.version === snap.activeVersion);

test('adjacent same-version fragments merge into a contiguous block', async () => {
  const data = makeResource(30);
  const api = makeTransport(new Map([[1, data]]));
  const session = new ReaderSession({transport: api.transport});
  session.selectResource('r');
  const p1 = session.selectRange(0, 10);
  api.release();
  await p1;
  const p2 = session.readAdjacent('next'); // [10,20)
  api.release();
  await p2;
  await settled(session);
  const snap = session.snapshot();
  assert.deepEqual(snap.selection, {start: 10, end: 20});
  const view = activeView(snap);
  assert.equal(view.blocks.length, 1);
  assert.deepEqual([view.blocks[0].start, view.blocks[0].end], [0, 20]);
  assert.deepEqual(Array.from(view.blocks[0].bytes), Array.from(data.subarray(0, 20)));
});

test('a gap between fragments stays unstitched and can be filled', async () => {
  const data = makeResource(40);
  const api = makeTransport(new Map([[1, data]]));
  const session = new ReaderSession({transport: api.transport});
  session.selectResource('r');
  // 直接用 selectRange 选两段不相邻区间（第二段无缓存命中，都会发请求）
  let p = session.selectRange(0, 10); api.release(); await p;
  p = session.selectRange(20, 30); api.release(); await p;
  await settled(session);
  let view = activeView(session.snapshot());
  assert.equal(view.blocks.length, 2);
  assert.deepEqual(view.gaps.map((g) => [g.start, g.end]), [[10, 20], [30, 40]]);
  p = session.fillGap(10, 20); api.release(); await p;
  await settled(session);
  view = activeView(session.snapshot());
  assert.equal(view.blocks.length, 1);
  assert.deepEqual([view.blocks[0].start, view.blocks[0].end], [0, 30]);
  assert.deepEqual(view.gaps.map((g) => [g.start, g.end]), [[30, 40]]);
});

test('overlapping fragments with identical bytes merge and record both sources', async () => {
  const data = makeResource(30);
  const api = makeTransport(new Map([[1, data]]));
  const session = new ReaderSession({transport: api.transport});
  session.selectResource('r');
  let p = session.selectRange(0, 15); api.release(); await p;
  p = session.selectRange(10, 25); api.release(); await p;
  await settled(session);
  const view = activeView(session.snapshot());
  assert.equal(view.blocks.length, 1);
  assert.deepEqual([view.blocks[0].start, view.blocks[0].end], [0, 25]);
  assert.deepEqual(view.blocks[0].sources, ['0-15', '10-25']);
});

test('overlapping fragments with conflicting bytes are never merged', async () => {
  const good = makeResource(30);
  const bad = makeResource(30, (i) => (i >= 10 && i < 15 ? 42 : 65 + (i % 26)));
  // 同版本号、同范围先返回干净片段，再返回校验仍合法但重叠字节不同的片段
  //（模拟存储层/传输层异常；正常协议下这不应发生，状态机仍须拒绝拼接）。
  let call = 0;
  const session = new ReaderSession({
    transport: async ({id, start, end}) => {
      call += 1;
      const data = call === 1 ? good : bad;
      return {status: 206, body: await envelope(id, 1, data.subarray(start, end), start, end, 30)};
    },
  });
  session.selectResource('r');
  await session.selectRange(0, 15);
  await settled(session);
  await session.selectRange(10, 25, {force: true});
  await settled(session);
  const view = activeView(session.snapshot());
  assert.equal(view.mismatches.length, 1);
  assert.deepEqual([view.mismatches[0].start, view.mismatches[0].end], [10, 15]);
  // 原有干净块保持不变
  assert.deepEqual([view.blocks[0].start, view.blocks[0].end], [0, 15]);
});

test('server update during reading yields 409 and keeps version views isolated', async () => {
  const v1 = makeResource(40, () => 65); // AAAA
  const v2 = makeResource(40, () => 66); // BBBB
  const api = makeTransport(new Map([[1, v1]]));
  const session = new ReaderSession({transport: api.transport});
  session.selectResource('r');
  let p = session.selectRange(0, 10); api.release(); await p;
  // 服务端在读取期间更新：v1 消失、v2 成为最新；下一次相邻读取钉在 v1，得到 409
  api.state.versions.delete(1);
  api.state.versions.set(2, v2);
  p = session.readAdjacent('next');
  api.release();
  await p;
  await settled(session);
  let snap = session.snapshot();
  assert.equal(snap.conflict.expectedVersion, 1);
  assert.equal(snap.conflict.currentVersion, 2);
  assert.equal(snap.views.length, 1); // 冲突片段绝不入库
  assert.deepEqual([activeView(snap).blocks[0].start, activeView(snap).blocks[0].end], [0, 10]);

  // 明确跟随最新版本后，同区间读到 v2 字节，另立视图，不可与 v1 拼接
  p = session.followLatest();
  api.release();
  await p;
  await settled(session);
  snap = session.snapshot();
  assert.equal(snap.activeVersion, 2);
  assert.equal(snap.conflict, null);
  assert.equal(snap.views.length, 2);
  assert.deepEqual(Array.from(snap.views.find((v) => v.version === 2).blocks[0].bytes), Array(10).fill(66));
  assert.deepEqual(Array.from(snap.views.find((v) => v.version === 1).blocks[0].bytes), Array(10).fill(65));
});

function noop() {}

test('pinning an old version lets the user re-open the old range for comparison', async () => {
  const v1 = makeResource(40, () => 65);
  const v2 = makeResource(40, () => 66);
  const api = makeTransport(new Map([[1, v1]]));
  const session = new ReaderSession({transport: api.transport});
  session.selectResource('r');
  let p = session.selectRange(0, 10); api.release(); await p;
  // 资源更新后，钉在 v1 的重读得到 409
  api.state.versions.delete(1);
  api.state.versions.set(2, v2);
  p = session.selectRange(0, 10, {force: true});
  api.release(); // 这次是 409
  await p;
  await settled(session);
  assert.equal(session.snapshot().conflict.expectedVersion, 1);
  // 明确跟随最新：读到 v2 片段另立视图
  p = session.followLatest();
  api.release();
  await p;
  await settled(session);
  assert.equal(session.snapshot().activeVersion, 2);
  // 切回旧版本视图
  session.pinVersion(1);
  const snap = session.snapshot();
  assert.equal(snap.pinnedVersion, 1);
  assert.equal(snap.activeVersion, 1);
  // 旧区间命中缓存，不发请求
  const before = api.calls.length;
  const hit = await session.selectRange(0, 10);
  assert.equal(hit.cached, true);
  assert.equal(api.calls.length, before);
});

test('a late response to an old selection is stored as history only', async () => {
  const data = makeResource(60);
  // 该传输层故意不响应 abort：服务端在 abort 前已发出响应，
  // 浏览器只能在收到时判断它是否已被新选择取代。
  const gates = [];
  const transport = async ({id, start, end}) => {
    const gate = {};
    gate.promise = new Promise((resolve) => { gate.resolve = resolve; });
    gates.push(gate);
    await gate.promise;
    return {status: 206, body: await envelope(id, 1, data.subarray(start, end), start, end, data.length)};
  };
  const session = new ReaderSession({transport});
  session.selectResource('r');
  const old = session.selectRange(0, 10); // 不 release
  await settled(session);
  // 用户立刻改选新区间：旧请求在状态机里被取代（abort 拦不住已在途中的响应）
  const fresh = session.selectRange(20, 30);
  await settled(session);
  for (const g of gates.splice(0)) g.resolve();
  await Promise.allSettled([old, fresh]);
  await settled(session, 3);
  const snap = session.snapshot();
  assert.deepEqual(snap.selection, {start: 20, end: 30});
  const view = activeView(snap);
  // 当前选择与晚到但校验通过的旧片段都按边界保留为独立块
  assert.deepEqual(view.blocks.map((b) => [b.start, b.end]), [[0, 10], [20, 30]]);
  // 但旧片段被明确标记为"晚到历史"，没有覆盖新选择
  assert.deepEqual(view.superseded.map((x) => [x.start, x.end]), [[0, 10]]);
  assert.match(snap.events.some((e) => /晚到/.test(e.message)) ? '晚到' : '无', /晚到/);
});

test('cancel aborts the in-flight request without touching views', async () => {
  const data = makeResource(20);
  const api = makeTransport(new Map([[1, data]]));
  const session = new ReaderSession({transport: api.transport});
  session.selectResource('r');
  const p = session.selectRange(0, 10);
  await settled(session);
  assert.equal(api.pending(), 1);
  session.cancel();
  await p.catch(() => {});
  await settled(session);
  const snap = session.snapshot();
  assert.equal(snap.views.length, 0);
  assert.match(snap.events.at(-1).message, /取消/);
});

test('checksum mismatch is a visible failure, not empty content', async () => {
  const data = makeResource(20);
  const session = new ReaderSession({
    transport: async ({id, start, end}) => {
      const body = await envelope(id, 1, data.subarray(start, end), start, end, 20);
      body.checksum = body.checksum.replace(/^./, body.checksum[0] === '0' ? '1' : '0');
      return {status: 206, body};
    },
  });
  session.selectResource('r');
  await session.selectRange(0, 10);
  await settled(session, 2);
  const snap = session.snapshot();
  assert.equal(snap.views.length, 0, '校验失败的片段不得入库');
  assert.equal(snap.lastFailure.reason, 'checksum');
  assert.match(snap.lastFailure.detail, /校验和/);
});

test('404 after delete is an explicit missing state', async () => {
  const api = makeTransport(new Map());
  const session = new ReaderSession({transport: api.transport});
  session.selectResource('r');
  const pending = session.selectRange(0, 10);
  api.releaseAll();
  await pending;
  await settled(session, 2);
  const snap = session.snapshot();
  assert.equal(snap.missing, true);
  assert.equal(snap.views.length, 0);
  assert.match(snap.events.at(-1).message, /删除|不存在/);
});

test('switching resource id resets versions, selection and in-flight requests', async () => {
  const a = makeResource(20, () => 65);
  const b = makeResource(20, () => 67);
  const api = makeTransport(new Map([[1, a]]));
  const session = new ReaderSession({transport: api.transport});
  session.selectResource('a');
  const pending = session.selectRange(0, 10);
  await settled(session);
  assert.equal(api.pending(), 1);
  session.selectResource('b');
  api.releaseAll();
  await pending.catch(() => {});
  await settled(session, 2);
  const snap = session.snapshot();
  assert.equal(snap.id, 'b');
  assert.equal(snap.selection, null);
  assert.equal(snap.activeVersion, null);
  assert.deepEqual(snap.views, []);
  assert.equal(snap.requestsInflight, 0);
});

test('retry replays the last failed request at its pinned version', async () => {
  let failNext = true;
  const data = makeResource(20);
  const api = makeTransport(new Map([[1, data]]));
  const session = new ReaderSession({
    transport: async (args) => {
      if (failNext) {
        const err = new Error('network down');
        throw err;
      }
      return api.transport(args);
    },
  });
  session.selectResource('r');
  await session.selectRange(0, 10);
  await settled(session);
  assert.equal(session.snapshot().lastFailure.reason, 'network');
  failNext = false;
  const p = session.retry();
  api.release();
  await p;
  await settled(session);
  const view = activeView(session.snapshot());
  assert.equal(view.blocks.length, 1);
  assert.deepEqual([view.blocks[0].start, view.blocks[0].end], [0, 10]);
});

test('computeBlocks does not stitch across a boundary gap on its own', () => {
  const {blocks, mismatches} = computeBlocks(new Map([
    ['0-5', {start: 0, end: 5, bytes: new Uint8Array(5)}],
    ['8-12', {start: 8, end: 12, bytes: new Uint8Array(4)}],
  ]));
  assert.equal(blocks.length, 2);
  assert.equal(mismatches.length, 0);
});

test('416 past the end reports resource size, not failure or empty content', async () => {
  const data = makeResource(20);
  const api = makeTransport(new Map([[1, data]]));
  const session = new ReaderSession({transport: api.transport});
  session.selectResource('r');
  const p = session.selectRange(25, 40);
  api.release();
  await p;
  await settled(session, 2);
  const snap = session.snapshot();
  assert.equal(snap.lastFailure, null, '416 不是失败');
  const view = snap.views.find((v) => v.version === 1);
  assert.equal(view.size, 20, '416 让前端知道资源实际长度');
  assert.equal(view.blocks.length, 0, '416 不会产生空片段');
  assert.match(snap.events.at(-1).message, /超出资源末端/);
});

test('readAdjacent prev at offset 0 is a no-op without a request', async () => {
  const data = makeResource(20);
  const api = makeTransport(new Map([[1, data]]));
  const session = new ReaderSession({transport: api.transport});
  session.selectResource('r');
  let p = session.selectRange(0, 10); api.release(); await p;
  const before = api.calls.length;
  await session.readAdjacent('prev');
  assert.equal(api.calls.length, before, '贴齐起点时不再发请求');
  assert.match(session.snapshot().events.at(-1).message, /起点/);
});
