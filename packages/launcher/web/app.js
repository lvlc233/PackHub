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
  /** 一次操作的成功提示；跨轮询保留，直到下一次操作或换实例 */
  flash: null,
  health: null,
  /** 当前实例声明的入口（带能不能起的结论） */
  entries: [],
  /** 这份入口表是哪个实例的：换实例后重新取，不拿别人的入口糊上去 */
  entriesFor: null,
  entryKey: '',
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
  if (el && el.disabled !== disabled) el.disabled = disabled;
}

/**
 * 字段级错误标记：配 aria-invalid（CSS 只有这一条规则），focus 到出错的输入。
 * code 到字段的对应关系由各流程自己给，不给就只在消息区说话。
 */
function markField(el, bad) {
  if (!el) return;
  if (bad) el.setAttribute('aria-invalid', 'true');
  else el.removeAttribute('aria-invalid');
}

function focusErrorField(err, map) {
  const el = map?.[err?.code];
  if (!el) return false;
  markField(el, true);
  el.focus();
  return true;
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
    // 只在「实例集合变了」时重建节点；list.children 是活集合，边遍历边删会漏掉一半
    list.replaceChildren();
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
  state.flash = null;
  // 换实例后入口表要重新取；「覆盖本地改动」回到默认不勾
  state.entries = [];
  state.entriesFor = null;
  state.entryKey = '';
  $('#d-force').checked = false;
  clearMoreInputs();
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
  setText($('#d-entry-kind'), rec.entry ? ENTRY_TEXT[rec.entry] ?? rec.entry : '—');
  setText($('#d-endpoint'), rec.url || (rec.endpoint ? `${rec.endpoint.kind} ${rec.endpoint.value}` : '—'));
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
  // 更新按钮和「覆盖本地改动」只在有更新时出现；进行中一起禁用，按钮文案跟着 busy 走
  setText($('#d-update-btn'), state.busy === 'update' ? '更新中…' : '更新');
  setHidden($('#d-update-btn'), !hasUpdate);
  setDisabled($('#d-update-btn'), Boolean(state.busy));
  setHidden($('#d-force-row'), !hasUpdate);
  setDisabled($('#d-force'), Boolean(state.busy));
  $('#d-force-row').classList.toggle('is-busy', Boolean(state.busy));
  // 没有可更新的时候勾选没有意义；清掉，免得下次出现更新时还带着上次的勾
  if (!hasUpdate) $('#d-force').checked = false;

  setDisabled($('#d-open'), !rec.url);
  setHidden($('#d-open'), !rec.url);
  setDisabled($('#d-start'), running || !startable || Boolean(state.busy));
  setDisabled($('#d-stop'), !running || Boolean(state.busy));
  setDisabled($('#d-restart'), !startable || Boolean(state.busy));
  setDisabled($('#d-use'), isActive || Boolean(state.busy));
  setDisabled($('#d-remove'), Boolean(state.busy));
  // 「更多」里的按钮跟主按钮同一把单飞锁
  for (const id of ['#clone-go', '#rename-go', '#migrate-go', '#export-go']) {
    setDisabled($(id), Boolean(state.busy));
  }
  $('#clone-name').placeholder = `${rec.name}-copy`;
  $('#rename-name').placeholder = rec.name;

  const notes = [];
  if (state.flash) notes.push(state.flash);
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

  renderEntries(rec);
  renderHealth();
}

const ENTRY_TEXT = { web: 'Web', app: '桌面应用', tui: '终端', headless: '一次性' };

/** 当前选的入口：以下拉框为准，没选过就用记录里那个，再没有就用第一个能起的。 */
function selectedEntry(rec) {
  const value = $('#d-entry').value;
  return (
    state.entries.find((entry) => entry.kind === value) ??
    state.entries.find((entry) => entry.kind === rec.entry) ??
    state.entries.find((entry) => entry.startable) ??
    state.entries[0]
  );
}

async function loadEntries(rec) {
  state.entriesFor = rec.id;
  try {
    const entries = await api(`/api/instances/${encodeURIComponent(rec.id)}/entries`);
    if (state.selected !== rec.id) return;
    state.entries = entries;
  } catch {
    if (state.selected !== rec.id) return;
    state.entries = [];
  }
  state.entryKey = '';
  renderDetail();
}

