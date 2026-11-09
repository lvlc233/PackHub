/* PAL 本地界面：只做增量更新。
 * 轮询不重建 DOM：列表按 id 复用节点，详情按字段赋新值，
 * 展开态/选区/正在输入的内容都不受刷新影响。 */

import { api } from './api.js';

const $ = (sel) => document.querySelector(sel);

const STATUS_TEXT = {
  installing: '安装中',
  installed: '已安装',
  running: '运行中',
  stopped: '已停止',
  broken: '异常',
  failed: '失败',
};

const state = {
  instances: [],
  broken: [],
  active: {},
  harnesses: [],
  packs: { index: null, packs: [], local: [] },
  selected: null,
  busy: null,
  error: null,
  health: null,
  offline: false,
  rows: new Map(),
  detailKey: '',
};

function setText(el, value) {
  const text = value == null ? '' : String(value);
  if (el.textContent !== text) el.textContent = text;
}

function setHidden(el, hidden) {
  if (el.hidden !== hidden) el.hidden = hidden;
}

function setDisabled(el, disabled) {
  if (el.disabled !== disabled) el.disabled = disabled;
}

function harnessOf(id) {
  return state.harnesses.find((item) => item.id === id);
}

/* ---------- 列表 ---------- */

function renderList() {
  const list = $('#list');
  const ids = state.instances.map((rec) => rec.id);
  const sameOrder =
    state.rows.size === ids.length && ids.every((id) => state.rows.has(id));
  if (!sameOrder) {
    // 只在「实例集合变了」时重建节点
    for (const node of list.children) node.remove();
    state.rows.clear();
    for (const rec of state.instances) {
      const li = document.createElement('li');
      li.className = 'item';
      li.dataset.id = rec.id;
      li.tabIndex = 0;
      li.innerHTML = '<span class="name"></span><span class="dot" aria-hidden="true"></span><span class="meta"></span>';
      li.addEventListener('click', () => select(rec.id));
      li.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          select(rec.id);
        }
      });
      list.append(li);
      state.rows.set(rec.id, {
        li,
        name: li.querySelector('.name'),
        dot: li.querySelector('.dot'),
        meta: li.querySelector('.meta'),
      });
    }
    // 重建后补一遍顺序（集合变了但顺序也可能变）
    for (const rec of state.instances) list.append(state.rows.get(rec.id).li);
  }

  $('#count').textContent = String(state.instances.length);
  setHidden($('#empty'), state.instances.length > 0);

  for (const rec of state.instances) {
    const row = state.rows.get(rec.id);
    if (!row) continue;
    setText(row.name, rec.name);
    setText(row.meta, `${rec.harness} · ${rec.pack.name}@${rec.pack.version}`);
    const dotClass = `dot ${rec.status}`;
    if (row.dot.className !== dotClass) row.dot.className = dotClass;
    const selected = rec.id === state.selected ? 'true' : 'false';
    if (row.li.getAttribute('aria-selected') !== selected) row.li.setAttribute('aria-selected', selected);
  }

  const brokenBox = $('#broken-box');
  setHidden(brokenBox, state.broken.length === 0);
  if (state.broken.length > 0) {
    const html = state.broken
      .map((bad) => `<li><span class="mono">${escapeHtml(bad.dir)}</span><br><span class="muted">${escapeHtml(bad.reason)}</span></li>`)
      .join('');
    const holder = $('#broken-list');
    if (holder.innerHTML !== html) holder.innerHTML = html;
  }
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
}

function select(id) {
  if (state.selected === id) return;
  state.selected = id;
  state.health = null;
  clearError();
  renderList();
  renderDetail();
}

/* ---------- 详情 ---------- */

function currentRecord() {
  return state.instances.find((rec) => rec.id === state.selected);
}

