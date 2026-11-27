/* global Terminal, FitAddon */
const $ = (id) => document.getElementById(id);
const HOSTS = [
  { id: 'dsh', label: 'DSH' },
  { id: 'claude-code', label: 'Claude' },
  { id: 'codex', label: 'Codex' },
  { id: 'opencode', label: 'opencode' },
  { id: 'workbody', label: 'WorkBuddy' },
  { id: 'hermes', label: 'Hermes' },
];
const HOST_DESC = { dsh: 'DeepSeek Harness', 'claude-code': 'Claude Code', codex: 'OpenAI Codex', opencode: 'opencode', workbody: 'WorkBuddy', hermes: 'Hermes' };
const ICONS = {
  dsh: '<path d="M4 7l5 5-5 5M12 17h8"/>',
  'claude-code': '<path d="M12 3v18M4.8 7.5l14.4 9M19.2 7.5l-14.4 9"/>',
  codex: '<path d="M8 7l-4 5 4 5M16 7l4 5-4 5"/>',
  opencode: '<rect x="3" y="4" width="18" height="16" rx="3"/><path d="M7 9l3 3-3 3M13 15h4"/>',
  workbody: '<rect x="3" y="7" width="18" height="13" rx="2"/><path d="M9 7V5h6v2"/>',
  hermes: '<path d="M4 20c8-2 12-8 14-16-6 2-12 6-14 16z"/><path d="M4 20l6-6"/>',
};
function hostIcon(id) {
  const body = ICONS[id] || ICONS.dsh;
  return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">' + body + '</svg>';
}

const state = { instances: [], filter: 'all', selectedId: null, term: null, fit: null };

function toast(text, bad) {
  const node = document.createElement('div');
  node.className = 'toast' + (bad ? ' bad' : '');
  node.textContent = text;
  $('toasts').appendChild(node);
  setTimeout(() => node.remove(), bad ? 5000 : 2600);
}
function hostName(id) { const h = HOSTS.find((x) => x.id === id); return h ? h.label : id; }
function packText(inst) { return inst.pack ? `${inst.pack.name}@${inst.pack.version}` : ''; }
function statusText(inst) { return inst.status === 'running' ? '运行中' : inst.status === 'broken' || inst.status === 'failed' ? '异常' : '已安装'; }
function defaultMode(inst) { return inst.modes && inst.modes.length ? (inst.modes.find((m) => m.default) || inst.modes[0]) : null; }
function selected() { return state.instances.find((x) => x.id === state.selectedId) || null; }

async function refresh() {
  try {
    const data = await window.pal.list();
    if (!data.ok) { toast(data.error || '读取失败', true); return; }
    state.instances = data.instances;
    if (!state.selectedId || !state.instances.some((x) => x.id === state.selectedId)) {
      const running = state.instances.find((x) => x.status === 'running');
      state.selectedId = running ? running.id : (state.instances[0] ? state.instances[0].id : null);
    }
    render();
  } catch (err) {
    toast(`读取失败：${err.message || err}`, true);
  }
}

function render() {
  renderFilters();
  renderList();
  renderLaunch();
}

function renderFilters() {
  const box = $('filters');
  box.textContent = '';
  const items = [{ id: 'all', label: '全部' }, ...HOSTS];
  for (const item of items) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'filter' + (state.filter === item.id ? ' active' : '');
    b.textContent = item.label;
    b.addEventListener('click', () => { state.filter = item.id; render(); });
    box.appendChild(b);
  }
}

function visible() {
  const list = state.filter === 'all' ? state.instances.slice() : state.instances.filter((x) => x.harness === state.filter);
  return list.sort((a, b) => {
    const ar = a.status === 'running' ? 0 : 1;
    const br = b.status === 'running' ? 0 : 1;
    if (ar !== br) return ar - br;
    return String(a.name).localeCompare(String(b.name));
  });
}

function renderList() {
  const box = $('home-list');
  box.textContent = '';
  const list = visible();
  $('count').textContent = `${list.length} 个`;
  $('empty').classList.toggle('hidden', list.length > 0);
  for (const inst of list) box.appendChild(row(inst));
}

