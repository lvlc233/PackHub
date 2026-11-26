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

const state = {
  instances: [],
  harness: null,
  home: null,
  term: null,
  fit: null,
  termName: null,
};

function toast(text, bad) {
  const node = document.createElement('div');
  node.className = 'toast' + (bad ? ' bad' : '');
  node.textContent = text;
  $('toasts').appendChild(node);
  setTimeout(() => node.remove(), bad ? 5000 : 2600);
}
function showError(text) {
  const bar = $('errbar');
  bar.textContent = text;
  bar.classList.remove('hidden');
}
function clearError() { $('errbar').classList.add('hidden'); }
function hostName(id) { const h = HOSTS.find((x) => x.id === id); return h ? h.label : id; }
function packText(inst) { return inst.pack ? `${inst.pack.name}@${inst.pack.version}` : ''; }
function statusText(inst) { return inst.status === 'running' ? '运行中' : inst.status === 'broken' || inst.status === 'failed' ? '异常' : '已安装'; }
function defaultMode(inst) {
  if (!inst.modes || !inst.modes.length) return null;
  return inst.modes.find((m) => m.default) || inst.modes[0];
}
function homesOf(harness) { return state.instances.filter((x) => x.harness === harness); }
function currentHome(harness) {
  const list = homesOf(harness);
  return list.find((x) => x.id === state.home) || list.find((x) => x.status === 'running') || list[0] || null;
}

async function refresh() {
  try {
    const data = await window.pal.list();
    if (!data.ok) { showError(data.error || '读取失败'); return; }
    state.instances = data.instances;
    if (!state.harness) {
      const running = state.instances.find((x) => x.status === 'running');
      state.harness = running ? running.harness : (state.instances[0] ? state.instances[0].harness : HOSTS[0].id);
    }
    clearError();
    render();
  } catch (err) {
    showError(`读取失败：${err.message || err}`);
  }
}

function render() {
  renderHarnesses();
  const host = state.harness;
  $('title').textContent = hostName(host);
  $('sub').textContent = HOST_DESC[host] || host;
  const homes = homesOf(host);
  const home = currentHome(host);
  state.home = home ? home.id : null;
  renderHero(home);
  renderRunning();
  renderPacks(homes, home);
}

function renderHarnesses() {
  const box = $('harness-list');
  box.textContent = '';
  for (const h of HOSTS) {
    const list = homesOf(h.id);
    const running = list.some((x) => x.status === 'running');
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'harness' + (state.harness === h.id ? ' active' : '');
    const mark = document.createElement('span'); mark.className = 'mark'; mark.textContent = h.label.slice(0, 1).toUpperCase();
    const name = document.createElement('span'); name.className = 'name'; name.textContent = h.label;
    const dot = document.createElement('span'); dot.className = 'dot' + (running ? ' running' : '');
    b.append(mark, name, dot);
    b.addEventListener('click', () => { state.harness = h.id; state.home = null; render(); });
    box.appendChild(b);
  }
}