/** 入口下拉、任务框与两个按钮的可用性都由这里定；别的字段不动。 */
function renderEntries(rec) {
  if (state.entriesFor !== rec.id) {
    void loadEntries(rec);
    return;
  }
  const selectEl = $('#d-entry');
  const running = rec.status === 'running';
  const signature = [
    rec.entry ?? '',
    rec.status,
    ...state.entries.map((entry) => `${entry.kind}:${entry.label}:${entry.startable ? 1 : 0}:${entry.needsTask ? 1 : 0}`),
  ].join('|');
  if (state.entryKey !== signature) {
    state.entryKey = signature;
    const previous = selectEl.value;
    selectEl.innerHTML = state.entries
      .map(
        (entry) =>
          `<option value="${entry.kind}"${entry.startable ? '' : ' disabled'}>${escapeHtml(entry.label)}${entry.startable ? '' : '（不可用）'}</option>`,
      )
      .join('');
    const preferred =
      (rec.entry && state.entries.some((entry) => entry.kind === rec.entry) ? rec.entry : '') ||
      (state.entries.some((entry) => entry.kind === previous) ? previous : '') ||
      state.entries.find((entry) => entry.startable)?.kind ||
      state.entries[0]?.kind;
    if (preferred) selectEl.value = preferred;
  }

  const entry = selectedEntry(rec);
  const needsTask = Boolean(entry?.needsTask);
  setHidden($('#d-task'), !needsTask);
  setDisabled($('#d-start'), running || !entry?.startable || Boolean(state.busy));
  const canOpen = running && Boolean(entry) && entry.surface !== 'none';
  setHidden($('#d-open'), !canOpen);
  setDisabled($('#d-open'), !canOpen || Boolean(state.busy));
  const note = $('#d-entry-note');
  const reason = entry && !entry.startable ? entry.reason : undefined;
  setHidden(note, !reason);
  if (reason) note.textContent = reason;
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

/**
 * 「更新会覆盖本地改动」时服务端回的是给 CLI 的文案（提到 --force）。
 * 界面上已经有勾选框，按 code + message 认出这一条换成界面里的说法；
 * 认不出（服务端以后改了文案）就原样显示，不影响别的错误。
 */
function updateErrorForUi(err) {
  const message = String(err?.message ?? '');
  if (err?.code !== 'invalid-input' || !/确认覆盖请加\s*--force/.test(message)) return err;
  const detail = message.replace(/；?\s*确认覆盖请加\s*--force.*$/, '');
  const next = new Error(`${detail}。要覆盖就勾选「覆盖本地改动」再点更新；要保留就先把这些文件备份出去。`);
  next.code = err.code;
  return next;
}

/* ---------- 操作 ---------- */

async function act(name) {
  const rec = currentRecord();
  if (!rec || state.busy) return;
  clearError();
  state.flash = null;
  if (name === 'open') {
    const entry = selectedEntry(rec);
    if (!entry || entry.surface === 'none') return;
    if (entry.surface === 'browser') {
      window.open(`/api/instances/${encodeURIComponent(rec.id)}/open`, '_blank', 'noopener');
      return;
    }
    try {
      // app / tui 没有浏览器地址：让服务端再落一次启动命令（应用聚焦、终端新开）
      await api(`/api/instances/${encodeURIComponent(rec.id)}/open`, { method: 'POST' });
      state.flash = entry.surface === 'window' ? '已请宿主开一次窗口' : '已开一个终端窗口';
      await refresh();
    } catch (err) {
      showError(err, '打开');
    }
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
      await removeFlow(rec);
      return;
    }
    const path = routes[name];
    if (!path) return;
    const chosen = name === 'start' || name === 'restart' ? selectedEntry(rec) : null;
    if (chosen?.needsTask && !$('#d-task').value.trim()) {
      const missing = new Error('一次性入口要一条任务');
      missing.hint = '在入口旁边把任务填上再启动';
      showError(missing, '启动');
      return;
    }
    state.busy = name;
    renderDetail();
    if (name === 'update') {
      // 勾了「覆盖本地改动」才带 force；默认仍是不覆盖
      const force = $('#d-force').checked;
      const result = await api(path, { method: 'POST', body: force ? { force: true } : {} });
      // 成功才清勾选；失败会走 catch，勾选保持原样，方便改主意后重试
      $('#d-force').checked = false;
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
    await api(path, { method: 'POST', body: startBody(name, rec) });
    await refresh();
    // 起来后自动打开对应面：web 是浏览器；app / tui 的窗口由宿主自己开
    if (chosen?.surface === 'browser' && currentRecord()?.url) {
      window.open(`/api/instances/${encodeURIComponent(rec.id)}/open`, '_blank', 'noopener');
    }
  } catch (err) {
    showError(name === 'update' ? updateErrorForUi(err) : err, labels[name]);
    if (name === 'health') state.health = null;
  } finally {
    state.busy = null;
    renderDetail();
  }
}

/** 启动/重起要带的 body：选中的入口，加上一次性入口的任务。 */
function startBody(name, rec) {
  if (name !== 'start' && name !== 'restart') return {};
  const entry = selectedEntry(rec);
  if (!entry) return {};
  const task = $('#d-task').value.trim();
  return { entry: entry.kind, ...(entry.needsTask && task ? { task } : {}) };
}

/* ---------- 确认对话框 ---------- */
let confirmResolve = null;

/**
 * 打开确认框，用 Promise 把结果交回调用处：确认给 { keep }，取消 / ESC 给 null。
 * `keep` 只给删除用：传了就显示「保留数据」那一行，`keep.disabled` 控制能不能勾。
 */
function askConfirm(opts) {
  // 上一份确认还挂着（极少见）：先按取消结算，别让 showModal 撞上已打开的对话框
  settleConfirm(null);
  if ($('#confirm').open) $('#confirm').close();
  return new Promise((resolve) => {
    confirmResolve = resolve;
    $('#confirm-title').textContent = opts.title;
    $('#confirm-body').textContent = opts.body;
    $('#confirm-ok').textContent = opts.ok ?? '确定';
    $('#confirm-ok').className = opts.danger ? 'danger' : 'primary';
    $('#confirm-keep-row').hidden = !opts.keep;
    $('#confirm-keep').checked = false;
    $('#confirm-keep').disabled = Boolean(opts.keep?.disabled);
    $('#confirm').showModal();
  });
}

/** 先结算再关：close() 会同步派发 close 事件，反过来会把「保留数据」的勾选吞掉。 */
function settleConfirm(value) {
  const resolve = confirmResolve;
  confirmResolve = null;
  if (resolve) resolve(value);
}

$('#confirm-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const keep = $('#confirm-keep').checked;
  settleConfirm({ keep });
  $('#confirm').close();
});
$('#confirm-cancel').addEventListener('click', () => {
  settleConfirm(null);
  $('#confirm').close();
});
$('#confirm').addEventListener('close', () => settleConfirm(null));