function renderDetail() {
  const rec = currentRecord();
  const card = $('#card');
  setHidden(card, !rec);
  setHidden($('#blank'), Boolean(rec));
  if (!rec) {
    if (state.offline) {
      $('#blank').innerHTML =
        '<p>连不上 PAL 服务。</p><p class="hint">服务可能已经退出；重新运行 <code>pal serve</code> 后点刷新。</p><p><button type="button" id="retry">重试连接</button></p>';
      $('#retry')?.addEventListener('click', () => refresh());
    } else {
      $('#blank').innerHTML = '<p>选一个实例看详情；也可以直接新建。</p>';
    }
    return;
  }

  const harness = harnessOf(rec.harness);
  const running = rec.status === 'running';
  const startable = harness ? harness.startable : true;
  const isActive = state.active[rec.harness] === rec.id;

  setText($('#d-name'), rec.name);
  setText($('#d-status'), STATUS_TEXT[rec.status] ?? rec.status);
  $('#d-status').className = `badge ${rec.status}`;
  setText($('#d-harness'), rec.harness);
  setHidden($('#d-active'), !isActive);
  setText($('#d-pack'), `${rec.pack.name}@${rec.pack.version}`);
  setText($('#d-root'), rec.root);
  setText($('#d-home'), rec.home || '—');
  setText($('#d-port'), rec.port ?? '—');
  setText($('#d-url'), rec.url || '—');
  setText($('#d-hver'), rec.harnessVersion || (harness?.version ?? '—'));
  setText(
    $('#d-exit'),
    rec.lastExit
      ? `code ${rec.lastExit.code ?? '-'} · ${rec.lastExit.at.replace('T', ' ').slice(0, 19)}${rec.lastExit.restarts ? ` · 重起 ${rec.lastExit.restarts} 次` : ''}`
      : '—',
  );

  // 有更新：索引里 latest 与装的不一样
  const latest = state.packs.packs.find((pack) => pack.name === rec.pack.name)?.latest;
  const hasUpdate = Boolean(latest && latest !== rec.pack.version);
  setHidden($('#d-update'), !hasUpdate);
  if (hasUpdate) setText($('#d-update'), `可更新到 ${latest}`);
  setHidden($('#d-update-btn'), !hasUpdate);
  setDisabled($('#d-update-btn'), Boolean(state.busy));

  setDisabled($('#d-open'), !rec.url);
  setHidden($('#d-open'), !rec.url);
  setDisabled($('#d-start'), running || !startable || Boolean(state.busy));
  setDisabled($('#d-stop'), !running || Boolean(state.busy));
  setDisabled($('#d-restart'), !startable || Boolean(state.busy));
  setDisabled($('#d-use'), isActive || Boolean(state.busy));
  setDisabled($('#d-remove'), Boolean(state.busy));

  const notes = [];
  if (!startable && harness?.reason) notes.push(`${harness.reason}`);
  if (harness && !harness.available && startable) notes.push(`宿主没装：找不到 ${rec.harness}，先装或用 PAL_*_BIN 指定路径。`);
  if (rec.status === 'broken') notes.push('进程已经不在了。可以重起，或删掉重建。');
  if (rec.status === 'failed' && rec.lastError) notes.push(`上次失败：${rec.lastError.message}`);
  if (rec.managed === false) notes.push('接管来的目录：删除只摘记录，不动这个目录。');
  setHidden($('#d-note'), notes.length === 0);
  if (notes.length > 0) $('#d-note').textContent = notes.join(' ');

  const errorEl = $('#d-error');
  setHidden(errorEl, !state.error);
  if (state.error) errorEl.textContent = state.error;

  renderHealth();
}

function renderHealth() {
  const box = $('#d-healthbox');
  const report = state.health;
  setHidden(box, !report);
  if (!report) return;
  const rows = report.checks
    .map(
      (check) =>
        `<li class="check ${check.status}"><span class="check-name">${escapeHtml(check.name)}</span><span class="check-detail">${escapeHtml(check.detail)}</span></li>`,
    )
    .join('');
  const drift = report.drift;
  const driftHtml =
    drift && (drift.missing.length || drift.changed.length)
      ? `<ul class="drift">${drift.missing
          .map((file) => `<li>缺：<span class="mono">${escapeHtml(file)}</span></li>`)
          .concat(drift.changed.map((file) => `<li>改过：<span class="mono">${escapeHtml(file)}</span></li>`))
          .join('')}</ul>`
      : '';
  const html = `<h3>体检 ${report.ok ? '<span class="ok">通过</span>' : '<span class="bad">有故障</span>'}</h3><ul class="checks">${rows}</ul>${driftHtml}`;
  if (box.innerHTML !== html) box.innerHTML = html;
}

function clearError() {
  state.error = null;
  setHidden($('#d-error'), true);
}

function showError(err, action) {
  const parts = [action ? `${action}失败：${err.message}` : err.message];
  if (err.hint) parts.push(err.hint);
  state.error = parts.join('\n');
  setHidden($('#d-error'), false);
  $('#d-error').textContent = state.error;
}

