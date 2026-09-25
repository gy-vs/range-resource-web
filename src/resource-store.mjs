import {createHash} from 'node:crypto';

/**
 * Resource store.
 *
 * Every successful PUT bumps an opaque integer version and records a
 * content digest (sha256 of the full content). Range fragments carry that
 * version plus a digest of the fragment itself, so a client can:
 *   - prove a fragment is byte-exact (fragment digest)
 *   - prove two fragments come from the same content (version + contentDigest)
 *   - refuse to stitch fragments from different versions
 *
 * Deleting a resource removes it entirely; reads afterwards raise
 * ResourceNotFound instead of returning an empty body.
 */

export class ResourceError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.name = 'ResourceError';
    this.code = code;
    Object.assign(this, extra);
  }
}
export class ResourceNotFoundError extends ResourceError {
  constructor(id) {
    super('RESOURCE_NOT_FOUND', `resource not found: ${id}`, {id});
    this.name = 'ResourceNotFoundError';
  }
}
export class InvalidRangeError extends ResourceError {
  constructor(message, extra) {
    super('INVALID_RANGE', message, extra);
    this.name = 'InvalidRangeError';
  }
}
export class VersionConflictError extends ResourceError {
  constructor(id, expected, actual, size, contentDigest) {
    super('VERSION_CONFLICT', `resource ${id} is at version ${actual}, expected ${expected}`, {
      id, expected, actual, size, contentDigest,
    });
    this.name = 'VersionConflictError';
  }
}

export function createResourceStore() {
  return {items: new Map(), versions: new Map(), digests: new Map()};
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

export function putResource(store, id, content) {
  const bytes = Buffer.from(content);
  const next = {
    items: new Map(store.items),
    versions: new Map(store.versions),
    digests: new Map(store.digests),
  };
  next.items.set(id, bytes);
  next.versions.set(id, (store.versions.get(id) || 0) + 1);
  next.digests.set(id, sha256(bytes));
  return next;
}

export function deleteResource(store, id) {
  if (!store.items.has(id)) throw new ResourceNotFoundError(id);
  const next = {
    items: new Map(store.items),
    versions: new Map(store.versions),
    digests: new Map(store.digests),
  };
  next.items.delete(id);
  next.versions.delete(id);
  next.digests.delete(id);
  return next;
}

export function getResourceInfo(store, id) {
  const content = store.items.get(id);
  if (!content) throw new ResourceNotFoundError(id);
  return {
    id,
    version: store.versions.get(id),
    size: content.length,
    contentDigest: store.digests.get(id),
  };
}

/**
 * Legacy loose range read retained for the original GET /api/resources/:id
 * flow: non-integer bounds are clamped to the resource, never rejected.
 * Shape stays {id, version, start, end, bytes}; size/digest fields are added
 * additively.
 */
export function readRange(store, id, start, end) {
  const content = store.items.get(id);
  if (!content) throw new ResourceNotFoundError(id);
  const safeStart = Math.max(0, Number(start) || 0);
  const safeEnd = Math.min(content.length, Number.isFinite(Number(end)) ? Number(end) : content.length);
  const lo = Math.min(safeStart, content.length);
  const hi = Math.max(lo, safeEnd);
  return {
    id,
    version: store.versions.get(id),
    start: lo,
    end: hi,
    size: content.length,
    contentDigest: store.digests.get(id),
    bytes: content.subarray(lo, hi).toString('base64'),
  };
}

function parseBound(name, raw) {
  if (raw === null || raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n)) {
    throw new InvalidRangeError(`${name} must be an integer byte offset`, {bound: name});
  }
  return n;
}

/**
 * Strict range read backing the new range protocol.
 *
 * opts: {start, end, expectedVersion}
 *   - integer-only bounds; 400/INVALID_RANGE otherwise
 *   - start >= 0, end <= size, start <= end; 416/UNSATISFIABLE_RANGE otherwise
 *   - expectedVersion, when set, is checked *before* any bytes are returned:
 *     a changed resource raises VersionConflictError carrying the current
 *     version so the client can mark the gap instead of stitching blindly
 * Returns a fragment envelope (see README §range protocol).
 */
export function readRangeStrict(store, id, opts = {}) {
  const info = getResourceInfo(store, id);
  const {version, size, contentDigest} = info;

  if (opts.expectedVersion !== undefined && opts.expectedVersion !== null) {
    const expected = Number(opts.expectedVersion);
    if (!Number.isInteger(expected) || expected !== version) {
      throw new VersionConflictError(id, opts.expectedVersion, version, size, contentDigest);
    }
  }

  if (opts.start === undefined && opts.end === undefined) {
    // Whole-resource read, but still under the strict protocol.
    const content = store.items.get(id);
    return fragment(id, version, content, 0, size, size, contentDigest);
  }

  const start = parseBound('start', opts.start);
  const end = parseBound('end', opts.end);
  if (!Number.isInteger(start) || start < 0) {
    throw new InvalidRangeError('start must be a non-negative integer', {bound: 'start'});
  }
  if (end < start) {
    throw new InvalidRangeError('end must be greater than or equal to start', {
      bound: 'end', start, end, size,
    });
  }
  if (end > size) {
    throw new InvalidRangeError('end is beyond the resource size', {
      bound: 'end', start, end, size,
    });
  }

  const content = store.items.get(id);
  return fragment(id, version, content, start, end, size, contentDigest);
}

function fragment(id, version, content, start, end, size, contentDigest) {
  const slice = content.subarray(start, end);
  return {
    type: 'range-fragment',
    id,
    version,
    start,
    end,
    size,
    contentDigest,
    digest: sha256(slice),
    bytes: slice.toString('base64'),
  };
}