async function removeFlow(rec) {
  const answer = await askConfirm({
    title: `删除 ${rec.name}`,
    body: rec.managed
      ? '默认直接删掉整个实例根（Pack 装进去的文件一并消失）；勾选「保留数据」会先卸掉 Pack 文件，再把剩下的根挪进归档区。'
      : '这是接管来的目录：只会摘掉 PAL 的记录，目录里的东西一个都不动。',
    ok: '删除',
    danger: true,
    keep: { disabled: !rec.managed },
  });
  if (!answer) return;
  const keep = answer.keep ? '?keepData=1' : '';
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
    renderDetail();
  }
}

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

/* 新建对话框的三种来源：从 Pack 安装 / 接管已有目录 / 导入模板。
 * 每种来源各占一段 .src，切过去时把别的段整段 disable —— 既不会被 HTML 的 required 拦住，
 * 也不会把隐藏字段混进提交体。 */
const SOURCE = {
  pack: { title: '新建实例', ok: '创建', busy: '创建中…' },
  adopt: { title: '接管已有目录', ok: '接管', busy: '接管中…' },
  import: { title: '导入模板', ok: '导入', busy: '导入中…' },
};

let source = 'pack';

function currentSource() {
  return source;
}

function setSource(next) {
  source = SOURCE[next] ? next : 'pack';
  for (const box of document.querySelectorAll('#create-form .src')) {
    const on = box.dataset.src === source;
    box.hidden = !on;
    for (const field of box.querySelectorAll('input, select')) field.disabled = !on;
  }
  for (const label of document.querySelectorAll('#create-form .seg label')) {
    const radio = label.querySelector('input');
    const on = Boolean(radio?.checked);
    label.classList.toggle('on', on);
  }
  $('#create-title').textContent = SOURCE[source].title;
  $('#submit').textContent = SOURCE[source].ok;
}