/* ---------- 操作 ---------- */

async function act(name) {
  const rec = currentRecord();
  if (!rec || state.busy) return;
  clearError();
  if (name === 'open') {
    window.open(`/api/instances/${encodeURIComponent(rec.id)}/open`, '_blank', 'noopener');
    return;
  }
  const routes = {
    start: `/api/instances/${encodeURIComponent(rec.id)}/start`,
    stop: `/api/instances/${encodeURIComponent(rec.id)}/stop`,
    restart: `/api/instances/${encodeURIComponent(rec.id)}/restart`,
    update: `/api/instances/${encodeURIComponent(rec.id)}/update`,
    use: `/api/instances/${encodeURIComponent(rec.id)}/active`,
  };
  const labels = { start: '启动', stop: '停止', restart: '重起', update: '更新', use: '设为当前' };
  try {
    if (name === 'logs') {
      await openLogs(rec);
      return;
    }
    if (name === 'health') {
      state.busy = name;
      renderDetail();
      state.health = await api(`/api/instances/${encodeURIComponent(rec.id)}/health`);
      state.busy = null;
      renderDetail();
      return;
    }
    if (name === 'remove') {
      askRemove(rec);
      return;
    }
    const path = routes[name];
    if (!path) return;
    state.busy = name;
    renderDetail();
    if (name === 'update') {
      const result = await api(path, { method: 'POST', body: {} });
      state.health = null;
      await refresh();
      if (result.changed) {
        const bits = [`${result.from} → ${result.to}`];
        if (result.removedFiles.length) bits.push(`清掉 ${result.removedFiles.length} 个旧文件`);
        if (result.localChanges.length) bits.push(`${result.localChanges.length} 个文件原来被本地改过，现在已是新版本`);
        $('#d-note').textContent = bits.join('；');
        $('#d-note').hidden = false;
      }
      return;
    }
    await api(path, { method: 'POST' });
    await refresh();
  } catch (err) {
    showError(err, labels[name]);
    if (name === 'health') state.health = null;
  } finally {
    state.busy = null;
    renderDetail();
  }
}

/* ---------- 删除确认 ---------- */

let removing = null;

function askRemove(rec) {
  removing = rec;
  $('#confirm-title').textContent = `删除 ${rec.name}`;
  $('#confirm-body').textContent = rec.managed
    ? 'Pack 装进去的文件会先卸掉；勾选「保留数据」就把整个实例根挪进归档区，否则连根删掉。'
    : '这是接管来的目录：只会摘掉 PAL 的记录，目录里的东西一个都不动。';
  $('#confirm-keep').checked = false;
  $('#confirm-keep').disabled = !rec.managed;
  $('#confirm').showModal();
}

$('#confirm-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const rec = removing;
  if (!rec) return;
  const keep = $('#confirm-keep').checked ? '?keepData=1' : '';
  $('#confirm').close();
  try {
    state.busy = 'remove';
    renderDetail();
    await api(`/api/instances/${encodeURIComponent(rec.id)}${keep}`, { method: 'DELETE' });
    if (state.selected === rec.id) state.selected = null;
    state.health = null;
    await refresh();
  } catch (err) {
    showError(err, '删除');
  } finally {
    state.busy = null;
    removing = null;
    renderDetail();
  }
});
$('#confirm-cancel').addEventListener('click', () => $('#confirm').close());

/* ---------- 新建 ---------- */

let packsLoaded = false;

async function loadPacks() {
  if (packsLoaded) return state.packs;
  try {
    state.packs = await api('/api/packs');
  } catch (err) {
    state.packs = { index: null, packs: [], local: [], error: err.message };
  }
  packsLoaded = true;
  return state.packs;
}

async function openCreate() {
  const form = $('#create-form');
  form.reset();
  $('#create-msg').hidden = true;
  $('#submit').disabled = false;
  $('#create').showModal();
  form.querySelector('input[name="pack"]').focus();

  fillHarnessSelect();
  const packs = await loadPacks();
  const options = $('#pack-options');
  const names = [
    ...packs.packs.map((pack) => pack.name),
    ...(packs.local ?? []),
  ];
  options.innerHTML = names.map((name) => `<option value="${escapeHtml(name)}"></option>`).join('');

  const pick = $('#pack-pick');
  pick.innerHTML =
    '<option value="">（手填上面的 Pack）</option>' +
    packs.packs.map((pack) => `<option value="${escapeHtml(pack.name)}">${escapeHtml(pack.title || pack.name)}</option>`).join('');
  pick.onchange = () => {
    if (!pick.value) return;
    form.querySelector('input[name="pack"]').value = pick.value;
    fillVersions(pick.value);
  };

  const hint = $('#create-hint');
  const bits = [];
  if (packs.index) bits.push(`索引：${packs.index}（${packs.packs.length} 个包）`);
  else bits.push('没有 registry 索引；可以直接填 Pack 目录、.phub 或 git+https。');
  if (packs.local?.length) bits.push(`本地 ${packs.local.length} 个 Pack 目录可选。`);
  hint.textContent = bits.join(' ');
  hint.hidden = false;
}