function renderHero(inst) {
  const hero = $('hero');
  hero.textContent = '';
  if (!inst) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.innerHTML = '<div class="big">+</div><h3>这个 harness 还没有整合包</h3><p>点下面的「添加整合包」，选一个 Pack 目录。</p>';
    hero.appendChild(empty);
    return;
  }
  const running = inst.status === 'running';
  const mode = defaultMode(inst);
  const box = document.createElement('div'); box.className = 'hero';
  const main = document.createElement('div'); main.className = 'hero-main';
  const mark = document.createElement('div'); mark.className = 'hero-mark'; mark.textContent = hostName(inst.harness).slice(0, 1).toUpperCase();
  const copy = document.createElement('div');
  const eyebrow = document.createElement('div'); eyebrow.className = 'eyebrow'; eyebrow.textContent = `${HOST_DESC[inst.harness] || inst.harness} · ${inst.attached ? 'attached home' : 'managed home'}`;
  const title = document.createElement('h2'); title.textContent = inst.name;
  const sub = document.createElement('p'); sub.className = 'sub'; sub.textContent = packText(inst);
  const chips = document.createElement('div'); chips.className = 'chips';
  const chipStatus = document.createElement('span'); chipStatus.className = 'chip' + (running ? ' ok' : ''); chipStatus.textContent = statusText(inst);
  chips.appendChild(chipStatus);
  if (mode) { const c = document.createElement('span'); c.className = 'chip'; c.textContent = mode.label; chips.appendChild(c); }
  if (inst.port) { const c = document.createElement('span'); c.className = 'chip'; c.textContent = `端口 ${inst.port}`; chips.appendChild(c); }
  const count = document.createElement('span'); count.className = 'chip'; count.textContent = `${homesOf(inst.harness).length} 个整合包`; chips.appendChild(count);
  copy.append(eyebrow, title, sub, chips);
  main.append(mark, copy);

  const actions = document.createElement('div'); actions.className = 'hero-actions';
  if (running) {
    const stop = document.createElement('button'); stop.type = 'button'; stop.className = 'btn xl hero-stop'; stop.textContent = '停止';
    stop.addEventListener('click', () => stopInstance(inst));
    actions.appendChild(stop);
  } else if (mode && mode.available !== false) {
    const start = document.createElement('button'); start.type = 'button'; start.className = 'btn primary xl';
    start.textContent = mode.kind === 'app' ? '启动 App' : mode.kind === 'foreground' ? '打开终端' : '启动';
    start.addEventListener('click', () => launch(inst, mode));
    actions.appendChild(start);
  } else {
    const no = document.createElement('button'); no.type = 'button'; no.className = 'btn xl'; no.textContent = '不可启动'; no.disabled = true;
    actions.appendChild(no);
  }
  const second = document.createElement('div'); second.className = 'hero-secondary';
  if (inst.url) {
    const open = document.createElement('button'); open.type = 'button'; open.className = 'btn'; open.textContent = '打开页面';
    open.addEventListener('click', () => window.pal.openExternal(inst.url));
    second.appendChild(open);
  }
  const term = document.createElement('button'); term.type = 'button'; term.className = 'btn'; term.textContent = '终端';
  term.addEventListener('click', () => openTerminal(inst));
  second.appendChild(term);
  actions.appendChild(second);
  box.append(main, actions);
  hero.appendChild(box);
}

function renderRunning() {
  const strip = $('running-strip');
  strip.textContent = '';
  const running = state.instances.filter((x) => x.status === 'running');
  if (!running.length) return;
  const label = document.createElement('span'); label.className = 'label'; label.textContent = '正在运行';
  strip.appendChild(label);
  for (const inst of running) {
    const item = document.createElement('span'); item.className = 'item';
    const b = document.createElement('b'); b.textContent = inst.name; item.appendChild(b);
    if (inst.url) {
      const a = document.createElement('a'); a.href = inst.url; a.textContent = '打开';
      a.addEventListener('click', (e) => { e.preventDefault(); window.pal.openExternal(inst.url); });
      item.appendChild(a);
    }
    strip.appendChild(item);
  }
}

function renderPacks(homes, home) {
  const grid = $('pack-grid');
  grid.textContent = '';
  $('pack-count').textContent = homes.length ? `${homes.length} 个` : '';
  $('empty').classList.toggle('hidden', homes.length > 0);
  for (const inst of homes) grid.appendChild(packCard(inst, home));
  const add = document.createElement('button'); add.type = 'button'; add.className = 'add-pack'; add.textContent = '+ 添加整合包';
  add.addEventListener('click', installPack);
  grid.appendChild(add);
}