$('#create-form').addEventListener('change', (event) => {
  if (event.target?.name === 'source') setSource(event.target.value);
});

async function openCreate() {
  const form = $('#create-form');
  form.reset();
  $('#create-msg').hidden = true;
  $('#submit').disabled = false;
  $('#create').showModal();
  setSource('pack');
  form.querySelector('input[name="pack"]').focus();

  fillHarnessSelect($('#harness-select'), $('#harness-note'));
  fillHarnessSelect($('#adopt-harness'), $('#adopt-harness-note'));
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

/** 填宿主导航，pack 段与 adopt 段各一个 select，共用这套选项与提示。 */
function fillHarnessSelect(selectEl, noteEl) {
  if (!selectEl) return;
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
    if (!noteEl) return;
    if (!harness) {
      noteEl.hidden = true;
      return;
    }
    const bits = [];
    if (harness.version) bits.push(`版本 ${harness.version}`);
    if (harness.kind === 'project') {
      if (harness.reason) bits.push(harness.reason);
    } else if (!harness.available) {
      bits.push('这台机器上还没找到命令：实例能建，但起不来');
    }
    noteEl.textContent = bits.join('；');
    noteEl.hidden = bits.length === 0;
  };
  selectEl.onchange = update;
  update();
}

/** 各来源的字段与错误 code 的对应：name-taken 指名字，root-occupied 指根/目录。 */
function createFieldOf(src, err) {
  const code = err?.code;
  const message = String(err?.message ?? '');
  if (src === 'adopt') {
    if (code === 'name-taken') return $('#adopt-name');
    if (code === 'unknown-harness') return $('#adopt-harness');
    // dir 缺席 / 不是绝对路径 / 已经是一份实例 / 目录不存在：都指回目录输入
    if (['invalid-input', 'root-occupied', 'not-found'].includes(code)) return $('#adopt-dir');
    return null;
  }
  if (src === 'import') {
    if (code === 'name-taken') return $('#import-name');
    if (code === 'root-occupied') return $('#import-root');
    if (code === 'invalid-input') {
      // 「模板文件…」与「实例根…」都是 invalid-input，只能按文案分开
      return /实例根/.test(message) ? $('#import-root') : $('#import-file');
    }
    if (code === 'not-found') return $('#import-file');
    return null;
  }
  if (code === 'name-taken') return $('#create-form input[name="name"]');
  if (code === 'invalid-input' && /home/i.test(message)) return $('#create-form input[name="fromHome"]');
  return null;
}

function buildCreatePayload(src, form) {
  if (src === 'adopt') {
    return {
      dir: $('#adopt-dir').value.trim(),
      name: $('#adopt-name').value.trim(),
      harness: $('#adopt-harness').value || 'dsh',
    };
  }
  if (src === 'import') {
    const payload = { file: $('#import-file').value.trim() };
    const name = $('#import-name').value.trim();
    const root = $('#import-root').value.trim();
    if (name) payload.name = name;
    if (root) payload.root = root;
    if (state.packs.index) payload.index = state.packs.index;
    return payload;
  }
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
  return payload;
}