function row(inst) {
  const running = inst.status === 'running';
  const el = document.createElement('div');
  el.className = 'row' + (inst.id === state.selectedId ? ' selected' : '');
  const icon = document.createElement('div'); icon.className = 'r-icon'; icon.innerHTML = hostIcon(inst.harness);
  const main = document.createElement('div'); main.className = 'r-main';
  const name = document.createElement('div'); name.className = 'r-name'; name.textContent = inst.name;
  const meta = document.createElement('div'); meta.className = 'r-meta'; meta.textContent = packText(inst);
  main.append(name, meta);
  const host = document.createElement('div'); host.className = 'r-host'; host.textContent = hostName(inst.harness);
  const st = document.createElement('div'); st.className = 'r-state';
  const dot = document.createElement('span'); dot.className = 'dot' + (running ? ' running' : inst.status === 'broken' || inst.status === 'failed' ? ' broken' : '');
  st.append(dot, document.createTextNode(statusText(inst)));
  el.append(icon, main, host, st);
  el.addEventListener('click', () => { state.selectedId = inst.id; render(); });
  el.addEventListener('dblclick', () => launch(inst));
  return el;
}

function renderLaunch() {
  const box = $('launch');
  box.textContent = '';
  const inst = selected();
  if (!inst) {
    const p = document.createElement('div'); p.className = 'launch-empty'; p.textContent = '选一个实例，然后启动。';
    box.appendChild(p); return;
  }
  const running = inst.status === 'running';
  const mode = defaultMode(inst);
  const card = document.createElement('div'); card.className = 'launch-card';
  const label = document.createElement('div'); label.className = 'launch-label'; label.textContent = '启动';
  const head = document.createElement('div'); head.className = 'launch-head';
  const icon = document.createElement('div'); icon.className = 'launch-icon'; icon.innerHTML = hostIcon(inst.harness);
  const titles = document.createElement('div'); titles.style.minWidth = '0';
  const name = document.createElement('div'); name.className = 'launch-name'; name.textContent = inst.name;
  const sub = document.createElement('div'); sub.className = 'launch-sub'; sub.textContent = packText(inst);
  titles.append(name, sub); head.append(icon, titles);
  const chips = document.createElement('div'); chips.className = 'launch-chips';
  const c1 = document.createElement('span'); c1.className = 'chip' + (running ? ' ok' : ''); c1.textContent = statusText(inst); chips.appendChild(c1);
  const c2 = document.createElement('span'); c2.className = 'chip'; c2.textContent = hostName(inst.harness); chips.appendChild(c2);
  if (mode) { const c = document.createElement('span'); c.className = 'chip'; c.textContent = mode.label; chips.appendChild(c); }
  const meta = document.createElement('div'); meta.className = 'launch-meta';
  meta.appendChild(metaRow('路径', inst.root));
  if (inst.url) meta.appendChild(metaRow('地址', inst.url));
  if (inst.port) meta.appendChild(metaRow('端口', String(inst.port)));
  if (inst.profile) meta.appendChild(metaRow('profile', inst.profile));
  const actions = document.createElement('div'); actions.className = 'launch-actions';
  if (running) {
    const stop = document.createElement('button'); stop.type = 'button'; stop.className = 'btn danger launch'; stop.textContent = '停止';
    stop.addEventListener('click', () => stopInstance(inst)); actions.appendChild(stop);
  } else if (mode && mode.available !== false) {
    const go = document.createElement('button'); go.type = 'button'; go.className = 'btn primary launch';
    go.textContent = mode.kind === 'app' ? '启动 App' : mode.kind === 'foreground' ? '打开终端' : '启动';
    go.addEventListener('click', () => launch(inst)); actions.appendChild(go);
  } else {
    const no = document.createElement('button'); no.type = 'button'; no.className = 'btn launch'; no.textContent = '不可启动'; no.disabled = true; actions.appendChild(no);
  }
  const secondary = document.createElement('div'); secondary.className = 'launch-secondary';
  if (inst.url) {
    const open = document.createElement('button'); open.type = 'button'; open.className = 'btn block'; open.textContent = '打开页面';
    open.addEventListener('click', () => window.pal.openExternal(inst.url)); secondary.appendChild(open);
  }
  const term = document.createElement('button'); term.type = 'button'; term.className = 'btn block'; term.textContent = '终端';
  term.addEventListener('click', () => openTerminal(inst)); secondary.appendChild(term);
  actions.appendChild(secondary);
  const hint = document.createElement('div'); hint.className = 'launch-hint';
  hint.textContent = mode && mode.kind === 'foreground' ? 'TUI 会在这个窗口里打开，返回后进程继续运行。' : '双击左侧实例也可以直接启动。';
  card.append(label, head, chips, meta, actions, hint);
  box.appendChild(card);
}

