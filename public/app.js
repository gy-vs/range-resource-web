import {RangeBrowser, base64ToBytes, bytesToText} from './range-model.mjs';

const $ = (sel) => document.querySelector(sel);

const els = {
  resourceId: $('#resource-id'),
  start: $('#start'),
  end: $('#end'),
  chunk: $('#chunk'),
  open: $('#open'),
  before: $('#read-before'),
  after: $('#read-after'),
  refetch: $('#refetch'),
  adopt: $('#adopt-version'),
  retry: $('#retry'),
  cancel: $('#cancel'),
  newSize: $('#new-size'),
  update: $('#update'),
  del: $('#delete'),
  status: $('#status'),
  meta: $('#meta'),
  tracks: $('#tracks'),
  markers: $('#markers'),
  history: $('#history'),
  preview: $('#preview'),
};

/** fetch-based transport matching the RangeBrowser transport contract. */
async function httpTransport(request, signal) {
  const params = new URLSearchParams();
  params.set('start', String(request.start));
  params.set('end', String(request.end));
  if (request.expectedVersion !== undefined && request.expectedVersion !== null) {
    params.set('expectedVersion', String(request.expectedVersion));
  }
  const res = await fetch(
    `/api/resources/${encodeURIComponent(request.id)}/ranges?${params}`,
    {signal, headers: {accept: 'application/json'}},
  );
  const value = await res.json().catch(() => null);
  if (res.status === 200 && value?.type === 'range-fragment') {
    return {ok: true, fragment: value};
  }
  if (res.status === 412 || value?.error === 'VERSION_CONFLICT') {
    return {
      ok: false, kind: 'version-conflict',
      expected: Number(value.expected), actual: Number(value.actual),
      size: value.size, contentDigest: value.contentDigest,
    };
  }
  if (res.status === 404 || value?.error === 'RESOURCE_NOT_FOUND') {
    return {ok: false, kind: 'not-found'};
  }
  if (res.status === 416 || value?.error === 'INVALID_RANGE') {
    return {ok: false, kind: 'bad-range', message: value?.message, size: value?.size};
  }
  throw new Error(value?.message ?? `HTTP ${res.status}`);
}

let browser = null;

function visibleText(bytes, max = 200) {
  const text = bytesToText(bytes)
    .replace(/[\x00-\x1F]/g, (c) => `\\x${c.charCodeAt(0).toString(16).padStart(2, '0')}`);
  return bytes.length > max ? `${text.slice(0, max)}…` : text;
}

function render() {
  if (!browser) return;
  const view = browser.buildView();

  if (view.start === null) {
    els.meta.textContent = 'no range selected';
    els.tracks.innerHTML = '';
    els.preview.textContent = '';
  } else {
    els.meta.textContent =
      `window ${view.start}-${view.end} · anchor v${view.anchorVersion ?? '?'} · ` +
      `stitched ${view.stats.stitched} bytes · gap ${view.stats.gap} bytes · ` +
      `other versions ${view.stats.foreign} bytes · pending ${view.pending}`;
  }

  // Tracks: one per version present in the window. The anchor track is the
  // only one whose bytes are considered stitchable; gaps inside it are the
  // bytes that must be re-fetched before this window is reviewable.
  els.tracks.innerHTML = '';
  for (const track of view.tracks) {
    const box = document.createElement('section');
    box.className = `track ${track.anchor ? 'anchor' : 'foreign'}`;
    const title = document.createElement('h3');
    title.textContent = `${track.anchor ? 'stitched (anchor)' : 'other version'} — v${track.version}`;
    box.append(title);
    for (const run of track.runs) {
      const row = document.createElement('div');
      row.className = `run ${run.kind === 'bytes' ? 'bytes' : 'gap'}`;
      if (run.kind === 'bytes') {
        const frag = browser.byVersion.get(run.version)
          .find((f) => f.verified && f.start <= run.start && f.end >= run.end);
        const lo = run.start - frag.start;
        const hi = run.end - frag.start;
        const bytes = base64ToBytes(frag.bytes).subarray(lo, hi);
        row.textContent = `[${run.start}-${run.end}] ${visibleText(bytes)}`;
      } else {
        row.textContent = `[${run.start}-${run.end}] ░ gap: ${run.end - run.start} byte(s) not available in v${track.version} — re-fetch required`;
      }
      box.append(row);
    }
    els.tracks.append(box);
  }

  // Markers explain why an interval cannot be shown as stitched bytes.
  els.markers.innerHTML = '';
  for (const m of view.markers) {
    const row = document.createElement('div');
    row.className = `marker ${m.kind}`;
    const where = `[${m.start}-${m.end}]`;
    if (m.kind === 'conflict') {
      row.textContent = `${where} version moved: requested against v${m.expected}, resource is v${m.actual} — not stitched; adopt v${m.actual} or re-select`;
    } else if (m.kind === 'tombstone') {
      row.textContent = `${where} resource deleted: this interval has no content in any version — never rendered as empty bytes`;
    } else if (m.kind === 'integrity') {
      row.textContent = `${where} ${m.message}`;
    } else {
      row.textContent = `${where} ${m.message ?? m.kind}${m.retryable ? ' (retry available)' : ''}`;
    }
    els.markers.append(row);
  }

  // Stitched preview only when the whole window is contiguous at the anchor.
  const stitched = view.start !== null ? browser.stitchedBytes(view.start, view.end) : null;
  els.preview.textContent = stitched
    ? bytesToText(stitched)
    : '(window is not fully covered by contiguous, verified fragments of the anchor version — gaps/markers above show exactly what is missing)';

  els.status.textContent = view.message ?? '';
  els.history.innerHTML = '';
  for (const h of view.history.slice(-12).reverse()) {
    const row = document.createElement('div');
    row.className = `hist ${h.outcome.kind}`;
    const req = h.request ? ` ${h.request.start}-${h.request.end}` +
      (h.request.expectedVersion !== undefined ? `@v${h.request.expectedVersion}` : '@latest') : '';
    row.textContent = `#${h.seq} ${h.kind}${req} → ${h.outcome.kind}${
      h.outcome.message ? ` (${h.outcome.message})` : ''}`;
    els.history.append(row);
  }
}