/** 接管 / 导入前先确认：这两条都会写记录或真去取包，不适合点一下就跑。 */
async function confirmSource(src, payload) {
  if (src === 'adopt') {
    const answer = await askConfirm({
      title: `接管 ${payload.name}`,
      body: [
        '目录原样不动，只写一条 PAL 记录：',
        payload.dir,
        '',
        '之后删实例只摘记录，不删这个目录。',
      ].join('\n'),
      ok: '接管',
    });
    return Boolean(answer);
  }
  if (src === 'import') {
    const answer = await askConfirm({
      title: '导入模板',
      body: [
        '按模板里的 Pack 引用重新取包并建一份新实例：',
        payload.file,
        `名字：${payload.name || '（用模板里的）'}`,
        `实例根：${payload.root || '（由 PAL 分配）'}`,
      ].join('\n'),
      ok: '导入',
    });
    return Boolean(answer);
  }
  return true;
}

$('#create-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const src = currentSource();
  const target = event.target;
  const msg = $('#create-msg');
  const submit = $('#submit');
  msg.hidden = true;
  for (const el of target.querySelectorAll('[aria-invalid]')) markField(el, false);

  const payload = buildCreatePayload(src, new FormData(target));
  if (!(await confirmSource(src, payload))) return;

  const route = src === 'adopt' ? '/api/instances/adopt' : src === 'import' ? '/api/instances/import' : '/api/instances';
  submit.disabled = true;
  submit.textContent = SOURCE[src].busy;
  try {
    const rec = await api(route, { method: 'POST', body: payload });
    $('#create').close();
    state.selected = rec.id;
    state.health = null;
    state.flash = null;
    await refresh();
  } catch (err) {
    const field = createFieldOf(src, err);
    if (field) {
      markField(field, true);
      field.focus();
    }
    msg.textContent = err.hint ? `${err.message}\n${err.hint}` : err.message;
    msg.hidden = false;
  } finally {
    submit.disabled = false;
    submit.textContent = SOURCE[src].ok;
  }
});

/* ---------- 更多：克隆 / 改名 / 迁移 / 导出 ---------- */

function clearExportResult() {
  setHidden($('#export-result'), true);
  setText($('#export-path'), '');
}

function clearMoreInputs() {
  for (const id of ['#clone-name', '#clone-root', '#rename-name', '#migrate-to', '#export-out']) {
    const el = $(id);
    if (el) el.value = '';
    markField(el, false);
  }
  clearExportResult();
}

async function moreClone() {
  const rec = currentRecord();
  if (!rec || state.busy) return;
  const nameEl = $('#clone-name');
  const rootEl = $('#clone-root');
  const name = nameEl.value.trim();
  const root = rootEl.value.trim();
  clearError();
  state.flash = null;
  markField(nameEl, false);
  markField(rootEl, false);
  if (!name) {
    markField(nameEl, true);
    nameEl.focus();
    showError(new Error('复制出来的实例要一个新名字'), '克隆');
    return;
  }
  state.busy = 'clone';
  renderDetail();
  try {
    const body = root ? { name, root } : { name };
    const created = await api(`/api/instances/${encodeURIComponent(rec.id)}/clone`, { method: 'POST', body });
    state.flash = `已复制成「${created.name}」：${created.root}`;
    clearMoreInputs();
    state.selected = created.id;
    state.health = null;
    await refresh();
  } catch (err) {
    focusErrorField(err, { 'name-taken': nameEl, 'root-occupied': rootEl, 'invalid-input': rootEl });
    showError(err, '克隆');
  } finally {
    state.busy = null;
    renderDetail();
  }
}

async function moreRename() {
  const rec = currentRecord();
  if (!rec || state.busy) return;
  const nameEl = $('#rename-name');
  const name = nameEl.value.trim();
  clearError();
  state.flash = null;
  markField(nameEl, false);
  if (!name) {
    markField(nameEl, true);
    nameEl.focus();
    showError(new Error('新名字不能为空'), '改名');
    return;
  }
  state.busy = 'rename';
  renderDetail();
  try {
    const next = await api(`/api/instances/${encodeURIComponent(rec.id)}`, { method: 'PATCH', body: { name } });
    state.flash = `已改名为「${next.name}」`;
    nameEl.value = '';
    await refresh();
  } catch (err) {
    focusErrorField(err, { 'name-taken': nameEl, 'invalid-input': nameEl });
    showError(err, '改名');
  } finally {
    state.busy = null;
    renderDetail();
  }
}