function packCard(inst, current) {
  const running = inst.status === 'running';
  const mode = defaultMode(inst);
  const card = document.createElement('div');
  card.className = 'pack' + (current && current.id === inst.id ? ' selected' : '');
  const mark = document.createElement('div'); mark.className = 'mark'; mark.textContent = hostName(inst.harness).slice(0, 1).toUpperCase();
  const main = document.createElement('div'); main.className = 'pack-main';
  const name = document.createElement('div'); name.className = 'pack-name'; name.textContent = inst.name;
  const meta = document.createElement('div'); meta.className = 'pack-meta'; meta.textContent = packText(inst);
  const st = document.createElement('div'); st.className = 'pack-state';
  const dot = document.createElement('span'); dot.className = 'status' + (running ? ' running' : '');
  st.append(dot, document.createTextNode(statusText(inst)));
  main.append(name, meta, st);
  const acts = document.createElement('div'); acts.className = 'pack-actions';
  if (running) {
    const stop = document.createElement('button'); stop.type = 'button'; stop.className = 'btn'; stop.textContent = '停止';
    stop.addEventListener('click', (e) => { e.stopPropagation(); stopInstance(inst); });
    acts.appendChild(stop);
  } else if (mode && mode.available !== false) {
    const go = document.createElement('button'); go.type = 'button'; go.className = 'btn primary'; go.textContent = mode.kind === 'foreground' ? '终端' : '启动';
    go.addEventListener('click', (e) => { e.stopPropagation(); launch(inst, mode); });
    acts.appendChild(go);
  }
  card.append(mark, main, acts);
  card.addEventListener('click', () => { state.home = inst.id; render(); });
  return card;
}

async function launch(inst, mode) {
  if (mode.kind === 'foreground') { openTerminal(inst); return; }
  try {
    const res = await window.pal.start(inst.name, mode.id);
    if (!res.ok) { showError(`启动失败：${(res.stderr || res.stdout || '').trim()}`); return; }
    toast(`已启动 ${inst.name}`);
    await refresh();
    const record = res.record;
    if (record && record.url) window.pal.openExternal(record.url);
  } catch (err) {
    showError(`启动失败：${err.message || err}`);
  }
}

async function stopInstance(inst) {
  try {
    const res = await window.pal.stop(inst.name);
    if (!res.ok) { showError(`停止失败：${(res.stderr || res.stdout || '').trim()}`); return; }
    toast(`已停止 ${inst.name}`);
    await refresh();
  } catch (err) {
    showError(`停止失败：${err.message || err}`);
  }
}

function ensureTerminal() {
  if (state.term) return;
  const term = new Terminal({
    fontFamily: 'Cascadia Code, Consolas, monospace',
    fontSize: 12.5,
    cursorBlink: true,
    theme: { background: '#0b0d10', foreground: '#d7dde7', cursor: '#8b9cff' },
  });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open($('term'));
  state.term = term;
  state.fit = fit;
  term.onData((data) => window.pal.termInput(data));
  window.pal.onTermData((data) => term.write(data));
  window.pal.onTermExit(({ exitCode }) => {
    term.write(`\r\n\x1b[2m[进程已退出，code ${exitCode}]\x1b[0m\r\n`);
  });
  new ResizeObserver(() => {
    if (!state.term) return;
    try { fit.fit(); window.pal.termResize(term.cols, term.rows); } catch { /* ignore */ }
  }).observe($('term'));
}

async function openTerminal(inst) {
  ensureTerminal();
  state.termName = inst.name;
  $('term-title').textContent = inst.name;
  $('term-sub').textContent = `${hostName(inst.harness)} · TUI`;
  $('view-main').classList.add('hidden');
  $('view-term').classList.remove('hidden');
  state.term.clear();
  try {
    state.fit.fit();
    await window.pal.termStart(inst.name, state.term.cols, state.term.rows);
    state.term.focus();
  } catch (err) {
    showError(`打开终端失败：${err.message || err}`);
  }
}

async function installPack() {
  if (!state.harness) return;
  try {
    const res = await window.pal.install(state.harness);
    if (res.canceled) return;
    if (!res.ok) { showError(`安装失败：${(res.stderr || res.stdout || '').trim()}`); return; }
    toast('安装完成');
    await refresh();
  } catch (err) {
    showError(`安装失败：${err.message || err}`);
  }
}

$('refresh').addEventListener('click', refresh);
$('refresh-top').addEventListener('click', refresh);
$('add-pack').addEventListener('click', installPack);
$('empty-add').addEventListener('click', installPack);
$('term-hide').addEventListener('click', () => {
  $('view-term').classList.add('hidden');
  $('view-main').classList.remove('hidden');
});
$('term-kill').addEventListener('click', async () => {
  await window.pal.termKill();
  toast('终端已结束');
  $('view-term').classList.add('hidden');
  $('view-main').classList.remove('hidden');
});
refresh();
