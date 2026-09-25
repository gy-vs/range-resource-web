/**
 * RangeBrowser — DOM-agnostic state machine for checkpointed range reading.
 *
 * Responsibilities:
 *   - keep fragments keyed by (version, byte interval); stitch only pieces
 *     that share the anchor version and whose digests verify
 *   - show gaps (never read), conflicts (resource moved on) and tombstones
 *     (resource deleted) instead of pretending they are empty content
 *   - guard concurrency: every selection gets a sequence number, a stale
 *     (late-arriving or aborted) response can never overwrite a newer choice
 *   - cancellable in-flight requests; failed requests are retryable and do
 *     not poison stored fragments
 *
 * A `transport(request, signal)` must be injected. It receives
 *   {id, start, end, expectedVersion?} and resolves to one of:
 *   {ok:true, fragment}                          fragment = envelope from server
 *   {ok:false, kind:'version-conflict', actual, size, contentDigest, expected}
 *   {ok:false, kind:'not-found'}
 *   {ok:false, kind:'bad-range', message, size?}
 * or rejects (network error); AbortError is treated as cancellation.
 */

const decoder = new TextDecoder('utf-8', {fatal: false});

export function bytesToBase64(bytes) {
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  // btoa in browsers; Buffer in node tests.
  if (typeof btoa === 'function') return btoa(binary);
  return Buffer.from(binary, 'binary').toString('base64');
}

export function base64ToBytes(b64) {
  if (typeof atob === 'function') {
    const binary = atob(b64);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
  }
  return new Uint8Array(Buffer.from(b64, 'base64'));
}

export async function sha256Hex(bytes) {
  if (typeof crypto !== 'undefined' && crypto.subtle) {
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }
  const {createHash} = await import('node:crypto');
  return createHash('sha256').update(Buffer.from(bytes)).digest('hex');
}

let seqSource = 0;

export class RangeBrowser {
  constructor(id, {transport, digest = sha256Hex} = {}) {
    if (typeof transport !== 'function') throw new Error('RangeBrowser requires a transport');
    this.id = id;
    this.transport = transport;
    this.digest = digest;
    /** @type {Map<string, Fragment[]>} version -> fragments */
    this.byVersion = new Map();
    /** @type {Marker[]} holes/conflicts/tombstones */
    this.markers = [];
    this.anchorVersion = null;
    this.viewStart = null;
    this.viewEnd = null;
    this.inflight = new Map(); // seq -> {request, signal, controller}
    this.history = []; // {seq, kind, request, outcome, at}
    this.lastMessage = null;
    this.seq = 0;
  }

  _fragmentKey(version, start, end) {
    return `${version}:${start}-${end}`;
  }

  _addFragment(frag, verified) {
    const list = this.byVersion.get(frag.version) ?? [];
    // Identical re-delivery (same version AND same interval AND same digest)
    // is idempotent; a second interval with a different digest is kept so a
    // tamper / split-version situation stays visible.
    const dup = list.find((f) => f.start === frag.start && f.end === frag.end);
    if (!dup || dup.digest !== frag.digest || dup.verified !== verified) {
      list.push({...frag, verified});
      list.sort((a, b) => a.start - b.start || a.end - b.end);
      this.byVersion.set(frag.version, list);
    }
    // Real content supersedes any marker fully inside it.
    this.markers = this.markers.filter((m) => !(m.start >= frag.start && m.end <= frag.end));
  }

  _addMarker(marker) {
    const covered = (m) => m.kind === marker.kind &&
      (m.actual ?? null) === (marker.actual ?? null) &&
      (m.expected ?? null) === (marker.expected ?? null) &&
      marker.start <= m.start && marker.end >= m.end;
    // Drop markers contained by the new one; keep partially overlapping ones
    // (they record a distinct request boundary the user may want to see).
    this.markers = this.markers.filter((m) => !covered(m));
    const overlapsSameKind = this.markers.some((m) => m.kind === marker.kind &&
      (m.actual ?? null) === (marker.actual ?? null) &&
      m.start < marker.end && m.end > marker.start);
    if (!overlapsSameKind) this.markers.push(marker);
  }