function fillVersions(packName) {
  const version = $('#pack-version');
  const pack = state.packs.packs.find((item) => item.name === packName);
  const versions = pack?.versions?.length ? pack.versions : [];
  version.innerHTML = ['<option value="">latest</option>']
    .concat(versions.map((v) => `<option value="${escapeHtml(v)}">${escapeHtml(v)}</option>`))
    .join('');
  if (pack?.latest) version.value = '';
}

function harnessLabel(h) {
  if (h.kind === 'project') return `${h.id}（${h.id === 'dir' ? '项目目录' : '只装配 home'}）`;
  return h.available ? h.id : `${h.id}（未安装）`;
}

function fillHarnessSelect() {
  const selectEl = $('#harness-select');
  if (selectEl.options.length === 0 && state.harnesses.length > 0) {
    selectEl.innerHTML = state.harnesses
      .map((h) => `<option value="${escapeHtml(h.id)}">${escapeHtml(harnessLabel(h))}</option>`)
      .join('');
    // 默认选一个真能起的宿主（dsh），别让人一进来就选中只装配 home 的
    const preferred = state.harnesses.find((h) => h.id === 'dsh' && h.startable)
      ?? state.harnesses.find((h) => h.startable)
      ?? state.harnesses[0];
    if (preferred) selectEl.value = preferred.id;
  }
  const update = () => {
    const harness = harnessOf(selectEl.value);
    const note = $('#harness-note');
    if (!harness) {
      note.hidden = true;
      return;
    }
    const bits = [];
    if (harness.version) bits.push(`版本 ${harness.version}`);
    if (harness.kind === 'project') {
      if (harness.reason) bits.push(harness.reason);
    } else if (!harness.available) {
      bits.push('这台机器上没找到命令：实例能建，但起不来');
    }
    note.textContent = bits.join('；');
    note.hidden = bits.length === 0;
  };
  selectEl.onchange = update;
  update();
}

$('#create-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = new FormData(event.target);
  const payload = {
    pack: String(form.get('pack') ?? '').trim(),
    name: String(form.get('name') ?? '').trim(),
    harness: String(form.get('harness') ?? 'dsh'),
  };
  const version = String(form.get('version') ?? '').trim();
  if (version) payload.version = version;
  const fromHome = String(form.get('fromHome') ?? '').trim();
  if (fromHome) payload.fromHome = fromHome;
  if (state.packs.index) payload.index = state.packs.index;

  const msg = $('#create-msg');
  const submit = $('#submit');
  msg.hidden = true;
  submit.disabled = true;
  submit.textContent = '创建中…';
  try {
    const rec = await api('/api/instances', { method: 'POST', body: payload });
    $('#create').close();
    state.selected = rec.id;
    await refresh();
  } catch (err) {
    msg.textContent = err.hint ? `${err.message}\n${err.hint}` : err.message;
    msg.hidden = false;
  } finally {
    submit.disabled = false;
    submit.textContent = '创建';
  }
});

/* ---------- 日志 ---------- */

let logsTimer = null;
let logsRec = null;

async function openLogs(rec) {
  logsRec = rec;
  $('#logs-title').textContent = `${rec.name} · 启动日志`;
  const body = await api(`/api/instances/${encodeURIComponent(rec.id)}/logs`);
  applyLogs(body);
  if (!$('#logs').open) $('#logs').showModal();
  clearInterval(logsTimer);
  logsTimer = setInterval(async () => {
    if (!logsRec || document.hidden) return;
    try {
      const next = await api(
        `/api/instances/${encodeURIComponent(logsRec.id)}/logs${logsFileQuery()}`,
      );
      applyLogs(next, true);
    } catch {
      /* 轮询失败不打扰 */
    }
  }, 1500);
}

