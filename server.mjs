import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {
  createResourceStore,
  putResource,
  deleteResource,
  readRange,
  readFull,
  ResourceNotFoundError,
  InvalidRangeError,
  UnsatisfiableRangeError,
  VersionConflictError,
} from './src/resource-store.mjs';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');

// 固定的演示资源：1000 字节、每 10 字节一个编号，方便肉眼观察边界与缺口。
function makeSample(size = 1000) {
  const lines = [];
  for (let i = 0; i < size; i += 10) {
    lines.push(String(i).padStart(4, '0') + ' '.repeat(5) + '\n');
  }
  return Buffer.from(lines.join('').slice(0, size));
}

let store = putResource(createResourceStore(), 'sample', makeSample());

// 仅供测试：把内存存储恢复为初始演示状态（生产流程不调用）。
export function resetStore() {
  store = putResource(createResourceStore(), 'sample', makeSample());
}

async function readBody(req) {
  const chunks = [];
  for await (const part of req) chunks.push(part);
  return Buffer.concat(chunks);
}

function sendJson(res, code, value, headers = {}) {
  res.writeHead(code, {'content-type': 'application/json', ...headers});
  res.end(JSON.stringify(value));
}

function errorStatus(error) {
  if (error instanceof ResourceNotFoundError) return 404;
  if (error instanceof VersionConflictError) return 409;
  if (error instanceof InvalidRangeError) return 400;
  if (error instanceof UnsatisfiableRangeError) return 416;
  return 500;
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
};

async function serveStatic(res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.slice(1);
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end('forbidden');
  }
  try {
    const data = await readFile(file);
    res.writeHead(200, {'content-type': MIME[path.extname(file)] ?? 'application/octet-stream'});
    res.end(data);
  } catch {
    res.writeHead(404, {'content-type': 'application/json'});
    res.end(JSON.stringify({error: 'not found'}));
  }
}

// 片段响应统一携带协议头：调用者不解析 body 也能核对版本、边界与校验。
function rangeHeaders(result, code) {
  return {
    'content-range': `bytes ${result.start}-${Math.max(result.start, result.end - 1)}/${result.size}`,
    'x-resource-id': result.id,
    'x-resource-version': String(result.version),
    'x-range-start': String(result.start),
    'x-range-end': String(result.end),
    'x-range-satisfied': result.satisfied ? 'true' : 'false',
    'x-fragment-checksum': result.checksum,
    'accept-ranges': 'bytes',
    'etag': `"${result.id}-v${result.version}"`,
  };
}

async function handleRangeRequest(res, id, params) {
  // end 是必填：缺 end 时不允许"猜一个长度"，避免调用方误把局部当整体。
  if (!params.has('end')) throw new InvalidRangeError('end is required');
  const result = await readRange(
    store,
    id,
    params.get('start') ?? 0,
    params.get('end'),
    params.get('version') ?? undefined,
  );
  // 416 不是错误式的空响应：带上资源尺寸和实际可读边界，调用方知道"末端在哪"。
  if (result.requestedStart >= result.size || result.requestedEnd <= 0) {
    return sendJson(res, 416, {
      error: 'range has no overlap with the resource',
      type: 'UnsatisfiableRangeError',
      id,
      version: result.version,
      size: result.size,
      requestedStart: result.requestedStart,
      requestedEnd: result.requestedEnd,
    }, {'content-range': `bytes */${result.size}`});
  }
  // 206 表明这是部分内容；空交集由 416 表达，而不是 200 空体。
  return sendJson(res, 206, result, rangeHeaders(result, 206));
}

const app = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  try {
    const apiRange = url.pathname.match(/^\/api\/resources\/([^/]+)\/range$/);
    const apiItem = url.pathname.match(/^\/api\/resources\/([^/]+)$/);

    if (apiRange && req.method === 'GET') {
      return await handleRangeRequest(res, decodeURIComponent(apiRange[1]), url.searchParams);
    }

    if (apiItem) {
      const id = decodeURIComponent(apiItem[1]);
      if (req.method === 'GET') {
        // 旧流程保留：不带 start/end 返回完整内容（200），
        // 带 start/end 时继续按旧约定返回范围片段。
        if (url.searchParams.has('start') || url.searchParams.has('end')) {
          const result = await readRange(
            store, id,
            url.searchParams.get('start') ?? 0,
            url.searchParams.get('end') ?? store.items.get(id)?.length ?? 0,
            url.searchParams.get('version') ?? undefined,
          );
          return sendJson(res, 200, result, rangeHeaders(result, 200));
        }
        const full = await readFull(store, id);
        return sendJson(res, 200, full, {
          'x-resource-version': String(full.version),
          'x-fragment-checksum': full.checksum,
          'etag': `"${id}-v${full.version}"`,
        });
      }
      if (req.method === 'PUT') {
        const content = await readBody(req);
        store = putResource(store, id, content);
        const version = store.versions.get(id);
        return sendJson(res, 201, {id, version, size: content.length}, {
          'x-resource-version': String(version),
          'etag': `"${id}-v${version}"`,
        });
      }
      if (req.method === 'DELETE') {
        store = deleteResource(store, id);
        return sendJson(res, 200, {id, deleted: true});
      }
    }

    if (req.method === 'GET' && !url.pathname.startsWith('/api/')) {
      return await serveStatic(res, url.pathname);
    }
    return sendJson(res, 404, {error: 'not found'});
  } catch (error) {
    const code = errorStatus(error);
    if (code === 500) console.error(error);
    return sendJson(res, code, {
      error: error.message,
      type: error.name,
      ...(error instanceof VersionConflictError
        ? {id: error.id, expectedVersion: error.expected, currentVersion: error.actual}
        : {}),
      ...(error instanceof ResourceNotFoundError ? {id: error.id} : {}),
    });
  }
});

if (import.meta.url === `file://${process.argv[1]}`) {
  app.listen(Number(process.env.PORT ?? 4183));
}

export {app, makeSample};
