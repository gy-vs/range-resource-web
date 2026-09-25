import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {dirname, join, normalize} from 'node:path';
import {
  createResourceStore,
  putResource,
  deleteResource,
  readRange,
  readRangeStrict,
  ResourceNotFoundError,
  InvalidRangeError,
  VersionConflictError,
} from './src/resource-store.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(HERE, 'public');

function buildSample() {
  const lines = [];
  for (let line = 0; line < 400; line++) {
    lines.push(`line ${String(line).padStart(3, '0')} — sample payload byte for range review`);
  }
  return Buffer.from(lines.join('\n') + '\n');
}

let store = createResourceStore();
store = putResource(store, 'sample', buildSample());

async function body(req) {
  const chunks = [];
  for await (const part of req) chunks.push(part);
  return Buffer.concat(chunks);
}

function sendJson(res, code, value, headers = {}) {
  const clean = Object.fromEntries(Object.entries(headers).filter(([, v]) => v !== undefined));
  res.writeHead(code, {'content-type': 'application/json', ...clean});
  res.end(JSON.stringify(value));
}

function errorBody(error) {
  return {error: error.code, message: error.message};
}

function mapStoreError(res, error) {
  if (error instanceof ResourceNotFoundError) {
    return sendJson(res, 404, {...errorBody(error), id: error.id});
  }
  if (error instanceof VersionConflictError) {
    return sendJson(res, 412, {
      ...errorBody(error),
      id: error.id,
      expected: error.expected,
      actual: error.actual,
      size: error.size,
      contentDigest: error.contentDigest,
    }, {
      etag: `"${error.actual}"`,
      'x-resource-version': String(error.actual),
    });
  }
  if (error instanceof InvalidRangeError) {
    const status = error.bound === 'end' && typeof error.size === 'number' ? 416 : 400;
    return sendJson(res, status, {...errorBody(error), size: error.size ?? null}, {
      'content-range': error.size !== undefined ? `bytes */${error.size}` : undefined,
    });
  }
  throw error;
}

/**
 * Legacy endpoint, unchanged request semantics:
 *   GET /api/resources/:id[?start&end]  -> loose clamped fragment
 *   PUT /api/resources/:id             -> new version
 * New verb: DELETE.
 */
async function handleResource(req, res, id, url) {
  if (req.method === 'GET') {
    try {
      const result = readRange(
        store, id,
        url.searchParams.get('start') ?? 0,
        url.searchParams.get('end') ?? 1024,
      );
      sendJson(res, 200, result, {
        etag: `"${result.version}"`,
        'x-resource-version': String(result.version),
      });
    } catch (error) {
      if (error instanceof ResourceNotFoundError) return mapStoreError(res, error);
      throw error;
    }
    return;
  }
  if (req.method === 'PUT') {
    store = putResource(store, id, await body(req));
    const result = readRange(store, id, 0, store.items.get(id).length);
    return sendJson(res, 201, {
      id,
      version: result.version,
      size: result.size,
      contentDigest: result.contentDigest,
    }, {etag: `"${result.version}"`, 'x-resource-version': String(result.version)});
  }
  if (req.method === 'DELETE') {
    try {
      store = deleteResource(store, id);
    } catch (error) {
      if (error instanceof ResourceNotFoundError) return mapStoreError(res, error);
      throw error;
    }
    return sendJson(res, 200, {id, deleted: true});
  }
  sendJson(res, 405, {error: 'METHOD_NOT_ALLOWED', message: `${req.method} not allowed`});
}

/**
 * Strict range protocol:
 *   GET /api/resources/:id/ranges?start=&end=[&expectedVersion=]
 * Headers: If-Match: "<version>" is equivalent to expectedVersion.
 * 200 -> {type:'range-fragment', id, version, start, end, size, contentDigest, digest, bytes}
 * 412 -> version moved (fragment deliberately NOT returned)
 * 416 -> range beyond size   400 -> malformed bounds   404 -> gone
 */
function handleRange(res, id, url) {
  let expected = url.searchParams.get('expectedVersion');
  const ifMatch = url.ifMatch;
  if (expected === null && ifMatch !== undefined) {
    const m = /^\s*(?:W\/)?"?(\d+)"?\s*$/.exec(ifMatch);
    expected = m ? m[1] : ifMatch.replace(/^"|"$/g, '');
  }
  try {
    const frag = readRangeStrict(store, id, {
      start: url.searchParams.get('start') ?? undefined,
      end: url.searchParams.get('end') ?? undefined,
      expectedVersion: expected === null || expected === undefined ? undefined : Number(expected),
    });
    sendJson(res, 200, frag, {
      etag: `"${frag.version}"`,
      'x-resource-version': String(frag.version),
      'content-range': `bytes ${frag.start}-${Math.max(frag.start, frag.end - 1)}/${frag.size}`,
      'x-fragment-digest': frag.digest,
    });
  } catch (error) {
    if (error instanceof ResourceNotFoundError ||
        error instanceof VersionConflictError ||
        error instanceof InvalidRangeError) {
      return mapStoreError(res, error);
    }
    throw error;
  }
}

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
};

async function serveStatic(res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const filePath = normalize(join(PUBLIC_DIR, rel));
  if (!filePath.startsWith(PUBLIC_DIR + '/') && filePath !== PUBLIC_DIR) {
    return sendJson(res, 404, {error: 'NOT_FOUND', message: 'not found'});
  }
  try {
    const data = await readFile(filePath);
    const ext = filePath.slice(filePath.lastIndexOf('.'));
    res.writeHead(200, {'content-type': CONTENT_TYPES[ext] ?? 'application/octet-stream'});
    res.end(data);
  } catch {
    sendJson(res, 404, {error: 'NOT_FOUND', message: 'not found'});
  }
}

const app = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  url.ifMatch = req.headers['if-match'];
  try {
    const legacy = url.pathname.match(/^\/api\/resources\/([^/]+)$/);
    const ranges = url.pathname.match(/^\/api\/resources\/([^/]+)\/ranges$/);
    if (ranges) {
      if (req.method !== 'GET') {
        return sendJson(res, 405, {error: 'METHOD_NOT_ALLOWED', message: 'only GET on ranges'});
      }
      return handleRange(res, decodeURIComponent(ranges[1]), url);
    }
    if (legacy) return handleResource(req, res, decodeURIComponent(legacy[1]), url);
    if (url.pathname.startsWith('/api/')) {
      return sendJson(res, 404, {error: 'NOT_FOUND', message: 'not found'});
    }
    return serveStatic(res, url.pathname);
  } catch (error) {
    sendJson(res, 500, {error: 'INTERNAL', message: error.message});
  }
});

if (import.meta.url === `file://${process.argv[1]}`) {
  app.listen(Number(process.env.PORT ?? 4183));
}

export {app};