function logsFileQuery() {
  const file = $('#logs-file').value;
  return file ? `?file=${encodeURIComponent(file)}` : '';
}

function applyLogs(body, keepScroll = false) {
  const el = $('#logs-body');
  const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 8;
  const next = body.text || '还没有启动输出。';
  if (el.textContent !== next) el.textContent = next;
  if (keepScroll && atBottom) el.scrollTop = el.scrollHeight;
  else if (!keepScroll) el.scrollTop = el.scrollHeight;

  const select = $('#logs-file');
  const files = body.files ?? [];
  const want = files.map((file) => file.name).join('|');
  if (select.dataset.want !== want) {
    select.dataset.want = want;
    select.innerHTML = files.map((file) => `<option value="${escapeHtml(file.name)}">${escapeHtml(file.name)}</option>`).join('');
    select.value = body.file;
  }
}

$('#logs-file').addEventListener('change', async () => {
  if (!logsRec) return;
  try {
    applyLogs(await api(`/api/instances/${encodeURIComponent(logsRec.id)}/logs${logsFileQuery()}`));
  } catch (err) {
    showError(err, '读日志');
  }
});

$('#logs-close').addEventListener('click', () => $('#logs').close());
$('#logs').addEventListener('close', () => {
  clearInterval(logsTimer);
  logsTimer = null;
  logsRec = null;
});

/* ---------- 刷新与轮询 ---------- */

let inflight = false;
let probed = false;

async function refresh() {
  if (inflight) return;
  inflight = true;
  try {
    // 版本只在第一次探测：之后每次轮询都不该再 spawn 宿主
    const probe = probed ? '0' : '1';
    const [list, harnesses] = await Promise.all([
      api('/api/instances'),
      api(`/api/harnesses?probe=${probe}`),
    ]);
    probed = true;
    state.offline = false;
    state.instances = list.instances;
    state.broken = list.broken ?? [];
    state.active = list.active ?? {};
    // 后续轮询不探测版本：把已经探测到的版本留着，别让界面上的版本时有时无
    const knownVersions = new Map(state.harnesses.map((h) => [h.id, h.version]));
    state.harnesses = harnesses.map((h) => {
      const previous = knownVersions.get(h.id);
      return h.version || !previous ? h : { ...h, version: previous };
    });
    if (state.selected && !state.instances.some((rec) => rec.id === state.selected)) {
      state.selected = null;
      state.health = null;
    }
    if (!state.selected && state.instances.length > 0) state.selected = state.instances[0].id;
    // 更新提示要索引里的 latest；只取一次，不跟轮询
    if (!packsLoaded) void loadPacks().then(() => {
      if (!dialogOpen()) renderDetail();
    });
    renderList();
    renderDetail();
  } catch (err) {
    state.offline = true;
    if (!currentRecord()) {
      $('#blank').hidden = false;
      $('#blank').innerHTML =
        '<p>连不上 PAL 服务。</p><p class="hint">服务可能已经退出；重新运行 <code>pal serve</code> 后点刷新。</p><p><button type="button" id="retry">重试连接</button></p>';
      $('#retry')?.addEventListener('click', () => refresh());
    } else {
      showError(err, '刷新');
    }
  } finally {
    inflight = false;
  }
}

function dialogOpen() {
  return Boolean(document.querySelector('dialog[open]'));
}

setInterval(() => {
  if (document.hidden || dialogOpen() || state.busy) return;
  void refresh();
}, 2500);

$('#new').addEventListener('click', openCreate);
$('#empty-new')?.addEventListener('click', openCreate);
$('#cancel').addEventListener('click', () => $('#create').close());
$('#refresh').addEventListener('click', () => refresh());
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') return;
  if ((event.ctrlKey || event.metaKey) && event.key === 'r') {
    event.preventDefault();
    void refresh();
  }
});

$('#d-open').addEventListener('click', () => act('open'));
$('#d-start').addEventListener('click', () => act('start'));
$('#d-stop').addEventListener('click', () => act('stop'));
$('#d-restart').addEventListener('click', () => act('restart'));
$('#d-update-btn').addEventListener('click', () => act('update'));
$('#d-use').addEventListener('click', () => act('use'));
$('#d-health').addEventListener('click', () => act('health'));
$('#d-logs').addEventListener('click', () => act('logs'));
$('#d-remove').addEventListener('click', () => act('remove'));

void refresh();