  _overlapContradiction(frag, bytes) {
    for (const other of this.byVersion.get(frag.version) ?? []) {
      if (!other.verified) continue;
      const lo = Math.max(frag.start, other.start);
      const hi = Math.min(frag.end, other.end);
      if (lo >= hi) continue;
      const a = bytes.subarray(lo - frag.start, hi - frag.start);
      const b = base64ToBytes(other.bytes).subarray(lo - other.start, hi - other.start);
      for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) return lo + i;
      }
    }
    return null;
  }

  _record(seq, kind, request, outcome) {
    this.history.push({seq, kind, request, outcome, at: new Date().toISOString()});
    this.lastMessage = outcome.message ?? outcome.kind;
  }

  async _run(seq, kind, request, {setAnchor = false, extendView = true} = {}) {
    const controller = new AbortController();
    this.inflight.set(seq, {request, controller});
    let result;
    try {
      result = await this.transport(request, controller.signal);
    } catch (error) {
      if (controller.signal.aborted || error?.name === 'AbortError') {
        // Cancelled (or a response arriving after a newer selection won —
        // that path is handled via the seq check below).
        this.inflight.delete(seq);
        if (this.seq === seq) this._record(seq, kind, request, {kind: 'cancelled'});
        return {kind: 'cancelled'};
      }
      this.inflight.delete(seq);
      if (this.seq !== seq) return {kind: 'stale'};
      this._addMarker({
        kind: 'error', start: request.start, end: request.end,
        message: error?.message ?? 'network error', retryable: true, seq,
      });
      this._record(seq, kind, request, {kind: 'network-error', message: error?.message});
      return {kind: 'network-error'};
    }
    this.inflight.delete(seq);
    if (this.seq !== seq) {
      // Late-arriving response: a newer range selection has happened. Never
      // mutate stored state from it, never overwrite the view.
      this._record(seq, kind, request, {kind: 'ignored-stale'});
      return {kind: 'stale'};
    }

    if (!result.ok) {
      if (result.kind === 'version-conflict') {
        this._addMarker({
          kind: 'conflict',
          start: request.start, end: request.end,
          expected: result.expected, actual: result.actual,
          size: result.size, contentDigest: result.contentDigest, seq,
        });
        this._record(seq, kind, request, {
          kind: 'version-conflict', expected: result.expected, actual: result.actual,
          message: `v${result.expected} no longer current; resource is v${result.actual}`,
        });
        return {kind: 'version-conflict', actual: result.actual};
      }
      if (result.kind === 'not-found') {
        this._addMarker({kind: 'tombstone', start: request.start, end: request.end, seq});
        this._record(seq, kind, request, {
          kind: 'not-found', message: 'resource was deleted',
        });
        return {kind: 'not-found'};
      }
      this._addMarker({
        kind: 'error', start: request.start, end: request.end,
        message: result.message ?? 'bad range', retryable: false, seq,
      });
      this._record(seq, kind, request, {kind: result.kind, message: result.message});
      return {kind: result.kind};
    }

    const frag = result.fragment;
    // Checkpoint verification: recompute the fragment digest. A mismatch
    // means transport corruption / a server lying about bytes; surface it
    // instead of silently stitching.
    const bytes = base64ToBytes(frag.bytes);
    let verified = false;
    try {
      verified = (await this.digest(bytes)) === frag.digest &&
        bytes.length === frag.end - frag.start;
    } catch {
      verified = false;
    }
    if (!verified) {
      this._addMarker({
        kind: 'integrity', start: frag.start, end: frag.end,
        message: 'fragment digest mismatch — refusing to stitch', seq,
      });
      this._record(seq, kind, request, {kind: 'integrity-mismatch'});
      return {kind: 'integrity-mismatch'};
    }

    // Same-version fragments overlap: the shared bytes must agree, otherwise
    // two supposedly identical checkpoints contradict each other.
    const contradiction = this._overlapContradiction(frag, bytes);
    if (contradiction) {
      this._addMarker({
        kind: 'integrity', start: frag.start, end: frag.end,
        message: `overlapping v${frag.version} fragments disagree at bytes ${contradiction}-…`, seq,
      });
      this._record(seq, kind, request, {kind: 'overlap-conflict', at: contradiction});
      return {kind: 'overlap-conflict'};
    }

    // The first successful fragment anchors the version even if the very
    // first open failed and had to be retried.
    if (setAnchor || this.anchorVersion === null) this.anchorVersion = frag.version;
    if (extendView) this._extendView(frag.start, frag.end);
    this._addFragment(frag, true);
    this._record(seq, kind, request, {
      kind: 'fragment', version: frag.version, start: frag.start, end: frag.end,
      message: `stored v${frag.version} bytes ${frag.start}-${frag.end}`,
    });
    return {kind: 'fragment', fragment: frag};
  }

  _extendView(start, end) {
    if (this.viewStart === null) {
      this.viewStart = start;
      this.viewEnd = end;
    } else {
      this.viewStart = Math.min(this.viewStart, start);
      this.viewEnd = Math.max(this.viewEnd, end);
    }
  }

  /** Select a byte interval and fetch it pinned to a version. */
  open(start, end, expectedVersion = null) {
    this.seq = ++seqSource;
    const seq = this.seq;
    this.viewStart = start;
    this.viewEnd = end;
    const request = {
      id: this.id, start, end,
      expectedVersion: expectedVersion ?? this.anchorVersion ?? undefined,
    };
    if (expectedVersion) this.anchorVersion = expectedVersion;
    return this._run(seq, 'open', request, {setAnchor: true});
  }

  /**
   * Continue reading adjacent to the current stitched view. The request is
   * pinned to the anchor version, so an updated resource produces a
   * conflict marker rather than silently mixing versions.
   */
  readAdjacent(side, length) {
    if (this.viewStart === null) throw new Error('open a range first');
    const len = Math.max(0, Math.trunc(length));
    if (len === 0) return Promise.resolve({kind: 'noop'});
    this.seq = ++seqSource;
    const seq = this.seq;
    const start = side === 'before' ? Math.max(0, this.viewStart - len) : this.viewEnd;
    const end = side === 'before' ? this.viewStart : this.viewEnd + len;
    if (end <= start) return Promise.resolve({kind: 'noop'});
    // The reviewed window grows immediately, so a conflict / gap / error for
    // the requested neighborhood stays visible (it is not blank space).
    this.viewStart = Math.min(this.viewStart, start);
    this.viewEnd = Math.max(this.viewEnd, end);
    const request = {id: this.id, start, end, expectedVersion: this.anchorVersion};
    return this._run(seq, `adjacent:${side}`, request);
  }

  /**
   * Re-select an old interval for comparison. Uses a fresh sequence so any
   * still-pending request becomes stale; passes no expected version so the
   * server answers with whatever is current. The review window is NOT
   * shrunk: previously explored neighborhoods (and their markers) remain
   * visible alongside the re-fetched interval.
   */
  refetchCurrent(start, end) {
    this.seq = ++seqSource;
    const seq = this.seq;
    if (this.viewStart === null) {
      this.viewStart = start;
      this.viewEnd = end;
    } else {
      this.viewStart = Math.min(this.viewStart, start);
      this.viewEnd = Math.max(this.viewEnd, end);
    }
    const request = {id: this.id, start, end};
    return this._run(seq, 'refetch', request);
  }

  /**
   * After a conflict, adopt the new version as the anchor for going forward.
   * Old fragments stay in byVersion and remain visible in the view as
   * "foreign" runs, which is exactly what comparison needs.
   */
  adoptVersion(version) {
    this.anchorVersion = version;
    this.lastMessage = `anchor version is now v${version}; older fragments are shown separately`;
  }

  /** Retry the most recent failed (retryable) request for the view. */
  retry() {
    this.seq = ++seqSource;
    const seq = this.seq;
    const last = [...this.history].reverse().find((h) =>
      h.request && (h.outcome.kind === 'network-error'));
    const request = last
      ? {...last.request, expectedVersion: this.anchorVersion ?? last.request.expectedVersion}
      : {id: this.id, start: this.viewStart, end: this.viewEnd, expectedVersion: this.anchorVersion};
    return this._run(seq, 'retry', request);
  }

  cancel() {
    this.seq = ++seqSource; // every pending response is stale from now on
    for (const {controller} of this.inflight.values()) controller.abort();
    this.inflight.clear();
  }

  get pendingCount() {
    return this.inflight.size;
  }

  /**
   * Build the reviewable view for [viewStart, viewEnd).
   * Anchor-version fragments form one stitched track; any other versions
   * present in the window are exposed as separate comparison tracks. Gaps,
   * conflicts, tombstones and errors are explicit runs.
   */
  buildView() {
    const {viewStart: start, viewEnd: end} = this;
    if (start === null) {
      return {
        start: null, end: null, anchorVersion: this.anchorVersion,
        tracks: [], markers: [], stats: {stitched: 0, gap: 0, foreign: 0},
        message: this.lastMessage,
      };
    }

    const clip = (s, e) => [Math.max(start, s), Math.min(end, e)];
    const versions = [...this.byVersion.keys()].sort((a, b) =>
      a === this.anchorVersion ? -1 : b === this.anchorVersion ? 1 : a - b);

    const tracks = versions.map((version) => {
      const frags = this.byVersion.get(version)
        .filter((f) => f.verified && f.start < end && f.end > start)
        .map((f) => ({...f, start: Math.max(f.start, start), end: Math.min(f.end, end)}))
        .sort((a, b) => a.start - b.start);
      const runs = [];
      let cursor = start;
      for (const f of frags) {
        if (f.start > cursor) {
          runs.push({kind: 'gap', start: cursor, end: f.start});
        }
        const last = runs[runs.length - 1];
        if (last?.kind === 'bytes') {
          last.end = f.end;
        } else {
          runs.push({kind: 'bytes', start: f.start, end: f.end, version});
        }
        cursor = Math.max(cursor, f.end);
      }
      if (cursor < end) runs.push({kind: 'gap', start: cursor, end});
      return {version, anchor: version === this.anchorVersion, runs};
    });

    const visibleMarkers = this.markers
      .filter((m) => m.start < end && m.end > start)
      .map((m) => ({...m, start: Math.max(m.start, start), end: Math.min(m.end, end)}))
      .sort((a, b) => a.start - b.start || b.end - a.end);

    const anchorTrack = tracks.find((t) => t.anchor) ?? tracks[0];
    let stitched = 0;
    let gap = end - start;
    if (anchorTrack) {
      stitched = anchorTrack.runs.filter((r) => r.kind === 'bytes')
        .reduce((n, r) => n + r.end - r.start, 0);
      gap -= stitched;
    }
    const foreign = tracks.filter((t) => !t.anchor).reduce((n, t) =>
      n + t.runs.filter((r) => r.kind === 'bytes').reduce((m, r) => m + r.end - r.start, 0), 0);

    return {
      start, end,
      anchorVersion: this.anchorVersion,
      tracks,
      markers: visibleMarkers,
      stats: {stitched, gap, foreign},
      message: this.lastMessage,
      pending: this.pendingCount,
      history: this.history,
    };
  }

  /**
   * Concatenate the anchor-version bytes covering [lo,hi). Coverage is the
   * union of stored verified fragments (overlaps allowed); any uncovered
   * byte means a gap and returns null.
   */
  stitchedBytes(lo, hi) {
    const frags = (this.byVersion.get(this.anchorVersion) ?? [])
      .filter((f) => f.verified && f.end > lo && f.start < hi)
      .sort((a, b) => a.start - b.start);
    const out = new Uint8Array(hi - lo);
    const covered = new Uint8Array(hi - lo);
    for (const f of frags) {
      const s = Math.max(f.start, lo);
      const e = Math.min(f.end, hi);
      const part = base64ToBytes(f.bytes).subarray(s - f.start, e - f.start);
      for (let i = 0; i < part.length; i++) {
        const at = s - lo + i;
        if (covered[at] && out[at] !== part[i]) return null; // disagreement
        out[at] = part[i];
        covered[at] = 1;
      }
    }
    for (let i = 0; i < covered.length; i++) if (!covered[i]) return null;
    return out;
  }
}

export function bytesToText(bytes) {
  return decoder.decode(bytes);
}
