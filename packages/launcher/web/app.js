const $ = (sel) => document.querySelector(sel);

const state = {
  instances: [],
  active: {},
  selected: null,
  busy: false,
  error: null,
};

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'content-type': 'application/json' },
    ...options,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
  return body;
}

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
}

const STATUS_TEXT = { running: '运行中', installed: '已安装', stopped: '已停止', broken: '异常', planned: '计划' };

function statusOf(rec) {
  return STATUS_TEXT[rec.status] ?? rec.status;
}

async function load() {
  const [instances, active] = await Promise.all([api('/api/instances'), api('/api/active')]);
  state.instances = instances;
  state.active = Object.fromEntries(active.map((entry) => [entry.harness, entry.id]));
  const ids = new Set(instances.map((i) => i.id));
  if (state.selected && !ids.has(state.selected)) state.selected = null;
  if (!state.selected && instances.length > 0) state.selected = instances[0].id;
  render();
}

function render() {
  const list = $('#list');
  $('#count').textContent = String(state.instances.length);
  $('#empty').hidden = state.instances.length > 0;
  list.innerHTML = state.instances
    .map((rec) => {
      const selected = rec.id === state.selected;
      return `<li class="item" data-id="${esc(rec.id)}" aria-selected="${selected}" tabindex="0">
        <span class="name">${esc(rec.name)}</span>
        <span class="dot ${esc(rec.status)}" aria-hidden="true"></span>
        <span class="meta">${esc(rec.harness)} · ${esc(rec.pack.name)}@${esc(rec.pack.version)}</span>
      </li>`;
    })
    .join('');

  for (const item of list.querySelectorAll('.item')) {
    const select = () => {
      state.selected = item.dataset.id;
      render();
    };
    item.addEventListener('click', select);
    item.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        select();
      }
    });
  }

  renderDetail();
}

function renderDetail() {
  const el = $('#detail');
  const rec = state.instances.find((entry) => entry.id === state.selected);
  if (!rec) {
    el.innerHTML = '<div class="blank"><p>选一个实例看详情；也可以直接新建。</p></div>';
    return;
  }
  const isActive = state.active[rec.harness] === rec.id;
  const running = rec.status === 'running';
  const url = rec.url
    ? `<dd><span class="url">${esc(rec.url)}<button class="ghost" data-act="open" type="button">打开</button></span></dd>`
    : '<dd class="muted">—</dd>';
  el.innerHTML = `
    <article class="card">
      <div class="title-row">
        <h1>${esc(rec.name)}</h1>
        <span class="badge ${esc(rec.status)}">${statusOf(rec)}</span>
        <span class="muted">${esc(rec.harness)}</span>
        ${isActive ? '<span class="badge">当前</span>' : ''}
      </div>
      <dl class="kv">
        <dt>Pack</dt><dd>${esc(rec.pack.name)}@${esc(rec.pack.version)}</dd>
        <dt>实例根</dt><dd class="mono">${esc(rec.root)}</dd>
        <dt>home</dt><dd class="mono">${esc(rec.home ?? '—')}</dd>
        <dt>端口</dt><dd>${rec.port ?? '—'}</dd>
        <dt>地址</dt>${url}
      </dl>
      <div class="actions-row">
        ${running
          ? '<button class="primary" data-act="stop" type="button">停止</button>'
          : '<button class="primary" data-act="start" type="button">启动</button>'}
        <button data-act="use" type="button" ${isActive ? 'disabled' : ''}>设为当前</button>
        <button data-act="logs" type="button">启动日志</button>
        <span style="flex:1"></span>
        <button class="danger" data-act="remove" type="button">删除</button>
      </div>
      ${running && rec.url ? '<p class="hint">点「打开」在浏览器里用这个实例；停止后端口会释放。</p>' : ''}
      ${rec.status === 'broken' ? '<p class="hint">进程已经不在了。可以重新启动，或删掉重建。</p>' : ''}
      ${state.error ? `<p class="msg" role="alert">${esc(state.error)}</p>` : ''}
    </article>`;

  el.querySelectorAll('[data-act]').forEach((button) => {
    button.addEventListener('click', () => act(button.dataset.act, rec));
  });
}

