// 资源状态存储：纯函数式更新，保留每个资源的不可变内容和单调递增版本。
// 片段读取返回资源版本、实际字节边界与校验信息，供调用方做断点拼接。

export class ResourceNotFoundError extends Error {
  constructor(id) {
    super(`resource not found: ${id}`);
    this.name = 'ResourceNotFoundError';
    this.id = id;
  }
}

// 区间参数本身无法解析（缺 end、start>end、非数字）
export class InvalidRangeError extends Error {
  constructor(message) {
    super(message);
    this.name = 'InvalidRangeError';
  }
}

// 区间格式合法，但与资源没有任何交集（start >= size 或 end <= 0）
export class UnsatisfiableRangeError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UnsatisfiableRangeError';
  }
}

// 调用方要求的版本与当前版本不一致（读取期间资源被更新/删除后重建）
export class VersionConflictError extends Error {
  constructor(id, expected, actual) {
    super(`version conflict for ${id}: expected ${expected}, actual ${actual}`);
    this.name = 'VersionConflictError';
    this.id = id;
    this.expected = expected;
    this.actual = actual;
  }
}

export function createResourceStore() {
  return {items: new Map(), versions: new Map()};
}

// PUT：写入新内容并把版本 +1。空内容也是合法资源，不能被当成"空响应"。
export function putResource(store, id, content) {
  const next = {items: new Map(store.items), versions: new Map(store.versions)};
  const version = (store.versions.get(id) || 0) + 1;
  next.items.set(id, Buffer.from(content));
  next.versions.set(id, version);
  return next;
}

// DELETE：删除内容的同时删除版本记录，再次 PUT 从版本 1 重新开始。
// 资源不存在时抛 ResourceNotFoundError，删除不能静默伪装成"成功读到空"。
export function deleteResource(store, id) {
  if (!store.items.has(id)) throw new ResourceNotFoundError(id);
  const next = {items: new Map(store.items), versions: new Map(store.versions)};
  next.items.delete(id);
  next.versions.delete(id);
  return next;
}

export function getSize(store, id) {
  const content = store.items.get(id);
  if (!content) throw new ResourceNotFoundError(id);
  return content.length;
}

export function getVersion(store, id) {
  const version = store.versions.get(id);
  if (version === undefined) throw new ResourceNotFoundError(id);
  return version;
}

// 校验串覆盖请求上下文字段与片段字节，任何一项被篡改都会失配，
// 因此校验信息同时是"边界归属"和"断点拼接"的依据。
export async function fragmentChecksum(id, version, start, end, bytes) {
  const {createHash} = await import('node:crypto');
  const header = Buffer.from(`range-resource-web:${id}:${version}:${start}:${end}:`);
  return createHash('sha256').update(Buffer.concat([header, Buffer.from(bytes)])).digest('hex');
}

function parseBound(value, name, {required = false} = {}) {
  if (value === null || value === '') {
    if (required) throw new InvalidRangeError(`${name} is required`);
    return undefined;
  }
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) throw new InvalidRangeError(`${name} must be a non-negative integer`);
  return n;
}

// 读取片段。expectedVersion 存在时做条件读取：版本对不上直接 VersionConflictError，
// 而不是悄悄返回新版本的内容（防止旧视图把新版本字节拼进来）。
// 返回的 start/end 是"实际返回的边界"（夹紧到资源长度后），
// satisfied=false + rangeCovered=false 表示空交集，deleted 资源不会返回空片段。
export async function readRange(store, id, rawStart, rawEnd, expectedVersion = undefined) {
  const content = store.items.get(id);
  if (!content) throw new ResourceNotFoundError(id);
  const version = store.versions.get(id);
  if (expectedVersion !== undefined && expectedVersion !== null) {
    const expected = Number(expectedVersion);
    if (!Number.isInteger(expected)) throw new InvalidRangeError('version must be an integer');
    if (expected !== version) throw new VersionConflictError(id, expected, version);
  }
  const start = parseBound(rawStart, 'start', {required: false}) ?? 0;
  const end = parseBound(rawEnd, 'end', {required: true});
  if (start > end) throw new InvalidRangeError('start must not be greater than end');

  const safeStart = Math.min(start, content.length);
  const safeEnd = Math.min(end, content.length);
  const satisfied = safeStart < safeEnd;
  const bytes = satisfied ? content.subarray(safeStart, safeEnd) : Buffer.alloc(0);
  return {
    id,
    version,
    start: safeStart,
    end: safeEnd,
    requestedStart: start,
    requestedEnd: end,
    size: content.length,
    satisfied,
    rangeCovered: satisfied,
    bytes: bytes.toString('base64'),
    checksum: await fragmentChecksum(id, version, safeStart, safeEnd, bytes),
  };
}

// 完整读取（保留的旧流程）：返回资源整体，同样带版本与整段校验，
// 便于前端确认"完整内容"来自哪个版本，但不参与片段拼接。
export async function readFull(store, id) {
  const content = store.items.get(id);
  if (!content) throw new ResourceNotFoundError(id);
  const version = store.versions.get(id);
  return {
    id,
    version,
    start: 0,
    end: content.length,
    size: content.length,
    complete: true,
    bytes: content.toString('base64'),
    checksum: await fragmentChecksum(id, version, 0, content.length, content),
  };
}