async function run(action) {
  try {
    await action();
  } catch (error) {
    browser.lastMessage = error.message;
  }
  render();
}

async function ensureBrowser() {
  const id = els.resourceId.value.trim() || 'sample';
  if (!browser || browser.id !== id) {
    browser = new RangeBrowser(id, {transport: httpTransport});
  }
  return browser;
}

const int = (el) => {
  const n = Number(el.value);
  if (!Number.isInteger(n) || n < 0) throw new Error(`${el.name || el.id} must be a non-negative integer`);
  return n;
};

function requireBrowser() {
  if (!browser) throw new Error('open an initial range first');
  return browser;
}

els.open.addEventListener('click', () => run(async () => {
  await ensureBrowser();
  const start = int(els.start);
  const end = int(els.end);
  if (end < start) throw new Error('end must be >= start');
  await browser.open(start, end);
}));

els.before.addEventListener('click', () => run(async () => {
  requireBrowser();
  await browser.readAdjacent('before', int(els.chunk));
}));
els.after.addEventListener('click', () => run(async () => {
  requireBrowser();
  await browser.readAdjacent('after', int(els.chunk));
}));
els.refetch.addEventListener('click', () => run(async () => {
  requireBrowser();
  await browser.refetchCurrent(int(els.start), int(els.end));
}));
els.retry.addEventListener('click', () => run(async () => {
  requireBrowser();
  await browser.retry();
}));
els.cancel.addEventListener('click', () => {
  browser?.cancel();
  render();
});
els.adopt.addEventListener('click', () => {
  if (!browser) return;
  const conflict = browser.markers.find((m) => m.kind === 'conflict');
  if (conflict) browser.adoptVersion(conflict.actual);
  render();
});

// Server-side update / delete so the version-moved scenarios are drivable
// from the page itself.
els.update.addEventListener('click', () => run(async () => {
  await ensureBrowser();
  const id = els.resourceId.value.trim() || 'sample';
  const size = Math.max(1, int(els.newSize));
  const content = new TextEncoder().encode(
    `updated at ${new Date().toISOString()}\n` +
    Array.from({length: size}, (_, i) => String(i % 10)).join(''),
  );
  const res = await fetch(`/api/resources/${encodeURIComponent(id)}`, {
    method: 'PUT', body: content,
  });
  const value = await res.json();
  if (!res.ok) throw new Error(value?.message ?? `HTTP ${res.status}`);
  browser.lastMessage = `server now has ${id} v${value.version} (${value.size} bytes)`;
}));

els.del.addEventListener('click', () => run(async () => {
  await ensureBrowser();
  const id = els.resourceId.value.trim() || 'sample';
  const res = await fetch(`/api/resources/${encodeURIComponent(id)}`, {method: 'DELETE'});
  if (!res.ok) {
    const value = await res.json().catch(() => ({}));
    throw new Error(value?.message ?? `HTTP ${res.status}`);
  }
  browser.lastMessage = `${id} deleted on the server`;
}));

render();
