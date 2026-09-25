import {ReaderSession} from './reader.mjs';

const $ = (sel) => document.querySelector(sel);
const decoder = new TextDecoder();

// 传输层：范围接口返回 206 + 版本/边界/校验头；409/404 保留错误体。
async function httpTransport({id, start, end, version, signal}) {
  const params = new URLSearchParams({start: String(start), end: String(end)});
  if (version != null) params.set('version', String(version));
  const res = await fetch(`/api/resources/${encodeURIComponent(id)}/range?${params}`, {signal});
  const body = await res.json().catch(() => null);
  return {status: res.status, body};
}

const session = new ReaderSession({transport: httpTransport});

function makeSampleText(size = 1000) {
  const lines = [];
  for (let i = 0; i < size; i += 10) lines.push(String(i).padStart(4, '0') + ' '.repeat(5) + '\n');
  return lines.join('').slice(0, size);
}

function busyText(snap) {
  if (snap.requestsInflight === 0) return '';
  const list = snap.busy.map((r) => `[${r.start},${r.end})@${r.version ?? '最新'}`).join('，');
  return `进行中：${list || '（旧选择的请求，等待其晚到响应）'}`;
}

function renderStatus(snap) {
  const el = $('#status');
  if (!snap.id) {
    el.textContent = '尚未打开资源。';
    return;
  }
  const parts = [`资源 ${snap.id}`];
  if (snap.activeVersion != null) {
    parts.push(`活动视图 v${snap.activeVersion}`);
    parts.push(snap.pinnedVersion != null ? '（已钉定版本，读取只接受该版本）' : '（跟随该版本，更新时将得到 409）');
  }
  if (snap.selection) parts.push(`当前选择 [${snap.selection.start}, ${snap.selection.end})`);
  const busy = busyText(snap);
  if (busy) parts.push(busy);
  el.textContent = parts.join(' · ');
}

function renderBanners(snap) {
  const wrap = $('#banners');
  wrap.innerHTML = '';
  if (snap.missing) {
    const div = document.createElement('div');
    div.className = 'banner missing';
    div.textContent = `资源 ${snap.id} 在服务端已删除或不存在。404 不会被当成空片段：当前版本视图保持原样，不会用空内容覆盖。请重新打开资源。`;
    wrap.appendChild(div);
  }
  if (snap.conflict) {
    const div = document.createElement('div');
    div.className = 'banner conflict';
    const c = snap.conflict;
    div.append(`版本冲突：你正在按 v${c.expectedVersion} 拼接，但服务端当前是 v${c.currentVersion ?? '未知'}。`
      + `这两个版本的字节不能拼在一起。可以保留旧版本视图做比较，或明确改读最新版本。`);
    const row = document.createElement('div');
    row.className = 'row';
    const latest = document.createElement('button');
    latest.className = 'primary';
    latest.textContent = '改读最新版本并重读当前区间';
    latest.onclick = () => session.followLatest();
    const keep = document.createElement('button');
    keep.textContent = '保留旧版本视图（忽略本次响应）';
    keep.onclick = () => session.dismissConflict();
    row.append(latest, keep);
    div.appendChild(row);
    wrap.appendChild(div);
  }
}

function renderBytes(block) {
  const pre = document.createElement('pre');
  pre.className = 'bytes';
  // TextDecoder(stream: true) 避免把多字节 UTF-8 字符在块边界处切成替换符。
  pre.textContent = decoder.decode(block.bytes);
  return pre;
}