async function act(action, rec) {
  if (state.busy) return;
  try {
    if (action === 'open') {
      window.open(rec.url, '_blank', 'noopener');
      return;
    }
    state.busy = true;
    if (action === 'start') {
      await api(`/api/instances/${encodeURIComponent(rec.id)}/start`, { method: 'POST' });
    } else if (action === 'stop') {
      await api(`/api/instances/${encodeURIComponent(rec.id)}/stop`, { method: 'POST' });
    } else if (action === 'use') {
      await api(`/api/instances/${encodeURIComponent(rec.id)}/active`, { method: 'POST' });
    } else if (action === 'remove') {
      if (!window.confirm(`删除实例 ${rec.name}？实例根会一起删掉。`)) return;
      await api(`/api/instances/${encodeURIComponent(rec.id)}`, { method: 'DELETE' });
      if (state.selected === rec.id) state.selected = null;
    } else if (action === 'logs') {
      await showLogs(rec);
      return;
    }
    state.error = null;
    await load();
  } catch (err) {
    state.error = err.message;
    render();
  } finally {
    state.busy = false;
  }
}

let logsTimer = null;

async function showLogs(rec) {
  const body = await api(`/api/instances/${encodeURIComponent(rec.id)}/logs`);
  $('#logs-title').textContent = `${rec.name} · 启动日志`;
  $('#logs-body').textContent = body.log || '还没有启动记录。';
  if (!$('#logs').open) $('#logs').showModal();
  clearInterval(logsTimer);
  logsTimer = setInterval(async () => {
    try {
      const next = await api(`/api/instances/${encodeURIComponent(rec.id)}/logs`);
      const el = $('#logs-body');
      const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 8;
      el.textContent = next.log || '还没有启动记录。';
      if (atBottom) el.scrollTop = el.scrollHeight;
    } catch {
      /* 轮询失败不打扰 */
    }
  }, 2000);
}

function stopLogs() {
  clearInterval(logsTimer);
  logsTimer = null;
}

async function openCreate() {
  const form = $('#create-form');
  form.reset();
  $('#create-msg').hidden = true;
  $('#submit').disabled = false;
  $('#create').showModal();
  form.querySelector('input[name="pack"]').focus();

  const hint = $('#create-hint');
  const options = $('#pack-options');
  options.innerHTML = '';
  hint.hidden = true;
  try {
    const data = await api('/api/packs');
    if (data.index && data.packs.length > 0) {
      options.innerHTML = data.packs
        .map((pack) => `<option value="${esc(pack.name)}">${esc(pack.title || pack.latest)}</option>`)
        .join('');
      hint.textContent = `索引里有 ${data.packs.length} 个包，可以直接输入名字挑（${data.index}）。`;
      hint.hidden = false;
    } else if (!data.index) {
      hint.textContent = '没有配置 registry 索引（PACKHUB_INDEX 或 ~/.packhub/config.json）；也可以直接填 Pack 目录、.phub 或 git+https。';
      hint.hidden = false;
    }
  } catch (err) {
    hint.textContent = err.message;
    hint.hidden = false;
  }
}

$('#new').addEventListener('click', openCreate);
$('#empty-new')?.addEventListener('click', openCreate);
$('#cancel').addEventListener('click', () => $('#create').close());
$('#refresh').addEventListener('click', load);
$('#logs-close').addEventListener('click', () => $('#logs').close());
$('#logs').addEventListener('close', stopLogs);

$('#create-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = new FormData(event.target);
  const payload = {
    pack: String(form.get('pack') ?? '').trim(),
    name: String(form.get('name') ?? '').trim(),
    harness: String(form.get('harness') ?? 'dir'),
    index: String(form.get('index') ?? '').trim(),
  };
  const msg = $('#create-msg');
  const submit = $('#submit');
  msg.hidden = true;
  submit.disabled = true;
  submit.textContent = '创建中…';
  try {
    const rec = await api('/api/instances', { method: 'POST', body: JSON.stringify(payload) });
    $('#create').close();
    state.selected = rec.id;
    await load();
  } catch (err) {
    msg.textContent = err.message;
    msg.hidden = false;
  } finally {
    submit.disabled = false;
    submit.textContent = '创建';
  }
});

load();
setInterval(() => {
  if (document.hidden || $('dialog[open]')) return;
  load().catch(() => {});
}, 3000);