function metaRow(key, value) {
  const row = document.createElement('div'); row.className = 'meta-row';
  const k = document.createElement('span'); k.textContent = key;
  const v = document.createElement('b'); v.textContent = value; v.title = value;
  row.append(k, v); return row;
}

async function launch(inst) {
  const mode = defaultMode(inst);
  if (!mode) { toast('这个实例没有启动模式', true); return; }
  if (mode.kind === 'foreground') { openTerminal(inst); return; }
  try {
    const res = await window.pal.start(inst.name, mode.id);
    if (!res.ok) { toast(`启动失败：${(res.stderr || res.stdout || '').trim()}`, true); return; }
    toast(`已启动 ${inst.name}`);
    await refresh();
    if (res.record && res.record.url) window.pal.openExternal(res.record.url);
  } catch (err) {
    toast(`启动失败：${err.message || err}`, true);
  }
}

async function stopInstance(inst) {
  try {
    const res = await window.pal.stop(inst.name);
    if (!res.ok) { toast(`停止失败：${(res.stderr || res.stdout || '').trim()}`, true); return; }
    toast(`已停止 ${inst.name}`);
    await refresh();
  } catch (err) {
    toast(`停止失败：${err.message || err}`, true);
  }
}

function ensureTerminal() {
  if (state.term) return;
  const term = new Terminal({
    fontFamily: 'Cascadia Code, Consolas, monospace', fontSize: 12.5, cursorBlink: true,
    theme: { background: '#070b12', foreground: '#d7dde7', cursor: '#22c55e' },
  });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit); term.open($('term'));
  state.term = term; state.fit = fit;
  term.onData((data) => window.pal.termInput(data));
  window.pal.onTermData((data) => term.write(data));
  window.pal.onTermExit(({ exitCode }) => term.write(`\r\n\x1b[2m[进程已退出，code ${exitCode}]\x1b[0m\r\n`));
  new ResizeObserver(() => { try { fit.fit(); window.pal.termResize(term.cols, term.rows); } catch { /* ignore */ } }).observe($('term'));
}

async function openTerminal(inst) {
  ensureTerminal();
  $('term-title').textContent = inst.name;
  $('term-sub').textContent = `${hostName(inst.harness)} · TUI`;
  $('view-term').classList.remove('hidden');
  state.term.clear();
  try { state.fit.fit(); await window.pal.termStart(inst.name, state.term.cols, state.term.rows); state.term.focus(); }
  catch (err) { toast(`打开终端失败：${err.message || err}`, true); }
}

async function installPack() {
  const host = state.filter !== 'all' ? state.filter : (selected() ? selected().harness : 'dsh');
  try {
    const res = await window.pal.install(host);
    if (res.canceled) return;
    if (!res.ok) { toast(`安装失败：${(res.stderr || res.stdout || '').trim()}`, true); return; }
    toast('安装完成');
    await refresh();
  } catch (err) {
    toast(`安装失败：${err.message || err}`, true);
  }
}

$('refresh').addEventListener('click', refresh);
$('add-pack').addEventListener('click', installPack);
$('empty-add').addEventListener('click', installPack);
$('term-hide').addEventListener('click', () => $('view-term').classList.add('hidden'));
$('term-kill').addEventListener('click', async () => {
  await window.pal.termKill();
  toast('终端已结束');
  $('view-term').classList.add('hidden');
});
refresh();
