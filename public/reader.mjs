// 浏览器端"按范围读取 + 断点校验"会话状态机。
// 设计约束：
//  - 绝不先下载完整资源再切片：每个片段都是独立的范围请求结果；
//  - 片段按 (资源 id, 版本) 分视图保存，不同版本的字节永不拼接；
//  - 片段入库前必须通过校验和（覆盖 id/版本/边界/字节）；
//  - 每次重新选择区间都会取代在途旧请求：被取代的晚到响应只能进入历史，
//    不能覆盖当前选择；
//  - 404（删除）、409（版本变化）、校验失败都是显式状态，不会被渲染成空内容。

export class ReaderError extends Error {}

export function bytesToBase64(bytes) {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export function base64ToBytes(b64) {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// 必须与服务端 fragmentChecksum 的拼装完全一致。
export async function computeChecksum(id, version, start, end, bytes) {
  const header = new TextEncoder().encode(`range-resource-web:${id}:${version}:${start}:${end}:`);
  const buf = new Uint8Array(header.length + bytes.length);
  buf.set(header, 0);
  buf.set(bytes, header.length);
  return sha256Hex(buf);
}

function fragmentKey(f) {
  return `${f.start}-${f.end}`;
}

// 把同版本片段合并成连续块；重叠区域逐字节核对，不一致就标记冲突，
// 冲突字节不会混入可审阅视图。
export function computeBlocks(fragments) {
  const sorted = [...fragments.values()].sort((a, b) => a.start - b.start || a.end - b.end);
  const blocks = [];
  const mismatches = [];
  for (const f of sorted) {
    const last = blocks[blocks.length - 1];
    if (!last || f.start > last.end) {
      blocks.push({start: f.start, end: f.end, bytes: f.bytes.slice(), sources: [fragmentKey(f)]});
      continue;
    }
    if (f.start === last.start && f.end <= last.end) {
      const same = bytesEqual(f.bytes, last.bytes.subarray(0, f.bytes.length));
      if (!same) mismatches.push({start: f.start, end: f.end, a: last.sources[0], b: fragmentKey(f)});
      else if (!last.sources.includes(fragmentKey(f))) last.sources.push(fragmentKey(f));
      continue;
    }
    const overlapEnd = Math.min(last.end, f.end);
    const aOff = f.start - last.start;
    const same = bytesEqual(
      f.bytes.subarray(0, overlapEnd - f.start),
      last.bytes.subarray(aOff, aOff + (overlapEnd - f.start)),
    );
    if (!same) {
      mismatches.push({start: f.start, end: overlapEnd, a: last.sources[0], b: fragmentKey(f)});
      continue; // 保留已有块，丢弃不可信的重叠拼接
    }
    if (!last.sources.includes(fragmentKey(f))) last.sources.push(fragmentKey(f));
    if (f.end > last.end) {
      const grown = new Uint8Array(last.bytes.length + (f.end - last.end));
      grown.set(last.bytes, 0);
      grown.set(f.bytes.subarray(last.end - f.start), last.bytes.length);
      last.bytes = grown;
      last.end = f.end;
    }
  }
  return {blocks, mismatches};
}

function bytesEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export class ReaderSession {
  // transport({id, start, end, version|null, signal}) -> {status, body}
  constructor({transport, now = () => Date.now()} = {}) {
    if (typeof transport !== 'function') throw new ReaderError('transport is required');
    this.transport = transport;
    this.now = now;
    this.listeners = new Set();
    this.reset(null);
  }

  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit() {
    for (const fn of this.listeners) fn(this.snapshot());
  }

  log(level, message, extra = {}) {
    this.state.events.push({time: this.now(), level, message, ...extra});
    if (this.state.events.length > 200) this.state.events.shift();
  }

  reset(id) {
    for (const req of this.state?.requests ?? []) req.controller.abort();
    this.state = {
      id,
      seq: 0, // 当前选择代号；重新选择区间或切换资源时 +1
      reqSeq: 0, // 单调请求代号，每个派发的请求独占一个
      pinnedVersion: null, // 非 null 时，新范围请求带 If 版本语义
      activeVersion: null,
      selection: null, // {start, end}
      views: new Map(), // version -> {version, size, fragments, failures, superseded:[...]}
      conflict: null, // {expectedVersion, currentVersion}
      missing: false, // 资源在服务端已删除
      lastFailure: null,
      requests: [],
      events: [],
    };
    this.log('info', id ? `已选择资源 ${id}` : '等待选择资源');
  }

  // 切换资源 = 完全重置：旧资源的缓存、版本、在途请求一律不沿用。
  selectResource(id) {
    if (!id) throw new ReaderError('resource id required');
    this.reset(id);
    this.emit();
  }

  ensureView(version, size) {
    let view = this.state.views.get(version);
    if (!view) {
      view = {version, size: size ?? null, fragments: new Map(), failures: [], superseded: []};
      this.state.views.set(version, view);
    }
    if (size != null) view.size = size;
    return view;
  }

  parseRange(start, end) {
    const s = Number(start);
    const e = Number(end);
    if (!Number.isInteger(s) || s < 0) throw new ReaderError('start 必须是非负整数');
    if (!Number.isInteger(e) || e <= s) throw new ReaderError('end 必须是大于 start 的整数');
    return [s, e];
  }

  // 用户重新选择区间：取代一切在途旧请求（取消），并提升选择代号。
  async selectRange(start, end, {force = false} = {}) {
    const [s, e] = this.parseRange(start, end);
    if (!this.state.id) throw new ReaderError('请先选择资源');
    this.supersedeRequests();
    this.state.seq += 1;
    this.state.selection = {start: s, end: e};
    this.state.conflict = null;
    const version = this.state.pinnedVersion ?? this.state.activeVersion;
    if (!force && version != null) {
      const hit = this.state.views.get(version)?.fragments.get(`${s}-${e}`);
      if (hit) {
        this.log('info', `命中本地片段缓存 v${version} [${s}, ${e})，未发起请求`, {cached: true});
        this.emit();
        return {cached: true, fragment: hit};
      }
    }
    this.emit();
    // 默认带活动版本条件：读取期间资源更新会得到 409，而不是静默混入新版本。
    return this.dispatch({mode: 'select', start: s, end: e, version: this.state.pinnedVersion ?? this.state.activeVersion});
  }

  // 冲突后明确选择"跟随最新版本"：解除钉定并无条件重读当前区间。
  async followLatest() {
    const sel = this.state.selection;
    this.state.pinnedVersion = null;
    this.state.conflict = null;
    this.log('info', '已选择跟随服务端最新版本，重读当前区间');
    if (!sel) {
      this.emit();
      return;
    }
    this.supersedeRequests();
    this.state.seq += 1;
    this.emit();
    return this.dispatch({mode: 'select', start: sel.start, end: sel.end, version: null});
  }

  dismissConflict() {
    this.state.conflict = null;
    this.emit();
  }

  // 取消当前选择代号下的全部在途请求。
  cancel() {
    const current = this.state.requests.filter((r) => r.seq === this.state.seq);
    for (const req of current) req.controller.abort();
    if (current.length) this.log('warn', '已取消在途范围请求', {count: current.length});
    this.emit();
  }

  // 读取相邻范围：以当前选择为锚点向两侧延伸，长度沿用当前选择长度。
  async readAdjacent(direction) {
    const sel = this.state.selection;
    if (!sel) throw new ReaderError('没有可延伸的区间选择');
    if (this.state.activeVersion == null && this.state.pinnedVersion == null) {
      throw new ReaderError('请先读取一个片段再读取相邻范围');
    }
    const len = sel.end - sel.start;
    if (direction === 'prev') {
      if (sel.start === 0) {
        this.log('info', '已经到达资源起点');
        this.emit();
        return;
      }
      return this.dispatch({
        mode: 'extend-prev',
        start: Math.max(0, sel.start - len),
        end: sel.start,
        version: this.state.activeVersion ?? this.state.pinnedVersion,
      });
    }
    // next：末端是否已到资源长度可由已知视图尺寸提前判断，未知则交给 416/响应。
    const size = this.state.views.get(this.state.activeVersion ?? this.state.pinnedVersion)?.size;
    if (size != null && sel.end >= size) {
      this.log('info', '已经到达资源终点');
      this.emit();
      return;
    }
    // 相邻读取固定钉在当前视图版本：资源更新时得到 409，而不是混入新版本字节。
    return this.dispatch({mode: 'extend-next', start: sel.end, end: sel.end + len,
      version: this.state.activeVersion ?? this.state.pinnedVersion});
  }

  // 填充同版本两个连续块之间的缺口。
  async fillGap(start, end) {
    if (this.state.activeVersion == null) throw new ReaderError('没有活动版本');
    return this.dispatch({mode: 'gap', start, end, version: this.state.activeVersion});
  }

  async retry() {
    const f = this.state.lastFailure;
    if (!f) {
      this.log('info', '没有需要重试的失败请求');
      this.emit();
      return;
    }
    return this.dispatch({mode: f.mode, start: f.start, end: f.end, version: f.version});
  }

  async forceReload() {
    const sel = this.state.selection;
    if (!sel) throw new ReaderError('没有可重新校验的区间');
    this.supersedeRequests();
    this.state.seq += 1;
    this.state.conflict = null;
    this.emit();
    return this.dispatch({mode: 'select', start: sel.start, end: sel.end, version: this.state.pinnedVersion ?? this.state.activeVersion});
  }

  // 钉定到某个历史版本（用于切回旧区间比较）；之后的范围请求都带版本条件。
  pinVersion(version) {
    this.state.pinnedVersion = version;
    this.state.activeVersion = version;
    this.state.conflict = null;
    this.log('info', `已钉定版本 v${version}，后续读取只接受该版本片段`);
    this.emit();
  }

  // 回到最新：解除版本钉定，后续不带版本条件。
  unpinVersion() {
    this.state.pinnedVersion = null;
    this.state.conflict = null;
    this.log('info', '已解除版本钉定，后续读取跟随服务端最新版本');
    this.emit();
  }

  supersedeRequests() {
    for (const req of this.state.requests) {
      req.superseded = true;
      req.controller.abort();
    }
  }

  async dispatch({mode, start, end, version}) {
    const seq = this.state.seq;
    const reqSeq = ++this.state.reqSeq;
    const controller = new AbortController();
    const req = {seq, reqSeq, mode, start, end, version, controller, superseded: false, cancelled: false};
    this.state.requests.push(req);
    this.state.missing = false;
    this.emit();
    try {
      const {status, body} = await this.transport({
        id: this.state.id, start, end, version, signal: controller.signal,
      });
      this.settle(req);
      if (status === 206) return this.accept(body, req);
      if (status === 409) return this.acceptConflict(body, req);
      if (status === 404) return this.acceptMissing(body, req);
      if (status === 416) return this.acceptUnsatisfiable(body, req);
      return this.acceptFailure({
        reason: 'http', code: status, detail: body?.error ?? `HTTP ${status}`,
      }, req);
    } catch (error) {
      this.settle(req);
      if (error?.name === 'AbortError') {
        // 用户取消：当前代号 -> 明确提示；被新选择取代：仅记入历史，不覆盖任何视图。
        if (req.superseded) {
          this.log('debug', `旧请求 [${req.start}, ${req.end}) 晚到，已被新选择取代，不覆盖当前视图`, {superseded: true});
        } else {
          this.log('warn', `请求 [${req.start}, ${req.end}) 已取消`);
        }
        this.emit();
        return;
      }
      return this.acceptFailure({reason: 'network', detail: error?.message ?? String(error)}, req);
    }
  }

  settle(req) {
    this.state.requests = this.state.requests.filter((r) => r !== req);
  }

  async accept(payload, req) {
    // 无论是否被取代，先验证协议自洽性，再决定去向。
    const declared = {
      id: payload?.id, version: payload?.version,
      start: payload?.start, end: payload?.end, size: payload?.size,
    };
    if (payload?.id !== this.state.id || !Number.isInteger(declared.version)
      || declared.start !== req.start || declared.end !== req.end
      || !Number.isInteger(declared.size) || typeof payload.bytes !== 'string'
      || typeof payload.checksum !== 'string') {
      return this.acceptFailure({reason: 'protocol', detail: '响应缺少或篡改了版本/边界字段'}, req);
    }
    const bytes = base64ToBytes(payload.bytes);
    if (bytes.length !== declared.end - declared.start) {
      return this.acceptFailure({reason: 'protocol', detail: '响应字节长度与声明边界不一致'}, req);
    }
    let checksum;
    try {
      checksum = await computeChecksum(declared.id, declared.version, declared.start, declared.end, bytes);
    } catch {
      return this.acceptFailure({reason: 'checksum', detail: '校验计算失败'}, req);
    }
    if (checksum !== payload.checksum) {
      return this.acceptFailure({reason: 'checksum', detail: '片段校验和不匹配，字节或边界可能已损坏'}, req);
    }

    const fragment = {...declared, bytes, checksum, mode: req.mode};
    const view = this.ensureView(declared.version, declared.size);
    view.failures = view.failures.filter((f) => !(f.start === fragment.start && f.end === fragment.end));
    view.fragments.set(fragmentKey(fragment), fragment);

    // 被取代的晚到响应：校验合法，可以留在历史版本视图里，但绝不触碰当前选择。
    if (req.superseded) {
      view.superseded.push({start: fragment.start, end: fragment.end, time: this.now()});
      this.log('debug', `晚到片段 v${declared.version} [${fragment.start}, ${fragment.end}) 校验通过，仅保存为历史`, {superseded: true});
      this.emit();
      return {superseded: true, fragment};
    }

    if (req.version != null && req.version !== declared.version) {
      // 传输层未把条件版本转成 409 时的兜底防线。
      return this.acceptConflict({expectedVersion: req.version, currentVersion: declared.version}, req);
    }

    if (this.state.activeVersion == null || (this.state.pinnedVersion == null && req.mode === 'select')) {
      this.state.activeVersion = declared.version;
    }
    if (req.mode === 'extend-next' || req.mode === 'extend-prev') {
      this.state.selection = {start: req.start, end: req.end};
    }
    this.log('ok', `已接收 v${declared.version} 片段 [${fragment.start}, ${fragment.end})，校验通过`, {
      mode: req.mode, version: declared.version,
    });
    this.emit();
    return {fragment};
  }

  acceptConflict(body, req) {
    const expected = body?.expectedVersion ?? req.version;
    const current = body?.currentVersion ?? null;
    if (expected == null) {
      // 无条件请求不该收到 409：按协议异常处理，避免伪造 vnull 冲突横幅。
      return this.acceptFailure({reason: 'protocol', code: 409, detail: '未携带版本条件却收到 409'}, req);
    }
    const record = {
      start: req.start, end: req.end, version: expected, mode: req.mode,
      reason: 'conflict', code: 409, detail: `需要 v${expected}，服务端当前为 v${current ?? '?'}`,
      expectedVersion: expected, currentVersion: current, time: this.now(),
    };
    if (req.superseded) {
      this.log('debug', `晚到的冲突响应 [${req.start}, ${req.end}) 已忽略`);
      this.emit();
      return;
    }
    this.state.conflict = {expectedVersion: expected, currentVersion: current};
    this.state.lastFailure = record;
    if (expected != null) this.ensureView(expected).failures.push(record);
    this.log('error', `版本冲突：[${req.start}, ${req.end}) 请求的是 v${expected}，服务端已是 v${current ?? '?'}，拒绝拼接`, record);
    this.emit();
  }

  acceptMissing(body, req) {
    if (req.superseded) {
      this.log('debug', `晚到的 404 响应 [${req.start}, ${req.end}) 已忽略`);
      this.emit();
      return;
    }
    const record = {
      start: req.start, end: req.end, version: req.version, mode: req.mode,
      reason: 'missing', code: 404, detail: body?.error ?? '资源不存在或已被删除', time: this.now(),
    };
    this.state.missing = true;
    this.state.lastFailure = record;
    this.log('error', `资源 ${this.state.id} 已删除或不存在，这不是空内容，必须重新选择资源`, record);
    this.emit();
  }

  acceptUnsatisfiable(body, req) {
    if (req.superseded) {
      this.log('debug', `晚到的 416 响应 [${req.start}, ${req.end}) 已忽略`);
      this.emit();
      return;
    }
    const size = Number(body?.size);
    const bodyVersion = Number(body?.version);
    const v = req.version ?? this.state.activeVersion ?? (Number.isInteger(bodyVersion) ? bodyVersion : null);
    if (v != null) {
      if (Number.isInteger(size)) this.ensureView(v, size);
      else this.ensureView(v);
    }
    this.state.lastFailure = null;
    this.log('info', `区间 [${req.start}, ${req.end}) 超出资源末端${Number.isInteger(size) ? `（资源共 ${size} 字节）` : ''}，这不是空内容`, {
      reason: 'unsatisfiable', code: 416, size,
    });
    this.emit();
  }

  acceptFailure(reason, req) {
    const record = {
      start: req.start, end: req.end, version: req.version, mode: req.mode,
      time: this.now(), ...reason,
    };
    if (req.superseded) {
      this.log('debug', `晚到的失败响应 [${req.start}, ${req.end}) 已忽略：${reason.detail ?? reason.reason}`);
      this.emit();
      return;
    }
    this.state.lastFailure = record;
    if (req.version != null) this.ensureView(req.version).failures.push(record);
    this.log('error', `读取 [${req.start}, ${req.end}) 失败（${reason.reason}）：${reason.detail ?? ''}`, record);
    this.emit();
  }

  // 渲染用快照：每个版本视图都计算连续块与缺口，页面据此解释可拼接性。
  snapshot() {
    const s = this.state;
    const views = [];
    for (const version of [...s.views.keys()].sort((a, b) => a - b)) {
      const view = s.views.get(version);
      const {blocks, mismatches} = computeBlocks(view.fragments);
      const gaps = [];
      if (view.size != null) {
        let cursor = 0;
        for (const block of blocks) {
          if (block.start > cursor) gaps.push({start: cursor, end: block.start});
          cursor = block.end;
        }
        if (cursor < view.size) gaps.push({start: cursor, end: view.size});
      }
      const covered = blocks.reduce((n, b) => n + (b.end - b.start), 0);
      views.push({
        version, size: view.size, blocks, gaps, mismatches,
        covered, coverage: view.size ? covered / view.size : 0,
        fragmentCount: view.fragments.size,
        failures: view.failures.slice(),
        superseded: view.superseded.slice(),
      });
    }
    const busy = s.requests.filter((r) => r.seq === s.seq).map((r) => ({
      mode: r.mode, start: r.start, end: r.end, version: r.version,
    }));
    return {
      id: s.id,
      selection: s.selection ? {...s.selection} : null,
      activeVersion: s.activeVersion,
      pinnedVersion: s.pinnedVersion,
      conflict: s.conflict ? {...s.conflict} : null,
      missing: s.missing,
      lastFailure: s.lastFailure ? {...s.lastFailure} : null,
      busy, requestsInflight: s.requests.length,
      views,
      events: s.events.slice(),
    };
  }
}