function renderView(view, snap) {
  const div = document.createElement('div');
  div.className = 'view' + (view.version === snap.activeVersion ? ' active' : '');

  const head = document.createElement('div');
  const title = document.createElement('strong');
  title.textContent = `版本 v${view.version}`;
  head.appendChild(title);
  const size = view.size == null ? '大小未知' : `总大小 ${view.size} 字节`;
  const pct = view.size ? `已拼接 ${view.covered}/${view.size}（${(view.coverage * 100).toFixed(1)}%）` : '';
  const span = document.createElement('span');
  span.className = 'blk-head';
  span.textContent = ` · ${size} · 片段 ${view.fragmentCount} 个${pct ? ' · ' + pct : ''}`;
  head.appendChild(span);

  if (view.version === snap.activeVersion) {
    const pill = document.createElement('span');
    pill.className = 'pill ' + (snap.pinnedVersion != null ? 'pin' : 'ok');
    pill.textContent = snap.pinnedVersion != null ? '已钉定' : '活动';
    head.appendChild(pill);
  }
  div.appendChild(head);

  // 覆盖条：蓝=连续块，空白=缺口，红斜纹=重叠字节冲突。
  if (view.size) {
    const track = document.createElement('div');
    track.className = 'track';
    for (const block of view.blocks) {
      const seg = document.createElement('div');
      const conflicted = view.mismatches.some((m) => m.start >= block.start && m.end <= block.end);
      seg.className = 'blk' + (conflicted ? ' mis' : '');
      seg.style.flexGrow = String(block.end - block.start);
      seg.title = `连续块 [${block.start}, ${block.end}) 来源：${block.sources.join(', ')}`;
      track.appendChild(seg);
    }
    div.appendChild(track);
  }

  for (const block of view.blocks) {
    const p = document.createElement('div');
    p.className = 'bound';
    p.textContent = `连续块 [${block.start}, ${block.end})，由片段 ${block.sources.join(' + ')} 拼接，校验已通过：`;
    div.appendChild(p);
    div.appendChild(renderBytes(block));
  }

  for (const gap of view.gaps) {
    const p = document.createElement('div');
    p.className = 'gap';
    p.textContent = `缺口 [${gap.start}, ${gap.end})（${gap.end - gap.start} 字节）：不属于任何已校验片段，不能拼接，必须重新取。`;
    if (view.version === snap.activeVersion) {
      const btn = document.createElement('button');
      btn.textContent = '按当前版本补取该缺口';
      btn.onclick = () => session.fillGap(gap.start, gap.end);
      p.append(' ', btn);
    }
    div.appendChild(p);
  }

  for (const m of view.mismatches) {
    const p = document.createElement('div');
    p.className = 'mis-msg';
    p.textContent = `重叠冲突：片段 ${m.a} 与 ${m.b} 在 [${m.start}, ${m.end}) 的字节不一致，已拒绝合并该区域，请重新校验。`;
    div.appendChild(p);
  }

  for (const f of view.failures) {
    const p = document.createElement('div');
    p.className = 'fail';
    p.textContent = `失败记录 [${f.start}, ${f.end})：${f.reason}${f.code ? ' ' + f.code : ''} - ${f.detail ?? ''}`;
    div.appendChild(p);
  }

  if (view.superseded.length) {
    const p = document.createElement('div');
    p.className = 'hist';
    p.textContent = `晚到但校验通过、仅存为历史的片段：${view.superseded.map((x) => `[${x.start},${x.end})`).join('，')}（未覆盖当时的新选择）`;
    div.appendChild(p);
  }

  if (view.version !== snap.activeVersion) {
    const btn = document.createElement('button');
    btn.textContent = `切回 v${view.version} 比较（钉定版本）`;
    btn.onclick = () => session.pinVersion(view.version);
    div.appendChild(btn);
  } else if (snap.pinnedVersion != null) {
    const btn = document.createElement('button');
    btn.textContent = '解除钉定，跟随最新版本';
    btn.onclick = () => session.unpinVersion();
    div.appendChild(btn);
  }

  return div;
}

function renderViews(snap) {
  const wrap = $('#views');
  wrap.innerHTML = '';
  if (!snap.views.length) {
    wrap.innerHTML = '<p class="muted">读取片段后这里会按版本显示连续块、缺口、重叠冲突与历史片段。</p>';
    return;
  }
  const note = document.createElement('p');
  note.className = 'muted';
  note.textContent = '不同版本的视图互相隔离：即使字节范围相同，版本不同也不会拼接；切回旧版本只读取其已校验片段。';
  wrap.appendChild(note);
  for (const view of snap.views) wrap.appendChild(renderView(view, snap));
}

function renderEvents(snap) {
  const ul = $('#events');
  ul.innerHTML = '';
  for (const ev of [...snap.events].reverse()) {
    const li = document.createElement('li');
    li.className = ev.level;
    const t = new Date(ev.time).toLocaleTimeString();
    li.textContent = `[${t}] ${ev.message}`;
    ul.appendChild(li);
  }
}

function render(snap) {
  renderStatus(snap);
  renderBanners(snap);
  renderViews(snap);
  renderEvents(snap);
}

session.subscribe(render);

// ---- 控件 ----
$('#load-resource').onclick = () => session.selectResource($('#resource-id').value.trim());
$('#fill-v2').onclick = () => { $('#put-content').value = makeSampleText(1000); };
$('#put').onclick = async () => {
  const id = $('#resource-id').value.trim();
  const res = await fetch(`/api/resources/${encodeURIComponent(id)}`, {method: 'PUT', body: $('#put-content').value});
  const data = await res.json();
  alert(res.ok ? `已更新：${data.id} 现在是 v${data.version}（${data.size} 字节）。继续读取相邻范围将得到 409。` : `更新失败：${data.error}`);
};
$('#delete').onclick = async () => {
  const id = $('#resource-id').value.trim();
  const res = await fetch(`/api/resources/${encodeURIComponent(id)}`, {method: 'DELETE'});
  alert(res.ok ? '已删除。再次读取任何范围都会得到 404，页面不会把它显示为空内容。' : '删除失败或资源不存在。');
};
$('#read-range').onclick = () =>
  session.selectRange(Number($('#start').value), Number($('#end').value)).catch((e) => alert(e.message));
$('#read-prev').onclick = () => session.readAdjacent('prev').catch((e) => alert(e.message));
$('#read-next').onclick = () => session.readAdjacent('next').catch((e) => alert(e.message));
$('#force').onclick = () => session.forceReload().catch((e) => alert(e.message));
$('#cancel').onclick = () => session.cancel();
$('#retry').onclick = () => session.retry().catch((e) => alert(e.message));
$('#full-read').onclick = async () => {
  const id = $('#resource-id').value.trim();
  const res = await fetch(`/api/resources/${encodeURIComponent(id)}`);
  const data = await res.json();
  if (!res.ok) {
    $('#full-out').textContent = `完整读取失败：${data.error}`;
    return;
  }
  const bytes = Uint8Array.from(atob(data.bytes), (c) => c.charCodeAt(0));
  $('#full-out').textContent =
    `【旧接口 · 不参与片段拼接】id=${data.id} version=v${data.version} 完整长度=${data.size}\n`
    + `整段 checksum=${data.checksum}\n\n${decoder.decode(bytes)}`;
};

session.selectResource('sample');
$('#put-content').value = makeSampleText(1000);