async function moreMigrate() {
  const rec = currentRecord();
  if (!rec || state.busy) return;
  const toEl = $('#migrate-to');
  const to = toEl.value.trim();
  clearError();
  state.flash = null;
  markField(toEl, false);
  if (!to) {
    markField(toEl, true);
    toEl.focus();
    showError(new Error('要写到哪个目录（绝对路径）'), '迁移');
    return;
  }
  const answer = await askConfirm({
    title: `迁移 ${rec.name}`,
    body: [
      '把整个实例根挪到：',
      to,
      `现在的位置：${rec.root}`,
      '',
      '同盘是重命名，很快；跨盘（换盘符 / 换卷）会直接失败——PAL 不做跨盘复制。',
      '真要换盘：先手动把目录复制到新位置，再用「接管已有目录」把它接进来，旧目录自己删。',
      '',
      '实例必须先停止；目标目录必须还不存在。',
    ].join('\n'),
    ok: '迁移',
    danger: true,
  });
  if (!answer) return;
  state.busy = 'migrate';
  renderDetail();
  try {
    const next = await api(`/api/instances/${encodeURIComponent(rec.id)}/migrate`, { method: 'POST', body: { to } });
    state.flash = `实例根已挪到 ${next.root}`;
    toEl.value = '';
    state.health = null;
    await refresh();
  } catch (err) {
    focusErrorField(err, { 'root-occupied': toEl, 'invalid-input': toEl });
    showError(err, '迁移');
  } finally {
    state.busy = null;
    renderDetail();
  }
}

async function moreExport() {
  const rec = currentRecord();
  if (!rec || state.busy) return;
  const outEl = $('#export-out');
  const out = outEl.value.trim();
  clearError();
  state.flash = null;
  clearExportResult();
  markField(outEl, false);
  state.busy = 'export';
  renderDetail();
  try {
    const result = await api(`/api/instances/${encodeURIComponent(rec.id)}/export`, {
      method: 'POST',
      body: out ? { out } : {},
    });
    setText($('#export-path'), result.file);
    setHidden($('#export-result'), false);
    state.flash = result.template?.reproducible
      ? '模板已导出，可以拿去「导入模板」重建'
      : '模板已导出，但这份实例不可复现：模板只记它是什么，不能复原内容';
    await refresh();
  } catch (err) {
    focusErrorField(err, { 'invalid-input': outEl });
    showError(err, '导出');
  } finally {
    state.busy = null;
    renderDetail();
  }
}

async function copyExportPath() {
  const text = $('#export-path').textContent ?? '';
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    state.flash = '导出路径已复制';
  } catch {
    // 剪贴板不给写：把路径选中，让人自己按 Ctrl+C
    const range = document.createRange();
    range.selectNodeContents($('#export-path'));
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    state.flash = '浏览器不让写剪贴板：路径已选中，按 Ctrl+C 复制';
  }
  renderDetail();
}
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
$('#d-entry').addEventListener('change', () => renderDetail());
$('#d-start').addEventListener('click', () => act('start'));
$('#d-stop').addEventListener('click', () => act('stop'));
$('#d-restart').addEventListener('click', () => act('restart'));
$('#d-update-btn').addEventListener('click', () => act('update'));
$('#d-use').addEventListener('click', () => act('use'));
$('#d-health').addEventListener('click', () => act('health'));
$('#d-logs').addEventListener('click', () => act('logs'));
$('#d-remove').addEventListener('click', () => act('remove'));

$('#clone-go').addEventListener('click', () => void moreClone());
$('#rename-go').addEventListener('click', () => void moreRename());
$('#migrate-go').addEventListener('click', () => void moreMigrate());
$('#export-go').addEventListener('click', () => void moreExport());
$('#export-copy').addEventListener('click', () => void copyExportPath());

// 点「更多」以外的地方就收起来；轮询重绘不会碰 details 的 open
document.addEventListener('click', (event) => {
  const more = $('#d-more');
  if (more?.open && !more.contains(event.target)) more.open = false;
});

// 输入一改就撤掉错误标记，别让红框一直挂着
document.addEventListener('input', (event) => {
  const el = event.target;
  if (el && typeof el.removeAttribute === 'function' && el.hasAttribute?.('aria-invalid')) markField(el, false);
});

void refresh();
