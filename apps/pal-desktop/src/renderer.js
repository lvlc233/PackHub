/* PAL desktop renderer.
   结构：L0 工具栏（PAL / harness / 一级 nav + 添加·刷新·关于）
         L1 三个视图（启动 / 整合包 / 设置）
         L2 启动视图内三 tab（概览 / 启动方式 / 管理）、整合包视图内的 pack 详情
         L3 弹层（安装向导 / 危险确认 / 行菜单 / 关于）
   状态：state.view 决定 L1，state.tab 决定 L2，state.detailId 决定整合包视图的 L2。
   记住：{ harness, view, tab, packs } 写 localStorage，坏数据一律当没存过。 */
/* global Terminal, FitAddon */
const $ = (id) => document.getElementById(id);

const HOSTS = [
  { id: 'dsh', label: 'DSH', full: 'DeepSeek Harness', code: 'DS' },
  { id: 'claude-code', label: 'Claude', full: 'Claude Code', code: 'CC' },
  { id: 'codex', label: 'Codex', full: 'OpenAI Codex', code: 'CX' },
  { id: 'opencode', label: 'opencode', full: 'opencode', code: 'OC' },
  { id: 'workbody', label: 'WorkBuddy', full: 'WorkBuddy', code: 'WB' },
  { id: 'hermes', label: 'Hermes', full: 'Hermes Agent', code: 'HM' },
];

const ICONS = {
  'folder-plus': '<path d="M4 7.5A2.5 2.5 0 0 1 6.5 5h2.8l1.7 2h6.5A2.5 2.5 0 0 1 20 9.5v7A2.5 2.5 0 0 1 17.5 19h-11A2.5 2.5 0 0 1 4 16.5z"/><path d="M12 11.2v5M9.5 13.7h5"/>',
  refresh: '<path d="M20.5 12a8.5 8.5 0 1 1-2.6-6.1"/><path d="M20.5 4.2v4.4h-4.4"/>',
  'chevron-down': '<path d="M6.5 9.5 12 15l5.5-5.5"/>',
  'chevron-right': '<path d="M9.5 6 15 12l-5.5 6"/>',
  'chevron-left': '<path d="M14.5 6 9 12l5.5 6"/>',
  check: '<path d="M5 12.5 9.7 17 19 6.5"/>',
  stop: '<rect x="6.6" y="6.6" width="10.8" height="10.8" rx="2"/>',
  play: '<path d="M8.7 6.1 17.5 12 8.7 17.9z" style="fill:currentColor;stroke:none"/>',
  more: '<path d="M12 5.7v.02M12 12v.02M12 18.3v.02"/>',
  expand: '<path d="M9.5 4.5H5.5a1 1 0 0 0-1 1v4M14.5 19.5h4a1 1 0 0 0 1-1v-4M4.5 14.5v4a1 1 0 0 0 1 1h4M19.5 9.5v-4a1 1 0 0 0-1-1h-4"/>',
  collapse: '<path d="M4.5 9.5h4a1 1 0 0 0 1-1v-4M19.5 14.5h-4a1 1 0 0 0-1 1v4M14.5 4.5v4a1 1 0 0 0 1 1h4M9.5 19.5v-4a1 1 0 0 0-1-1h-4"/>',
  external: '<path d="M13.5 4.5H19a.5.5 0 0 1 .5.5v5.5M19.2 4.8 11.5 12.5"/><path d="M17 14.2v4.3a1.5 1.5 0 0 1-1.5 1.5H5.5A1.5 1.5 0 0 1 4 18.5V8.5A1.5 1.5 0 0 1 5.5 7h4.4"/>',
  terminal: '<rect x="3.4" y="4.8" width="17.2" height="14.4" rx="2.2"/><path d="M7.2 10.2 9.6 12.2 7.2 14.2M12.2 14.6h4.6"/>',
  alert: '<path d="M12 4.8 20.5 19.5h-17z"/><path d="M12 10.4v3.6M12 16.6v.02"/>',
  info: '<circle cx="12" cy="12" r="8.4"/><path d="M12 11v5.2M12 8.1v.02"/>',
  copy: '<rect x="8.4" y="8.4" width="11.2" height="11.2" rx="2"/><path d="M15.6 8.4V6.2a2 2 0 0 0-2-2H6.2a2 2 0 0 0-2 2v7.4a2 2 0 0 0 2 2h2.2"/>',
  folder: '<path d="M4 7.6A2.4 2.4 0 0 1 6.4 5.2h2.6l1.7 2h6.9A2.4 2.4 0 0 1 20 9.6v6.8a2.4 2.4 0 0 1-2.4 2.4H6.4A2.4 2.4 0 0 1 4 16.4z"/>',
  sliders: '<path d="M5 7.5h14M5 12h14M5 16.5h14"/><circle cx="9" cy="7.5" r="1.6" style="fill:var(--raise)"/><circle cx="15" cy="12" r="1.6" style="fill:var(--raise)"/><circle cx="10.5" cy="16.5" r="1.6" style="fill:var(--raise)"/>',
  x: '<path d="M6.5 6.5 17.5 17.5M17.5 6.5 6.5 17.5"/>',
  plus: '<path d="M12 5.5v13M5.5 12h13"/>',
};

function svgIcon(name) {
  return `<svg viewBox="0 0 24 24">${ICONS[name] || ''}</svg>`;
}

/** 唯一的 DOM 构造入口：属性走 setAttribute，文本走 textContent。 */
function h(tag, props, ...kids) {
  const node = document.createElement(tag);
  if (props) {
    for (const [key, value] of Object.entries(props)) {
      if (value === null || value === undefined || value === false) continue;
      if (key === 'class') node.className = value;
      else if (key === 'text') node.textContent = value;
      else if (key === 'html') node.innerHTML = value;
      else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
      else node.setAttribute(key, value === true ? '' : String(value));
    }
  }
  for (const kid of kids.flat()) {
    if (kid === null || kid === undefined || kid === false) continue;
    node.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return node;
}

const NAV = [
  { id: 'launch', label: '启动', hint: '当前整合包、启动动作与会话' },
  { id: 'library', label: '整合包', hint: '这个 harness 的全部整合包' },
  { id: 'settings', label: '设置', hint: '数据目录、快捷键与关于' },
];

const TABS = [
  { id: 'overview', label: '概览' },
  { id: 'modes', label: '启动方式' },
  { id: 'manage', label: '管理' },
];

const BRIEF_KEY = 'pal.ui.v1';

const state = {
  instances: [],
  loading: true,
  error: null,
  harness: 'dsh',
  view: 'launch',
  tab: 'overview',
  packId: null, // 当前整合包（整个应用只认这一个）
  detailId: null, // 整合包视图里的 L2
  packByHarness: {}, // 每个 harness 上次用的整合包
  busy: null, // { id, action }
  menu: null, // { id, rect }
  modal: null,
  install: null,
  info: null,
  term: null,
  fit: null,
  session: null,
  lastDims: '',
  panelOpen: true,
};

/* ---------- 数据 ---------- */
const hostOf = (id) => HOSTS.find((x) => x.id === id) || null;
const hostLabel = (id) => (hostOf(id) ? hostOf(id).label : id);
const hostFull = (id) => (hostOf(id) ? hostOf(id).full : id);
const hostCode = (id) => (hostOf(id) ? hostOf(id).code : String(id).slice(0, 2).toUpperCase());
const byId = (id) => state.instances.find((x) => x.id === id) || null;
const homesOf = (host) => state.instances.filter((x) => x.harness === host);
const installedHosts = () => HOSTS.filter((host) => state.instances.some((x) => x.harness === host.id));
const isRunning = (inst) => inst.status === 'running';
const isBroken = (inst) => inst.status === 'broken' || inst.status === 'failed';
const currentPack = () => byId(state.packId);
const packName = (inst) => (inst.pack && inst.pack.name ? inst.pack.name : inst.name);
const packVer = (inst) => (inst.pack && inst.pack.version ? inst.pack.version : '');
const packText = (inst) => (inst.pack ? `${inst.pack.name}@${inst.pack.version}` : '未挂钩整合包');
const liveCount = () => state.instances.filter(isRunning).length;

function statusOf(inst) {
  if (isRunning(inst)) return { key: 'live', text: '运行中' };
  if (isBroken(inst)) return { key: 'bad', text: '异常' };
  return { key: 'idle', text: '已停止' };
}

function defaultMode(inst) {
  const modes = inst.modes || [];
  if (!modes.length) return null;
  return modes.find((m) => m.default) || modes[0];
}

function foregroundMode(inst) {
  return (inst.modes || []).find((m) => m.kind === 'foreground') || null;
}

function kindWord(kind) {
  if (kind === 'server') return '网页服务';
  if (kind === 'foreground') return '终端';
  if (kind === 'app') return '桌面应用';
  return kind || '模式';
}

function dateText(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function toast(text, bad) {
  const node = h('div', { class: 'toast' + (bad ? ' bad' : '') },
    h('span', { class: 'tdot' }),
    h('span', { text }));
  $('toasts').append(node);
  setTimeout(() => node.remove(), bad ? 5200 : 2600);
}

/* ---------- 记住上次的位置（坏数据当没存过） ---------- */
function loadBrief() {
  let raw = null;
  try { raw = window.localStorage.getItem(BRIEF_KEY); } catch { return; }
  if (!raw) return;
  let data;
  try { data = JSON.parse(raw); } catch { return; }
  if (!data || typeof data !== 'object') return;
  if (typeof data.harness === 'string' && HOSTS.some((x) => x.id === data.harness)) state.harness = data.harness;
  if (typeof data.view === 'string' && NAV.some((x) => x.id === data.view)) state.view = data.view;
  if (typeof data.tab === 'string' && TABS.some((x) => x.id === data.tab)) state.tab = data.tab;
  if (data.packs && typeof data.packs === 'object') {
    for (const [host, id] of Object.entries(data.packs)) {
      if (typeof id === 'string') state.packByHarness[host] = id;
    }
  }
}

function saveBrief() {
  try {
    window.localStorage.setItem(BRIEF_KEY, JSON.stringify({
      harness: state.harness,
      view: state.view,
      tab: state.tab,
      packs: state.packByHarness,
    }));
  } catch { /* 隐私模式之类，记不住就算了 */ }
}

function clearBrief() {
  try { window.localStorage.removeItem(BRIEF_KEY); } catch { /* ignore */ }
  state.packByHarness = {};
  state.view = 'launch';
  state.tab = 'overview';
}

/* ---------- 上下文（L0 + 当前 pack） ---------- */
function resolveContext() {
  const hosts = installedHosts();
  if (!hosts.length) {
    state.packId = null;
    state.detailId = null;
    return;
  }
  if (!hosts.some((x) => x.id === state.harness)) {
    const running = hosts.find((x) => homesOf(x.id).some(isRunning));
    state.harness = (running || hosts[0]).id;
    state.detailId = null;
  }
  const list = homesOf(state.harness);
  const found = list.find((x) => x.id === state.packId)
    || list.find((x) => x.id === state.packByHarness[state.harness])
    || list.find(isRunning)
    || list[0];
  state.packId = found ? found.id : null;
  if (found) state.packByHarness[state.harness] = found.id;
}

function switchHarness(id) {
  if (!id || id === state.harness || !HOSTS.some((x) => x.id === id)) return;
  state.harness = id;
  state.detailId = null;
  const list = homesOf(id);
  const found = list.find((x) => x.id === state.packByHarness[id]) || list.find(isRunning) || list[0];
  state.packId = found ? found.id : null;
  if (found) state.packByHarness[id] = found.id;
  saveBrief();
  render();
}

function setView(id) {
  if (!NAV.some((x) => x.id === id) || state.view === id) return;
  state.view = id;
  if (id !== 'library') state.detailId = null;
  saveBrief();
  render();
  if (id === 'launch') requestAnimationFrame(() => fitTerminal());
}

function setCurrent(id) {
  const inst = byId(id);
  if (!inst) return;
  state.packId = inst.id;
  state.packByHarness[inst.harness] = inst.id;
  saveBrief();
  render();
  toast(`当前整合包：${packName(inst)}`);
}

function openPackDetail(id) {
  const inst = byId(id);
  if (!inst) return;
  state.detailId = id;
  render();
  const back = $('lib-head').querySelector('.crumb-back');
  if (back) back.focus();
}

function backToLibrary() {
  state.detailId = null;
  render();
  const row = document.querySelector(`#lib-scroll .pk-row[data-pack="${CSS.escape(state.packId || '')}"]`)
    || document.querySelector('#lib-scroll .pk-row');
  if (row) row.focus();
}

/* ---------- 主流程 ---------- */
async function refresh() {
  if (!state.instances.length) { state.loading = true; render(); }
  try {
    const data = await window.pal.list();
    state.loading = false;
    if (!data || !data.ok) {
      state.error = (data && data.error) || 'pal list 没有返回结果';
      render();
      return;
    }
    state.error = null;
    state.instances = data.instances || [];
    resolveContext();
    if (state.detailId && !byId(state.detailId)) state.detailId = null;
    render();
  } catch (err) {
    state.loading = false;
    state.error = String((err && err.message) || err);
    render();
  }
}

async function loadInfo() {
  try {
    if (window.pal && typeof window.pal.info === 'function') state.info = await window.pal.info();
  } catch { state.info = null; }
  if (state.view === 'settings') render();
}

function render() {
  document.body.classList.toggle('onboarding', !state.instances.length && !state.loading);
  renderToolbar();
  renderViews();
  renderStatus();
}

/* ---------- L0/L1 外壳 ---------- */
function renderToolbar() {
  const select = $('harness-switch');
  select.textContent = '';
  const hosts = installedHosts();
  if (!hosts.length) {
    select.append(h('option', { value: '', text: '未安装' }));
    select.disabled = true;
  } else {
    select.disabled = false;
    for (const host of hosts) {
      const list = homesOf(host.id);
      const running = list.filter(isRunning).length;
      select.append(h('option', {
        value: host.id,
        selected: host.id === state.harness,
        text: `${host.label} · ${list.length} 个整合包${running ? ` · ${running} 运行中` : ''}`,
      }));
    }
  }

  const nav = $('nav');
  nav.textContent = '';
  const count = state.harness ? homesOf(state.harness).length : 0;
  for (const item of NAV) {
    const on = state.view === item.id;
    nav.append(h('button', {
      class: 'nav-btn' + (on ? ' on' : ''),
      id: `nav-${item.id}`,
      type: 'button',
      role: 'tab',
      title: item.hint,
      'data-nav': item.id,
      'aria-selected': on ? 'true' : 'false',
      onclick: () => setView(item.id),
    }, item.label,
    item.id === 'library' && count ? h('span', { class: 'nav-n', text: String(count) }) : null));
  }
  // 首次使用：一个整合包都没有时，工具条不再和空状态里的引导按钮抢同一件事。
  $('add-pack').classList.toggle('hidden', !state.loading && state.instances.length === 0);
}

function renderViews() {
  $('view-launch').classList.toggle('hidden', state.view !== 'launch');
  $('view-library').classList.toggle('hidden', state.view !== 'library');
  $('view-settings').classList.toggle('hidden', state.view !== 'settings');
  if (state.view === 'launch') {
    renderLaunch();
    renderPanel();
    requestAnimationFrame(() => fitTerminal());
  } else if (state.view === 'library') {
    renderLibrary();
  } else {
    renderSettings();
  }
}

/* ---------- L1 启动视图 ---------- */
function renderLaunch() {
  const head = $('launch-head');
  const tabs = $('launch-tabs');
  const sw = $('launch-switch');
  const body = $('launch-body');
  head.textContent = '';
  tabs.textContent = '';
  sw.textContent = '';
  body.textContent = '';
  body.dataset.tab = state.tab;

  if (state.loading && !state.instances.length) {
    head.classList.add('hidden');
    tabs.classList.add('hidden');
    sw.classList.add('hidden');
    $('launch-foot').classList.add('hidden');
    body.append(h('div', { class: 'sk-block pulse' }));
    return;
  }
  if (state.error) {
    head.classList.add('hidden');
    tabs.classList.add('hidden');
    sw.classList.add('hidden');
    $('launch-foot').classList.add('hidden');
    body.append(errorBox());
    return;
  }
  const inst = currentPack();
  if (!inst) {
    head.classList.add('hidden');
    tabs.classList.add('hidden');
    sw.classList.add('hidden');
    $('launch-foot').classList.add('hidden');
    body.append(launchEmpty());
    return;
  }

  head.classList.remove('hidden');
  tabs.classList.remove('hidden');
  sw.classList.remove('hidden');
  $('launch-foot').classList.remove('hidden');
  renderLaunchHead(head, inst);
  renderTabs(tabs, inst);
  renderSwitcher(sw, inst);
  renderTabBody(body, inst);
  setFoot('launch-foot', launchCmd(inst));
}

/** 这一屏的动作翻译成命令行：脚注永远说当前 tab 真正会跑的那一条。 */
function launchCmd(inst) {
  if (state.tab === 'modes') return `$ pal start ${inst.name} --list-modes`;
  if (state.tab === 'manage') return `$ pal update --home ${inst.name}`;
  return isRunning(inst) || isBroken(inst)
    ? `$ pal stop ${inst.name}`
    : `$ pal start ${inst.name} --mode ${(defaultMode(inst) || {}).id || 'web'}`;
}

function setFoot(id, cmd) {
  const box = $(id);
  if (!box) return;
  box.textContent = '';
  box.append(
    h('span', { class: 'tf-k', text: '命令行等价' }),
    h('code', { class: 'tf-c', text: cmd }));
}

function errorBox() {
  return h('div', { class: 'err' },
    h('h4', { text: '读不到整合包列表' }),
    h('pre', { text: state.error }),
    h('button', { class: 'btn outline', type: 'button', onclick: refresh }, '重试'));
}

function launchEmpty() {
  const hosts = installedHosts();
  if (!hosts.length) {
    return h('div', { class: 'pane-empty hero' },
      h('div', { class: 'pe-mark', html: svgIcon('folder-plus') }),
      h('p', { class: 'pe-title', text: '还没有任何整合包' }),
      h('p', {
        class: 'pe-body',
        text: 'PAL 的每个 harness 都从一个整合包开始：选 harness、选 Pack 目录、看一遍安装计划，装好之后这里就是它的启动面板。',
      }),
      h('div', { class: 'pe-steps' },
        h('span', { class: 'pe-step' }, h('b', { text: '1' }), '选 harness'),
        h('span', { class: 'pe-step' }, h('b', { text: '2' }), '选 Pack 目录'),
        h('span', { class: 'pe-step' }, h('b', { text: '3' }), '预览并安装')),
      h('div', { class: 'pe-actions' },
        h('button', { class: 'btn ink', type: 'button', onclick: () => openInstall('dsh') },
          h('span', { class: 'ico', html: svgIcon('folder-plus') }), '安装第一个整合包')),
      h('pre', { class: 'pe-cli', text: '$ pal install <pack 目录> --host dsh' }));
  }
  return h('div', { class: 'pane-empty' },
    h('p', { class: 'pe-title', text: `${hostFull(state.harness)} 还没有整合包` }),
    h('p', {
      class: 'pe-body',
      text: '给这个 harness 装一个包：选一个 Pack 目录，PAL 会为它建一个 home。装好之后，这里就是它的启动面板。',
    }),
    h('div', { class: 'pe-actions' },
      h('button', { class: 'btn ink', type: 'button', onclick: () => openInstall(state.harness) },
        h('span', { class: 'ico', html: svgIcon('folder-plus') }), '添加整合包')),
    h('pre', { class: 'pe-cli', text: `$ pal install <pack 目录> --host ${state.harness}` }));
}

function renderLaunchHead(head, inst) {
  const status = statusOf(inst);
  const version = packVer(inst);

  head.append(h('div', { class: 'ph-main' },
    h('div', { class: 'eyebrow' },
      h('span', { class: `tile ph-tile hm-${inst.harness}`, text: hostCode(inst.harness) }),
      h('span', { class: 'ph-host', text: hostFull(inst.harness) }),
      h('span', { class: 'sep' }),
      h('span', { text: '当前整合包' })),
    h('h1', { class: 'inst-name', text: packName(inst), title: packText(inst) }),
    h('div', { class: 'subline' },
      h('span', { class: 'mono', text: version ? `@${version}` : '无版本' }),
      h('span', { class: 'sep' }),
      h('span', { class: 'mono dim', text: inst.name }),
      h('span', { class: 'sep' }),
      h('span', { class: `pill ${status.key === 'idle' ? '' : status.key}` },
        status.key === 'idle' ? null : h('span', { class: `dot ${status.key}` }),
        status.text))));

  const act = h('div', { class: 'ph-act' });
  act.append(primaryButton(inst));
  act.append(h('button', {
    class: 'linkbtn line act-link', type: 'button',
    title: `装进 ${hostFull(inst.harness)}`,
    onclick: () => openInstall(inst.harness),
  }, '+ 安装整合包'));
  const note = headNote(inst, isRunning(inst));
  if (note) act.append(h('div', { class: 'ph-note' + (isBroken(inst) ? ' bad' : ''), text: note }));
  head.append(act);
}

/** 换版本：只在有几个包时给下拉；单包时右侧只留一条去「整合包」视图的入口。 */
function renderSwitcher(box, inst) {
  const homes = homesOf(inst.harness);
  if (homes.length > 1) {
    box.append(
      h('span', { class: 'tab-switch-label', text: '切换' }),
      h('select', {
        class: 'tab-switch',
        'aria-label': '切换当前整合包',
        onchange: (event) => setCurrent(event.target.value),
      }, homes.map((home) => h('option', {
        value: home.id,
        selected: home.id === inst.id,
        text: `${packName(home)}@${packVer(home)}`,
      }))));
  }
  box.append(h('button', {
    class: 'linkbtn line', type: 'button',
    onclick: () => setView('library'),
  }, '全部 ›'));
}

/** 头部只说「这个动作为什么现在点不了」；进程已不在之类的状态由概览卡和终端条说，不在这里重复。 */
function headNote(inst, running) {
  const mode = defaultMode(inst);
  if (mode && mode.available === false && !running) return mode.reason || '这个模式不可用';
  return '';
}

function primaryButton(inst) {
  const running = isRunning(inst);
  const broken = isBroken(inst);
  const mode = defaultMode(inst);
  const busy = state.busy && state.busy.id === inst.id;

  if (busy) {
    return h('button', { class: 'launch off', type: 'button', disabled: true },
      state.busy.action === 'stop' ? '正在停止…' : '正在启动…');
  }
  if (running || broken) {
    return h('button', {
      class: 'launch stop', type: 'button',
      title: broken ? '记录还停在 running，但 pid 已经不在：停止会清掉这条记录' : '停止这个整合包',
      onclick: () => stopInstance(inst),
    }, h('span', { class: 'ico', html: svgIcon('stop') }), '停止');
  }
  if (!mode || mode.available === false) {
    return h('button', {
      class: 'launch off', type: 'button', disabled: true,
      title: (mode && mode.reason) || '这个整合包没有可用的启动模式',
    }, '不可启动');
  }
  return h('button', {
    class: 'launch', type: 'button', title: `${mode.label}（${mode.id}）`,
    onclick: () => launchInstance(inst),
  }, '启动');
}

/** 整合包视图里的轻量主按钮：同一件事，换个场景不抢封面。 */
function smallLaunch(inst) {
  const running = isRunning(inst);
  const broken = isBroken(inst);
  const busy = state.busy && state.busy.id === inst.id;
  if (busy) {
    return h('button', { class: 'btn outline', type: 'button', disabled: true },
      state.busy.action === 'stop' ? '正在停止…' : '正在启动…');
  }
  if (running || broken) {
    return h('button', { class: 'btn outline', type: 'button', onclick: () => stopInstance(inst) },
      h('span', { class: 'ico', html: svgIcon('stop') }), '停止');
  }
  const mode = defaultMode(inst);
  if (!mode || mode.available === false) {
    return h('button', {
      class: 'btn outline', type: 'button', disabled: true,
      title: (mode && mode.reason) || '没有可用的启动模式',
    }, '不可启动');
  }
  return h('button', { class: 'btn ink', type: 'button', onclick: () => launchInstance(inst) },
    h('span', { class: 'ico', html: svgIcon('play') }), '启动');
}

function renderTabs(box, inst) {
  for (const tab of TABS) {
    const on = state.tab === tab.id;
    box.append(h('button', {
      class: 'tab' + (on ? ' on' : ''),
      id: `tab-${tab.id}`,
      type: 'button',
      role: 'tab',
      'data-tab': tab.id,
      'aria-selected': on ? 'true' : 'false',
      tabindex: on ? '0' : '-1',
      onclick: () => selectTab(tab.id),
    }, tab.label,
    tab.id === 'modes' ? h('span', { class: 't-n', text: String((inst.modes || []).length) }) : null));
  }
}

function selectTab(id) {
  if (state.tab === id) return;
  state.tab = id;
  saveBrief();
  renderLaunch();
  renderPanel();
}

function renderTabBody(body, inst) {
  if (state.tab === 'modes') body.append(modesBody(inst));
  else if (state.tab === 'manage') body.append(manageBody(inst));
  else body.append(overviewBody(inst));
}


/* ---------- L2 概览 ---------- */
function overviewBody(inst) {
  const status = statusOf(inst);
  const running = isRunning(inst);
  const broken = isBroken(inst);
  const primary = running
    ? (inst.url ? inst.url.replace(/^https?:\/\//, '').replace(/\/$/, '') : inst.port ? `port ${inst.port}` : '进程在跑')
    : broken ? '进程已不在' : '没有进程在跑';
  const aux = (running || broken) && inst.pid
    ? (broken ? `上次 pid ${inst.pid}` : `pid ${inst.pid}`)
    : '';

  // 状态词只在头部 pill 说一次：这张卡只交代「现在有什么」。
  const card = h('div', { class: `ov-status ${status.key}` },
    h('div', { class: 'ovs-main' },
      h('p', { class: 'ovs-line' },
        status.key === 'idle' ? h('span', { class: 'ring' }) : h('span', { class: `dot ${status.key}` }),
        h('span', { class: 'ovs-val', text: primary }),
        aux ? h('span', { class: 'ovs-aux', text: aux }) : null)),
    inst.url
      ? h('button', { class: 'btn outline', type: 'button', onclick: () => openExternal(inst.url) },
        h('span', { class: 'ico', html: svgIcon('external') }), '打开页面')
      : null);

  const mode = defaultMode(inst);
  const last = inst.launchMode && (!mode || inst.launchMode !== mode.id) ? inst.launchMode : null;
  const next = h('div', { class: 'ov-next' },
    h('span', { class: 'ovn-ico', html: svgIcon('terminal') }),
    h('div', { class: 'ovn-main' },
      h('span', { class: 'ovn-t' }, '默认启动方式 ',
        h('b', { text: mode ? `${mode.label || mode.id} · ${kindWord(mode.kind)}` : '未声明' }),
        last ? h('i', { class: 'ovn-last', text: `上次用的是 ${last}` }) : null),
      h('span', { class: 'ovn-s', text: launchHint(inst, mode, running, broken) })),
    h('button', {
      class: 'linkbtn', type: 'button',
      onclick: () => selectTab('modes'),
    }, `看 ${(inst.modes || []).length} 种方式`, h('span', { class: 'ico', html: svgIcon('chevron-right') })));

  return h('div', { class: 'ov' },
    card,
    h('dl', { class: 'facts' }, factRows(inst).map(([key, value, dim]) => h('div', { class: 'fact' },
      h('dt', { text: key }),
      h('dd', { class: dim ? 'dim' : '', text: value, title: value })))),
    next);
}

function launchHint(inst, mode, running, broken) {
  if (broken) return '先停止清记录';
  if (running) return inst.url ? '服务在跑，用「打开页面」进界面' : '进程在跑，先停止再换模式';
  if (!mode) return '这个 harness 没有声明启动模式';
  if (mode.available === false) return '这个模式在当前 home 上不可用';
  if (mode.kind === 'foreground') return '启动会在下面终端里开一个前台会话';
  if (mode.kind === 'server') return '启动后起本地服务，并自动用浏览器打开';
  if (mode.kind === 'app') return '启动会拉起 harness 自己的桌面窗口';
  return '';
}

function factRows(inst) {
  const rows = [['路径', inst.root || '—', !inst.root]];
  if (inst.home && inst.home !== inst.root) rows.push(['Home', inst.home, false]);
  if (inst.profile) rows.push(['Profile', inst.profile, false]);
  // 形态决定「删除」会删掉什么，值得在概览里就让人看见。
  rows.push(['形态', inst.attached
    ? 'attached home · 装在 harness 自己的目录'
    : inst.managed === false
      ? '接管目录 · 不归 PAL 整根管'
      : '托管 home · PAL 数据目录下', false]);
  if (inst.harnessVersion) rows.push(['宿主版本', String(inst.harnessVersion), false]);
  if (inst.createdAt) rows.push(['建于', dateText(inst.createdAt), false]);
  // 实例 ID 不在这里重复：它在「管理」里，旁边就有复制。
  return rows;
}

/* ---------- L2 启动方式 ---------- */
function modesBody(inst) {
  const modes = inst.modes || [];
  const running = isRunning(inst);
  const broken = isBroken(inst);
  const busy = state.busy && state.busy.id === inst.id;
  const lead = running || broken
    ? '进程在跑：先停止，才能换启动方式。'
    : '点上任意一种方式启动；默认方式也是右上角「启动」用的那个。';

  const list = modes.length
    ? h('div', { class: 'modes' }, modes.map((mode) => {
      const off = running || broken || busy || mode.available === false;
      const used = Boolean(inst.launchMode) && inst.launchMode === mode.id;
      // 右侧说的必须是「这个模式」的状态，不是实例状态。
      const side = busy ? '处理中'
        : used && running ? '运行中'
          : mode.available === false ? '不可用'
            : running || broken ? '先停止'
              : '启动';
      return h('div', { class: 'mode-item' },
        h('button', {
          class: 'mode-btn', type: 'button', disabled: off,
          title: mode.available === false ? (mode.reason || '不可用') : running || broken ? '先停止再启动' : `以 ${mode.id} 启动`,
          onclick: () => launchMode(inst, mode),
        },
        h('span', { class: 'mi-main' },
          h('span', { class: 'mi-label' },
            mode.label || mode.id,
            mode.default ? h('span', { class: 'tag', text: '默认' }) : null,
            used ? h('span', { class: 'tag used', text: running ? '正在用' : '上次用' }) : null),
          h('span', { class: 'mi-id', text: mode.available === false && mode.reason && !used
            ? mode.reason
            : `--mode ${mode.id} · ${kindWord(mode.kind)}` })),
        h('span', { class: 'mi-side' },
          side,
          off ? null : h('span', { class: 'ico', html: svgIcon('chevron-right') }))));
    }))
    : h('div', { class: 'modes' },
      h('div', { class: 'mode-item' }, h('div', { class: 'mode-note', text: '这个 harness 没有声明启动模式' })));

  return h('div', { class: 'mb' },
    h('p', { class: 'sec-lead', text: lead }),
    list);
}

/* ---------- L2 管理 ---------- */
function actionRow(title, desc, buttons, opts = {}) {
  return h('div', { class: 'mg-row' + (opts.danger ? ' danger' : '') },
    h('div', { class: 'mgr-main' },
      h('span', { class: 'mgr-t', text: title }),
      h('span', { class: 'mgr-s', text: desc })),
    h('div', { class: 'mgr-act' }, buttons));
}

function rowBtn(label, opts = {}) {
  return h('button', {
    class: 'btn outline' + (opts.danger ? ' danger' : ''),
    type: 'button',
    disabled: opts.disabled || false,
    title: opts.title || null,
    onclick: opts.onclick,
  }, label);
}

function manageBody(inst) {
  const running = isRunning(inst);
  const broken = isBroken(inst);
  const blocked = running || broken;
  const busy = state.busy && state.busy.id === inst.id;
  const attached = inst.attached === true;

  return h('div', { class: 'mg' },
    h('section', { class: 'mg-group' },
      h('h3', { class: 'mg-h', text: '整合包' }),
      actionRow(`版本 ${packText(inst)}`,
        blocked
          ? '先停止实例，才能换版本或卸包'
          : '更新换成 registry 的最新版（本地改过的文件会拦住）；卸载摘掉包写进这个 home 的文件，记录与目录保留',
        h('div', { class: 'mgr-act' },
          rowBtn('更新', { disabled: blocked || busy, onclick: () => confirmAction('update', inst) }),
          rowBtn('卸载', { disabled: blocked || busy, onclick: () => confirmAction('uninstall', inst) })))),

    h('section', { class: 'mg-group' },
      h('h3', { class: 'mg-h', text: '位置' }),
      actionRow('打开所在文件夹', inst.root || '这个实例没有记录路径',
        h('div', { class: 'mgr-act' },
          rowBtn('打开', { disabled: !inst.root, onclick: () => reveal(inst) }),
          rowBtn('复制路径', { disabled: !inst.root, onclick: () => copyText(inst.root, '路径已复制') }))),
      actionRow('实例 ID', inst.id,
        rowBtn('复制', { onclick: () => copyText(inst.id, '实例 ID 已复制') }))),

    h('section', { class: 'mg-group danger' },
      h('h3', { class: 'mg-h', text: '危险操作' }),
      actionRow(`删除这个实例${attached ? '（只摘记录）' : ''}`,
        attached
          ? 'attached home：只删 PAL 的记录，目录与用户文件留在原处'
          : '删除前会先停进程，整个 home 目录（含会话与凭据）一起删掉，不可恢复',
        rowBtn('删除…', { danger: true, disabled: busy, onclick: () => confirmAction('remove', inst) }))));
}

/* ---------- L1 整合包视图 ---------- */
function renderLibrary() {
  const head = $('lib-head');
  const scroll = $('lib-scroll');
  head.textContent = '';
  scroll.textContent = '';

  const detail = state.detailId ? byId(state.detailId) : null;
  if (detail && detail.harness === state.harness) {
    renderPackDetail(head, scroll, detail);
    return;
  }
  state.detailId = null;

  const host = hostOf(state.harness);
  const list = state.harness ? homesOf(state.harness) : [];
  const running = list.filter(isRunning).length;

  head.append(
    h('div', { class: 'vh-main' },
      h('h1', { class: 'vh-title', text: '整合包' }),
      h('p', {
        class: 'vh-sub',
        text: host
          ? `${host.full} · ${running ? `${running} 个运行中` : '没有在跑'}`
          : '还没有安装任何 harness',
      })));

  if (state.loading && !state.instances.length) {
    $('lib-foot').classList.add('hidden');
    scroll.append(h('div', { class: 'sk-block pulse' }));
    return;
  }
  if (state.error) {
    $('lib-foot').classList.add('hidden');
    scroll.append(errorBox());
    return;
  }
  $('lib-foot').classList.remove('hidden');
  setFoot('lib-foot', '$ pal list --json');
  if (!list.length) {
    scroll.append(libraryEmpty(host));
    return;
  }

  scroll.append(h('div', { class: 'pk-list', role: 'list' },
    list.map((inst) => packRow(inst)),
    h('button', {
      class: 'pk-add', type: 'button',
      title: `装进 ${host ? host.full : 'harness'}`,
      onclick: () => openInstall(state.harness),
    },
    h('span', { class: 'ico', html: svgIcon('plus') }),
    h('span', { text: `安装到 ${host ? host.label : 'harness'}` }))));
  scroll.append(h('p', {
    class: 'hint',
    text: '点一行进详情；「当前」是启动视图在用的那一个，其余用「设为当前」换过去。',
  }));
}

function libraryEmpty(host) {
  const name = host ? host.full : '这个 harness';
  return h('div', { class: 'pane-empty tight' },
    h('p', { class: 'pe-title', text: `${name} 还没有整合包` }),
    h('p', {
      class: 'pe-body',
      text: '整合包按 harness 归位：装进来的每个包都会出现在这张表里，并占一个 home。',
    }),
    h('div', { class: 'pe-actions' },
      h('button', { class: 'btn ink', type: 'button', onclick: () => openInstall(state.harness) },
        h('span', { class: 'ico', html: svgIcon('folder-plus') }), '安装第一个整合包')),
    h('pre', { class: 'pe-cli', text: `$ pal install <pack 目录> --host ${state.harness}` }));
}

function packRow(inst) {
  const current = inst.id === state.packId;
  const st = statusOf(inst);
  const version = packVer(inst);
  const more = h('button', {
    class: 'ract ract-more', type: 'button', tabindex: '-1',
    title: '更多动作', 'aria-label': '更多动作', 'aria-haspopup': 'menu',
    onclick: (event) => {
      event.stopPropagation();
      openPackMenu(inst.id, event.currentTarget);
    },
  }, h('span', { class: 'ico dots', html: svgIcon('more') }));

  const row = h('div', {
    class: 'pk-row' + (current ? ' cur' : ''),
    role: 'listitem',
    tabindex: '0',
    'data-pack': inst.id,
    title: `${packText(inst)} · ${inst.name} · ${st.text}`,
    onclick: () => openPackDetail(inst.id),
    onkeydown: (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        event.stopPropagation();
        openPackDetail(inst.id);
      }
    },
  },
  h('span', { class: 'pk-main' },
    h('span', { class: 'pk-name', text: packName(inst) }),
    h('span', { class: 'pk-meta' },
      h('span', { text: version ? `@${version}` : '无版本' }),
      h('span', { class: 'sep' }),
      h('span', { class: 'mono', text: inst.name }))),
  h('span', { class: 'pk-path mono', text: inst.root || '—', title: inst.root || '' }),
  h('span', { class: 'pk-state' + (current ? ' cur' : '') },
    h('span', { class: `r-dot ${st.key}` }),
    h('span', { text: st.text })),
  h('span', { class: 'pk-acts' },
    current
      ? h('span', { class: 'tag cur', text: '当前' })
      : h('button', {
        class: 'linkbtn line', type: 'button', tabindex: '-1',
        title: '让启动视图改用这个整合包',
        onclick: (event) => { event.stopPropagation(); setCurrent(inst.id); },
      }, '设为当前'),
    more));

  return row;
}

function renderPackDetail(head, scroll, inst) {
  const status = statusOf(inst);
  const running = isRunning(inst);
  const broken = isBroken(inst);
  const blocked = running || broken;
  const busy = state.busy && state.busy.id === inst.id;
  const attached = inst.attached === true;
  const mode = defaultMode(inst);

  head.append(
    h('div', { class: 'vh-main' },
      h('div', { class: 'crumb' },
        h('button', { class: 'crumb-back', type: 'button', onclick: backToLibrary },
          h('span', { class: 'ico', html: svgIcon('chevron-left') }), '整合包')),
      h('h1', { class: 'vh-title', text: packName(inst) }),
      h('p', { class: 'vh-sub' },
        h('span', { class: 'mono', text: packVer(inst) ? `@${packVer(inst)}` : '无版本' }),
        h('span', { class: 'sep' }),
        h('span', { class: 'mono', text: inst.name }),
        h('span', { class: 'sep' }),
        h('span', { class: `pill ${status.key === 'idle' ? '' : status.key}` },
          status.key === 'idle' ? null : h('span', { class: `dot ${status.key}` }),
          status.text),
        h('button', { class: 'linkbtn line sub-link', type: 'button', onclick: () => goLaunch(inst) },
          '在启动视图中打开 ›'))),
    h('div', { class: 'vh-act' },
      inst.id === state.packId
        ? h('span', { class: 'tag cur', text: '当前整合包' })
        : h('button', { class: 'btn outline', type: 'button', onclick: () => setCurrent(inst.id) }, '设为当前'),
      smallLaunch(inst)));

  const statusCard = h('div', { class: `ov-status ${status.key}` },
    h('div', { class: 'ovs-main' },
      h('p', { class: 'ovs-line' },
        status.key === 'idle' ? h('span', { class: 'ring' }) : h('span', { class: `dot ${status.key}` }),
        h('span', {
          class: 'ovs-val',
          text: running
            ? (inst.url ? inst.url.replace(/^https?:\/\//, '').replace(/\/$/, '') : '进程在跑')
            : broken ? '进程已不在' : '没有进程在跑',
        }),
        (running || broken) && inst.pid ? h('span', { class: 'ovs-aux', text: `${broken ? '上次 ' : ''}pid ${inst.pid}` }) : null)),
    inst.url
      ? h('button', { class: 'btn outline', type: 'button', onclick: () => openExternal(inst.url) },
        h('span', { class: 'ico', html: svgIcon('external') }), '打开页面')
      : null);

  // 路径与实例 ID 的动作挂在这一行上：它们在详情里就是「这个东西 + 对它做的事」。
  const factRow = (key, value, acts, dim) => h('div', { class: 'fact' + (acts ? ' has-act' : '') },
    h('dt', { text: key }),
    h('dd', { class: dim ? 'dim' : '', text: value, title: value }),
    acts ? h('div', { class: 'fact-act' }, acts) : null);

  const facts = [
    factRow('路径', inst.root || '—', [
      rowBtn('打开', { disabled: !inst.root, onclick: () => reveal(inst) }),
      rowBtn('复制', { disabled: !inst.root, onclick: () => copyText(inst.root, '路径已复制') }),
    ], !inst.root),
    factRow('实例 ID', inst.id, rowBtn('复制', { onclick: () => copyText(inst.id, '实例 ID 已复制') })),
  ];
  if (inst.home && inst.home !== inst.root) facts.push(factRow('Home', inst.home));
  if (inst.profile) facts.push(factRow('Profile', inst.profile));
  facts.push(factRow('形态', inst.attached
    ? 'attached home · 装在 harness 自己的目录'
    : inst.managed === false ? '接管目录 · 不归 PAL 整根管' : '托管 home · PAL 数据目录下'));
  if (inst.harnessVersion) facts.push(factRow('宿主版本', String(inst.harnessVersion)));
  if (inst.createdAt) facts.push(factRow('建于', dateText(inst.createdAt)));
  facts.push(factRow('启动方式', mode
    ? `${mode.label || mode.id} · ${kindWord(mode.kind)}${mode.available === false ? ' · 不可用' : ''}`
    : '这个 harness 没有声明启动模式', null, !mode));

  scroll.append(h('div', { class: 'detail' },
    statusCard,
    h('dl', { class: 'facts' }, facts),

    h('section', { class: 'mg-group' },
      h('h3', { class: 'mg-h', text: '整合包' }),
      actionRow(`版本 ${packText(inst)}`,
        blocked
          ? '先停止实例，才能换版本或卸包'
          : '更新换成 registry 的最新版（本地改过的文件会拦住）；卸载摘掉包写进这个 home 的文件',
        h('div', { class: 'mgr-act' },
          rowBtn('更新', { disabled: blocked || busy, onclick: () => confirmAction('update', inst) }),
          rowBtn('卸载', { disabled: blocked || busy, onclick: () => confirmAction('uninstall', inst) })))),

    h('section', { class: 'mg-group danger' },
      h('h3', { class: 'mg-h', text: '危险操作' }),
      actionRow(`删除这个实例${attached ? '（只摘记录）' : ''}`,
        attached
          ? 'attached home：只删 PAL 的记录，目录与用户文件留在原处'
          : '删除前会先停进程，整个 home 目录（含会话与凭据）一起删掉，不可恢复',
        rowBtn('删除…', { danger: true, disabled: busy, onclick: () => confirmAction('remove', inst) })))));
  setFoot('lib-foot', `$ pal update --home ${inst.name}`);
}

/** 详情 → 启动视图（同一份 pack，换的是视图不是选择）。 */
function goLaunch(inst) {
  state.view = 'launch';
  state.packId = inst.id;
  state.packByHarness[inst.harness] = inst.id;
  saveBrief();
  render();
}

/* ---------- L1 设置视图 ---------- */
function renderSettings() {
  const head = $('set-head');
  const scroll = $('set-scroll');
  head.textContent = '';
  scroll.textContent = '';

  const version = state.info && state.info.version ? String(state.info.version) : '';
  const dataDir = state.info && state.info.dataDir ? String(state.info.dataDir) : '';
  const palBin = state.info && state.info.palBin ? String(state.info.palBin) : '';

  head.append(
    h('div', { class: 'vh-main' },
      h('h1', { class: 'vh-title', text: '设置' }),
      h('p', { class: 'vh-sub', text: `本机 · PAL 桌面版${version ? ` ${version}` : ''}` })));

  const dirRow = h('div', { class: 'mg-row' },
    h('div', { class: 'mgr-main' },
      h('span', { class: 'mgr-t', text: 'PAL 数据目录' }),
      h('span', {
        class: 'mgr-s',
        text: dataDir ? '实例记录、runtime 与会话日志都在这里；PAL 不会删这个目录之外的文件。'
          : '主进程没有提供数据目录（直接开页面时会是空的）。',
      }),
      h('code', { class: 'pathline mono' + (dataDir ? '' : ' empty'), text: dataDir || '—', title: dataDir || '' })),
    h('div', { class: 'mgr-act' },
      h('button', {
        class: 'btn outline', type: 'button', disabled: !dataDir,
        onclick: () => revealPath(dataDir),
      }, '打开'),
      h('button', {
        class: 'btn outline', type: 'button', disabled: !dataDir,
        onclick: () => copyText(dataDir, '数据目录已复制'),
      }, '复制')));

  const memory = readBriefLabel();

  scroll.append(h('div', { class: 'set' },
    h('section', { class: 'mg-group' },
      h('h3', { class: 'mg-h', text: '数据与位置' }),
      dirRow,
      h('div', { class: 'mg-row' },
        h('div', { class: 'mgr-main' },
          h('span', { class: 'mgr-t', text: 'pal 命令' }),
          h('span', { class: 'mgr-s', text: '列表、启动、安装都调这一个 CLI；这里显示主进程实际 spawn 的路径。' }),
          h('code', { class: 'pathline mono' + (palBin ? '' : ' empty'), text: palBin || '—', title: palBin || '' })),
        h('div', { class: 'mgr-act' },
          h('button', {
            class: 'btn outline', type: 'button', disabled: !palBin,
            onclick: () => copyText(palBin, 'pal 路径已复制'),
          }, '复制')))),

    h('section', { class: 'mg-group' },
      h('h3', { class: 'mg-h', text: '启动位置' }),
      h('div', { class: 'mg-row' },
        h('div', { class: 'mgr-main' },
          h('span', { class: 'mgr-t', text: '记住上次的 harness 与视图' }),
          h('span', { class: 'mgr-s', text: memory })),
        h('div', { class: 'mgr-act' },
          h('button', {
            class: 'btn outline', type: 'button',
            title: '清掉记在本地的位置，下次打开回到默认',
            onclick: () => {
              clearBrief();
              render();
              toast('已清掉本地记忆');
            },
          }, '清除记忆')))),

    h('section', { class: 'mg-group' },
      h('h3', { class: 'mg-h', text: '快捷键' }),
      h('div', { class: 'kb-table cols' }, KEYMAP.map(([key, label]) => h('div', { class: 'kb-row' },
        h('kbd', { text: key }),
        h('span', { text: label }))))),

    h('section', { class: 'mg-group' },
      h('h3', { class: 'mg-h', text: '关于' }),
      h('div', { class: 'mg-row' },
        h('div', { class: 'mgr-main' },
          h('span', { class: 'mgr-t', text: `PAL 桌面版${version ? ` · ${version}` : ''}` }),
          h('span', { class: 'mgr-s', text: 'PAL 是本地实例启动器：每个整合包装进一个 home，动作用 pal CLI 完成，界面只负责选择和确认。' })),
        h('div', { class: 'mgr-act' },
          h('button', { class: 'btn outline', type: 'button', onclick: () => openModal({ kind: 'about' }) }, '关于与快捷键'))))));
  setFoot('set-foot', '$ pal --help');
}

const KEYMAP = [
  ['↑ ↓', '在整合包列表里移动焦点'],
  ['Enter', '打开焦点所在的整合包详情 / 启动当前整合包'],
  ['← →', '在一级导航之间切换（焦点在导航上时）'],
  ['F5', '重新读取整合包列表'],
  ['Esc', '关闭弹层 / 菜单；在详情里返回列表'],
  ['Ctrl 1 2 3', '切到 启动 / 整合包 / 设置'],
];

function readBriefLabel() {
  const host = hostOf(state.harness);
  const view = (NAV.find((x) => x.id === state.view) || {}).label || state.view;
  const tab = (TABS.find((x) => x.id === state.tab) || {}).label || state.tab;
  if (!host) return '还没有可记的内容。';
  return `下次打开回到 ${host.label} · ${view}${state.view === 'launch' ? ` · ${tab}` : ''}；坏数据会自动忽略。`;
}

/* ---------- 状态栏 ---------- */
function renderStatus() {
  const host = hostOf(state.harness);
  const hasHosts = installedHosts().length > 0;
  const live = liveCount();

  const harnessBox = $('sb-harness');
  harnessBox.textContent = '';
  harnessBox.append(h('span', { class: 'sb-k', text: 'harness' }), h('b', { text: host && hasHosts ? host.label : '未安装' }));

  const liveBox = $('sb-live');
  liveBox.textContent = '';
  if (live) liveBox.append('全局 ', h('b', { text: String(live) }), ' 个运行中');
  else liveBox.append('没有在跑的实例');

  const keys = $('sb-keys');
  keys.textContent = '';
  const pairs = state.view === 'library'
    ? (state.detailId ? [['Esc', '返回列表']] : [['↑↓', '选择'], ['Enter', '详情']])
    : state.view === 'launch' ? [['Enter', '启动']] : [];
  for (const [key, label] of pairs.concat([['F5', '刷新'], ['Esc', '关闭']])) {
    keys.append(h('span', { class: 'sb-item kb' }, h('kbd', { text: key }), ` ${label}`));
  }
}

/* ---------- 动作 ---------- */
async function launchInstance(inst) {
  const mode = defaultMode(inst);
  if (!mode) { toast('这个整合包没有启动模式', true); return; }
  await launchMode(inst, mode);
}

async function launchMode(inst, mode) {
  if (isRunning(inst)) { toast('进程在跑：先停止再启动', true); return; }
  if (mode.available === false) { toast(mode.reason || '这个模式不可用', true); return; }
  if (state.view !== 'launch') {
    state.view = 'launch';
    state.packId = inst.id;
    state.packByHarness[inst.harness] = inst.id;
    saveBrief();
    render();
  }
  if (mode.kind === 'foreground') { await openTerminal(inst); return; }
  setBusy(inst.id, 'start');
  try {
    const res = await window.pal.start(inst.name, mode.id);
    if (!res || !res.ok) {
      const detail = String((res && (res.stderr || res.stdout)) || '').trim();
      toast(`启动失败：${detail || 'pal start 返回非 0'}`, true);
      return;
    }
    toast(`已启动 ${inst.name}`);
    await refresh();
    if (res.record && res.record.url) window.pal.openExternal(res.record.url);
  } catch (err) {
    toast(`启动失败：${(err && err.message) || err}`, true);
  } finally {
    setBusy(null);
  }
}

async function stopInstance(inst) {
  setBusy(inst.id, 'stop');
  try {
    const res = await window.pal.stop(inst.name);
    if (!res || !res.ok) {
      const detail = String((res && (res.stderr || res.stdout)) || '').trim();
      toast(`停止失败：${detail || 'pal stop 返回非 0'}`, true);
      return;
    }
    toast(`已停止 ${inst.name}`);
    await refresh();
  } catch (err) {
    toast(`停止失败：${(err && err.message) || err}`, true);
  } finally {
    setBusy(null);
  }
}

function setBusy(id, action) {
  state.busy = id ? { id, action } : null;
  render();
}

function openExternal(url) {
  if (!url) return;
  try { window.pal.openExternal(url); } catch (err) { toast(`打不开链接：${(err && err.message) || err}`, true); }
}

async function reveal(inst) {
  if (!inst.root) return;
  await revealPath(inst.root);
}

async function revealPath(path) {
  if (!path) return;
  try {
    const res = await window.pal.reveal(path);
    if (res && res.ok === false) toast(res.error || '打不开文件夹', true);
  } catch (err) {
    toast(`打不开文件夹：${(err && err.message) || err}`, true);
  }
}

async function copyText(text, okText) {
  if (!text) return;
  try {
    const res = await window.pal.copy(text);
    if (res && res.ok === false) { toast(res.error || '复制失败', true); return; }
    toast(okText || '已复制');
  } catch (err) {
    toast(`复制失败：${(err && err.message) || err}`, true);
  }
}

/* ---------- 终端面板（属于启动视图） ---------- */
function panelModeOf(inst) {
  if (state.session) return 'term';
  if (!inst) return 'hidden';
  return foregroundMode(inst) ? 'term' : 'note';
}

/** 折叠条是这一屏唯一的一级状态文案，必须和实例状态一致。 */
function panelBarText(inst, session) {
  if (session) {
    return session.live ? `pal run ${session.name}` : `${session.name} · 已退出 code ${session.exitCode}`;
  }
  if (!inst) return '未连接';
  if (isBroken(inst)) return '记录异常';
  if (isRunning(inst)) return '进程在跑 · 无前台会话';
  return `$ pal run ${inst.name}`;
}

function renderPanel() {
  const panel = $('panel');
  const bar = $('panel-bar');
  const inst = currentPack();
  const mode = panelModeOf(inst);
  const open = Boolean(state.session) || state.panelOpen;
  bar.textContent = '';

  panel.className = 'panel'
    + (mode === 'hidden' ? ' hidden' : '')
    + (mode === 'note' ? ' note-mode' : '')
    + (mode === 'term' && !open ? ' collapsed' : '');
  // 没有会话时不开一块空黑：压成一行提示 + 一条起会话的命令，够用又不压正文。
  panel.classList.toggle('short', mode === 'term' && open && !state.session);

  if (mode === 'hidden') return;

  if (mode === 'note') {
    bar.append(
      h('span', { class: 'panel-title', text: '终端' }),
      h('span', { class: 'panel-note', text: `${hostLabel(inst.harness)} 没有前台模式，${kindWord((defaultMode(inst) || {}).kind)}的输出不进 PAL` }));
    return;
  }

  const session = state.session;
  bar.append(
    h('span', { class: 'panel-title', text: '终端' }),
    h('span', { class: 'panel-state' + (session && session.live ? ' live' : '') },
      h('span', { class: 'dot' }),
      panelBarText(inst, session)),
    h('div', { class: 'panel-grow' }),
    h('div', { class: 'panel-actions' },
      h('button', {
        class: 'pbtn', id: 'panel-kill', type: 'button',
        disabled: !(session && session.live),
        onclick: killSession,
      }, h('span', { class: 'ico', html: svgIcon('stop') }), '结束'),
      h('button', {
        class: 'pbtn', id: 'panel-toggle', type: 'button',
        title: open ? '收起终端面板' : '展开终端面板',
        onclick: togglePanel,
      }, h('span', { class: 'ico', html: svgIcon(open ? 'collapse' : 'expand') }),
      h('span', { class: 'pt-label', text: open ? '收起' : '展开' }))));

  const idle = $('panel-idle');
  idle.textContent = '';
  idle.classList.toggle('hidden', Boolean(session));
  if (session) return;

  if (!inst) {
    idle.append(h('span', { class: 'ln cmd', text: '选一个整合包' }));
    return;
  }
  const fg = foregroundMode(inst);
  if (isRunning(inst) || isBroken(inst)) {
    idle.append(
      h('span', { class: 'ln', text: isBroken(inst)
        ? '记录停在 running，进程已经不在了。'
        : '服务进程在跑：它的输出去 harness 自己的日志里看。' }),
      h('span', { class: 'ln', text: '要开前台终端，先在这里停止它。' }));
    return;
  }
  if (!fg) {
    idle.append(h('span', { class: 'ln', text: '这个 harness 只声明了服务类模式，没有可交互的前台会话。' }));
    return;
  }
  idle.append(
    h('span', { class: 'ln cmd', text: '$ ' }, h('b', { text: `pal run ${inst.name}` })),
    h('span', { class: 'ln' }, h('i', { class: 'k', text: 'cwd ' }), inst.root || '—'),
    h('span', { class: 'ln' }, h('i', { class: 'k', text: 'mode' }), `${fg.id} · ${fg.label || fg.id}`),
    h('span', { class: 'ln cmd', text: '$ ' }, h('span', { class: 'caret' })));
}

function togglePanel() {
  state.panelOpen = !state.panelOpen;
  renderPanel();
  requestAnimationFrame(() => fitTerminal());
}

/* ---------- 终端 ---------- */
function ensureTerminal() {
  if (state.term) return true;
  if (typeof Terminal === 'undefined' || typeof FitAddon === 'undefined') return false;
  const term = new Terminal({
    fontFamily: '"Cascadia Mono","Cascadia Code",Consolas,monospace',
    fontSize: 12,
    lineHeight: 1.25,
    cursorBlink: true,
    cursorStyle: 'bar',
    scrollback: 4000,
    theme: {
      background: '#0f1113',
      foreground: '#cfd3cc',
      cursor: '#8fae94',
      cursorAccent: '#0f1113',
      selectionBackground: 'rgba(143,174,148,.22)',
      black: '#1a1d1f', red: '#c06a5e', green: '#7fa87f', yellow: '#b8a86a',
      blue: '#7d93a8', magenta: '#a487a4', cyan: '#79a3a0', white: '#c9ccc6',
      brightBlack: '#5c625b', brightRed: '#d3806f', brightGreen: '#95bd93', brightYellow: '#cdbd7c',
      brightBlue: '#93a8bd', brightMagenta: '#b89cb8', brightCyan: '#8db5b2', brightWhite: '#e7e9e3',
    },
  });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open($('term'));
  term.onData((data) => window.pal.termInput(data));
  window.pal.onTermData((data) => term.write(data));
  window.pal.onTermExit(({ exitCode }) => {
    state.session = state.session ? { ...state.session, live: false, exitCode } : null;
    term.write(`\r\n\x1b[38;5;242m[进程已退出 code ${exitCode}]\x1b[0m\r\n`);
    renderPanel();
  });
  state.term = term;
  state.fit = fit;
  new ResizeObserver(() => fitTerminal()).observe($('term'));
  return true;
}

function fitTerminal() {
  if (!state.fit || !state.term) return;
  const host = $('term');
  if (host.clientHeight < 40 || host.clientWidth < 80) return;
  try {
    state.fit.fit();
    window.pal.termResize(state.term.cols, state.term.rows);
    const dims = `${state.term.cols}×${state.term.rows}`;
    if (state.session && state.session.live && state.lastDims !== dims) {
      state.lastDims = dims;
      renderPanel();
    }
  } catch { /* 容器还没尺寸时忽略 */ }
}

async function openTerminal(inst) {
  if (isRunning(inst)) { toast('进程在跑：先停止，才能开前台 TUI', true); return; }
  const mode = foregroundMode(inst);
  if (!mode) {
    toast(`${hostLabel(inst.harness)} 没有前台模式，不能用 pal run`, true);
    return;
  }
  if (!ensureTerminal()) { toast('终端组件没有加载', true); return; }
  state.panelOpen = true;
  state.session = { id: inst.id, name: inst.name, live: true, exitCode: null };
  state.term.clear();
  renderPanel();
  await new Promise((resolve) => requestAnimationFrame(resolve));
  try {
    state.fit.fit();
    const res = await window.pal.termStart(inst.name, state.term.cols, state.term.rows);
    if (res && res.ok === false) {
      state.session = { ...state.session, live: false };
      toast('终端没有起来', true);
    }
    state.term.focus();
  } catch (err) {
    state.session = { ...state.session, live: false };
    toast(`打开终端失败：${(err && err.message) || err}`, true);
  }
  renderPanel();
}

async function killSession() {
  try {
    await window.pal.termKill();
  } catch { /* 已经退出 */ }
  state.session = null;
  if (state.term) state.term.clear();
  renderPanel();
  toast('终端会话已结束');
}

/* ---------- 行菜单（pack 的更多动作） ---------- */
function packMenuItems(inst) {
  const running = isRunning(inst);
  const broken = isBroken(inst);
  const items = [{ label: '打开详情', icon: 'sliders', run: () => openPackDetail(inst.id) }];
  if (inst.id !== state.packId) items.push({ label: '设为当前整合包', icon: 'check', run: () => setCurrent(inst.id) });
  items.push({ sep: true });
  items.push(running || broken
    ? { label: '停止', icon: 'stop', run: () => stopInstance(inst) }
    : { label: '启动', icon: 'play', run: () => launchInstance(inst) });
  if (inst.url) items.push({ label: '打开页面', icon: 'external', run: () => openExternal(inst.url) });
  items.push({ sep: true });
  if (inst.root) {
    items.push({ label: '打开所在文件夹', icon: 'folder', run: () => reveal(inst) });
    items.push({ label: '复制路径', icon: 'copy', run: () => copyText(inst.root, '路径已复制') });
  }
  return items;
}

function openPackMenu(id, anchor) {
  const inst = byId(id);
  if (!inst || !anchor) return;
  state.menu = { id, rect: anchor.getBoundingClientRect(), anchor };
  const box = $('popover');
  box.textContent = '';
  box.classList.remove('hidden');
  for (const item of packMenuItems(inst)) {
    if (item.sep) { box.append(h('div', { class: 'pm-sep' })); continue; }
    box.append(h('button', {
      class: 'pm-item', type: 'button', role: 'menuitem',
      onclick: () => {
        closeMenu();
        item.run();
      },
    },
    h('span', { class: 'ico', html: svgIcon(item.icon) }),
    h('span', { class: 'pm-label', text: item.label })));
  }
  placePopover(state.menu.rect);
  const first = box.querySelector('.pm-item');
  if (first) first.focus();
}

function placePopover(rect) {
  const box = $('popover');
  const width = box.offsetWidth || 186;
  const height = box.offsetHeight || 160;
  let x = rect.right - width;
  let y = rect.bottom + 5;
  if (y + height > window.innerHeight - 10) y = Math.max(10, rect.top - height - 5);
  x = Math.min(Math.max(8, x), window.innerWidth - width - 8);
  box.style.left = `${Math.round(x)}px`;
  box.style.top = `${Math.round(y)}px`;
}

function closeMenu(opts = {}) {
  const menu = state.menu;
  state.menu = null;
  $('popover').classList.add('hidden');
  $('popover').textContent = '';
  if (opts.restore && menu && menu.anchor && menu.anchor.isConnected) menu.anchor.focus();
}

/* ---------- 弹层：通用外壳 ---------- */
function openModal(spec) {
  state.modal = { returnFocus: document.activeElement, ...spec };
  renderModal();
  const box = $('modal-root').querySelector('.modal');
  if (box) box.focus();
}

function closeModal() {
  const modal = state.modal;
  state.modal = null;
  state.install = null;
  $('modal-root').classList.add('hidden');
  $('modal-root').textContent = '';
  if (modal && modal.returnFocus && modal.returnFocus.isConnected) modal.returnFocus.focus();
}

function modalShell(opts) {
  const root = $('modal-root');
  root.textContent = '';
  root.classList.remove('hidden');
  root.onclick = (event) => {
    if (event.target === root && opts.onScrim !== false && !opts.busy) closeModal();
  };
  const box = h('div', {
    class: 'modal' + (opts.wide ? ' wide' : ''), role: 'dialog', 'aria-modal': 'true',
    'aria-label': opts.title, tabindex: '-1',
  },
  h('div', { class: 'modal-head' },
    h('span', { class: 'modal-title', text: opts.title }),
    opts.sub ? h('span', { class: 'modal-sub' + (opts.subMono ? ' mono' : ''), text: opts.sub }) : null,
    h('div', { class: 'modal-grow' }),
    h('button', {
      class: 'modal-x', type: 'button', 'aria-label': '关闭', onclick: () => closeModal(),
    }, h('span', { class: 'ico', html: svgIcon('x') }))),
  h('div', { class: 'modal-body' }, opts.body),
  h('div', { class: 'modal-foot' }, opts.foot));
  root.append(box);
  if (!root.contains(document.activeElement)) box.focus();
  return box;
}

function renderModal() {
  const modal = state.modal;
  if (!modal) {
    $('modal-root').classList.add('hidden');
    $('modal-root').textContent = '';
    return;
  }
  if (modal.kind === 'install') renderInstallModal();
  else if (modal.kind === 'confirm') renderConfirmModal();
  else if (modal.kind === 'about') renderAboutModal();
}

/* ---------- L3 安装向导 ---------- */
function openInstall(pickedHost, pickedPath) {
  const host = pickedHost || state.harness || 'dsh';
  state.install = {
    step: 1, host, dir: pickedPath || null, preview: null, name: null, done: false, busy: false, error: null, raw: '',
  };
  openModal({ kind: 'install', title: '安装整合包' });
}

function stepsBar(step) {
  const labels = ['选整合包', '选 harness', '确认'];
  return h('div', { class: 'stepper' }, labels.map((label, index) => {
    const n = index + 1;
    const cls = n < step ? ' done' : n === step ? ' on' : '';
    return h('span', { class: `st${cls}`, 'aria-current': n === step ? 'step' : null },
      h('i', { class: 'st-n', html: n < step ? svgIcon('check') : String(n) }),
      label);
  }));
}

function renderInstallModal() {
  const ins = state.install;
  if (!ins) { closeModal(); return; }
  const host = hostOf(ins.host);

  let body;
  let foot;

  if (ins.step === 4) {
    body = h('div', { class: 'fin' },
      ins.done
        ? h('div', { class: 'fin-ok' },
          h('span', { class: 'fin-dot' }),
          h('div', {},
            h('b', { text: ins.name ? `已装好 ${ins.name}` : '安装完成' }),
            h('p', { class: 'fin-s', text: `harness ${host ? host.full : ins.host}；已经切到「启动」视图，当前整合包就是这个。` })))
        : h('div', { class: 'fin-bad' },
          h('span', { class: 'ico', html: svgIcon('alert') }),
          h('div', {},
            h('b', { text: '安装失败' }),
            h('p', { class: 'fin-s', text: '下面是 pal install 的输出。' }))),
      ins.error ? h('pre', { class: 'out', text: ins.error }) : null,
      !ins.done && ins.raw ? h('pre', { class: 'out dim', text: ins.raw }) : null);
    foot = ins.done
      ? [h('button', { class: 'btn ink', type: 'button', onclick: () => closeModal() }, '完成')]
      : [
        h('button', { class: 'btn outline', type: 'button', onclick: () => { ins.step = 3; ins.error = null; renderModal(); } }, '返回'),
        h('button', { class: 'btn ink', type: 'button', onclick: () => doInstall() }, '重试'),
      ];
    modalShell({ title: '安装整合包', sub: ins.done ? '完成' : '失败', body, foot, busy: ins.busy });
    return;
  }

  if (ins.step === 1) {
    body = h('div', { class: 'pickwrap' },
      stepsBar(1),
      h('p', { class: 'lead', text: '先选整合包：把 .phub 拖进窗口，或者选一个 Pack 目录。' }),
      h('div', { class: 'dropzone' + (ins.dir ? ' filled' : '') },
        h('span', { class: 'dz-icon', html: svgIcon('folder-plus') }),
        h('span', { class: 'dz-title', text: ins.dir ? '已选择整合包' : '拖入 .phub 或 Pack 目录' }),
        ins.dir ? h('code', { class: 'dz-path', text: ins.dir, title: ins.dir }) : null,
        h('div', { class: 'dz-actions' },
          h('button', { class: 'btn outline', type: 'button', onclick: () => pickPack() }, '选择 .phub…'),
          h('button', { class: 'btn outline', type: 'button', onclick: () => pickDirectory() }, '选择目录…'))),
      h('p', { class: 'hint', text: '选完再决定装进哪个 harness；下一步会先算安装计划，不落盘。' }));
    foot = [
      h('button', { class: 'btn', type: 'button', onclick: () => closeModal() }, '取消'),
      h('button', {
        class: 'btn ink', type: 'button', disabled: !ins.dir,
        onclick: () => { ins.step = 2; renderModal(); },
      }, '下一步'),
    ];
  } else if (ins.step === 2) {
    body = h('div', { class: 'pickwrap' },
      stepsBar(2),
      h('p', { class: 'lead', text: `这个整合包装进哪个 harness？默认跟着当前上下文（${host ? host.full : ins.host}）。` }),
      h('div', { class: 'pick-list' }, HOSTS.map((item) => {
        const count = state.instances.filter((x) => x.harness === item.id).length;
        return h('button', {
          class: 'pick', type: 'button', role: 'radio',
          'aria-checked': ins.host === item.id ? 'true' : 'false',
          onclick: () => { ins.host = item.id; renderModal(); },
        },
        h('span', { class: `tile sm hm-${item.id}`, text: item.code }),
        h('span', { class: 'pick-main' },
          h('span', { class: 'pick-t', text: item.full }),
          h('span', { class: 'pick-s', text: count ? `${count} 个整合包` : '还没有整合包' })),
        h('span', { class: 'pick-check', html: ins.host === item.id ? svgIcon('check') : '' }));
      })),
      h('p', { class: 'hint', text: '托管 home 建在 PAL 数据目录下；attached 宿主也可以随后在命令行用 --home 装进它自己的目录。' }));
    foot = [
      h('button', { class: 'btn outline', type: 'button', onclick: () => { ins.step = 1; renderModal(); } },
        h('span', { class: 'ico', html: svgIcon('chevron-left') }), '返回'),
      h('button', {
        class: 'btn ink', type: 'button',
        onclick: () => runInstallPreview(),
      }, '下一步'),
    ];
  } else {
    const preview = ins.preview || { loading: true };
    let pv;
    if (preview.loading) {
      pv = h('div', { class: 'pv-loading pulse' }, h('div', { class: 'pv-bar' }), h('div', { class: 'pv-bar short' }));
    } else if (preview.ok === false) {
      pv = h('div', { class: 'pv-err' },
        h('span', { class: 'ico', html: svgIcon('alert') }),
        h('div', {},
          h('b', { text: '这个目录装不了' }),
          h('pre', { class: 'out', text: preview.error || 'pal install --dry-run 返回非 0' })));
    } else {
      const plan = preview.plan || {};
      const pack = plan.pack || {};
      const actions = Array.isArray(plan.actions) ? plan.actions : [];
      const shown = actions.slice(0, 10).map((a) => [
        String(a.actionId || ''),
        String(a.op || ''),
        a.to || a.dest || a.path || '',
      ]);
      const wA = Math.min(20, Math.max(0, ...shown.map((r) => r[0].length)) + 2);
      const wB = Math.max(0, ...shown.map((r) => r[1].length)) + 2;
      const planText = shown.map(([id, op, dest]) => `${id.padEnd(wA)}${op.padEnd(wB)}${dest}`).join('\n')
        + (actions.length > 10 ? `\n… 另有 ${actions.length - 10} 条` : '');
      pv = h('div', { class: 'pv' },
        h('div', { class: 'pv-head' },
          h('span', { class: 'pv-pack', text: `${pack.name || '未知 Pack'}${pack.version ? `@${pack.version}` : ''}` }),
          h('span', { class: 'pill', text: host ? host.full : ins.host })),
        h('dl', { class: 'pv-grid' },
          h('div', {}, h('dt', { text: '落点' }), h('dd', { text: preview.name || '新建托管 home' })),
          h('div', {}, h('dt', { text: '动作' }), h('dd', { text: `${actions.length} 条` })),
          h('div', {}, h('dt', { text: '目录' }), h('dd', { class: 'mono', text: ins.dir, title: ins.dir }))),
        actions.length ? h('pre', { class: 'plan-lines', text: planText }) : null,
        h('p', { class: 'hint', text: '预览没有落盘。确认后才会真正写文件。' }));
    }
    body = h('div', { class: 'pickwrap' }, stepsBar(3), pv);
    const ready = preview && preview.ok === true;
    foot = [
      h('button', {
        class: 'btn outline', type: 'button', disabled: ins.busy,
        onclick: () => { ins.step = 2; renderModal(); },
      }, h('span', { class: 'ico', html: svgIcon('chevron-left') }), '返回'),
      h('button', {
        class: 'btn ink', type: 'button', disabled: !ready || ins.busy,
        onclick: () => doInstall(),
      }, ins.busy ? '正在安装…' : '安装'),
    ];
  }

  modalShell({
    title: '安装整合包',
    sub: ins.step < 4 ? `第 ${Math.min(ins.step, 3)} 步，共 3 步` : '',
    body,
    foot,
    busy: ins.busy,
  });
}

async function pickPack() {
  const ins = state.install;
  try {
    const res = await window.pal.pickPack();
    if (res && res.error) { toast(`选不了整合包：${res.error}`, true); return; }
    if (!res || res.canceled || !res.path) return;
    ins.dir = res.path;
    ins.preview = null;
    renderModal();
  } catch (err) {
    toast(`选不了整合包：${(err && err.message) || err}`, true);
  }
}

async function pickDirectory() {
  const ins = state.install;
  try {
    const res = await window.pal.pickDirectory();
    if (res && res.error) { toast(`选不了目录：${res.error}`, true); return; }
    if (!res || res.canceled || !res.path) return;
    ins.dir = res.path;
    ins.preview = null;
    renderModal();
  } catch (err) {
    toast(`选不了目录：${(err && err.message) || err}`, true);
  }
}

async function runInstallPreview() {
  const ins = state.install;
  ins.step = 3;
  ins.preview = { loading: true };
  renderModal();
  try {
    const res = await window.pal.installPreview(ins.host, ins.dir);
    if (!res || !res.ok) {
      ins.preview = { ok: false, error: (res && res.error) || '预览失败' };
    } else {
      ins.preview = { ok: true, plan: res.plan, name: res.name || null };
    }
  } catch (err) {
    ins.preview = { ok: false, error: String((err && err.message) || err) };
  }
  renderModal();
}

async function doInstall() {
  const ins = state.install;
  ins.busy = true;
  ins.error = null;
  ins.raw = '';
  renderModal();
  try {
    const res = await window.pal.install(ins.host, ins.dir);
    ins.busy = false;
    if (!res || res.ok !== true) {
      ins.step = 4;
      ins.done = false;
      ins.error = (res && (res.error || res.stderr || res.stdout)) || 'pal install 返回非 0';
      ins.raw = (res && res.stdout) || '';
      renderModal();
      return;
    }
    ins.step = 4;
    ins.done = true;
    ins.name = res.name || (res.record && res.record.name) || '';
    renderModal();
    await refresh();
    const fresh = state.instances.find((x) => x.name === ins.name);
    if (fresh) {
      state.harness = fresh.harness;
      state.packId = fresh.id;
      state.packByHarness[fresh.harness] = fresh.id;
    }
    state.detailId = null;
    state.view = 'launch';
    state.tab = 'overview';
    saveBrief();
    render();
    toast(ins.name ? `已装好 ${ins.name}` : '安装完成');
  } catch (err) {
    ins.busy = false;
    ins.step = 4;
    ins.done = false;
    ins.error = String((err && err.message) || err);
    renderModal();
  }
}

/* ---------- L3 危险确认 ---------- */
const CONFIRM_COPY = {
  update: {
    title: '更新整合包',
    lead: (inst) => ['把 ', h('b', { text: inst.name }), ' 的整合包换成 registry 的最新版。'],
    points: [
      '实例必须已停止（更新前会先拦下在跑的进程）',
      'Pack 写过的文件如果被本地改过，更新会被拒绝，需要先确认改了什么',
      '更新后记录里的版本号会一起改',
    ],
    label: '更新',
  },
  uninstall: {
    title: '卸载整合包',
    lead: (inst) => ['从 ', h('b', { text: inst.name }), ' 里摘掉这个 Pack 写进去的文件。'],
    points: [
      '实例必须已停止',
      '实例记录和目录会保留，之后可以重新装',
      'Pack 之外的文件不动',
    ],
    label: '卸载',
  },
  remove: {
    title: '删除实例',
    lead: (inst) => (inst.attached
      ? ['摘掉 ', h('b', { text: inst.name }), ' 的 PAL 记录；目录与其中文件留在原处。']
      : ['删掉 ', h('b', { text: inst.name }), ' 这个实例：先停进程，再连同 home 目录一起删除。']),
    points: (inst) => (inst.attached
      ? ['只删 PAL 的 instance / runtime / baseline 记录', '目录与用户文件不会被删除', '之后可以再装进同一个目录']
      : ['会先停止正在跑的进程', '整个 home 目录（含会话与凭据）会被删除，不可恢复', '想保留数据就先在命令行用 pal remove --keep-data 归档']),
    label: '删除',
    danger: true,
  },
};

function confirmAction(kind, inst) {
  const copy = CONFIRM_COPY[kind];
  if (!copy) return;
  openModal({
    kind: 'confirm',
    title: copy.title,
    spec: {
      kind, inst, copy,
      points: typeof copy.points === 'function' ? copy.points(inst) : copy.points,
      error: null,
      busy: false,
    },
  });
}

function renderConfirmModal() {
  const modal = state.modal;
  const spec = modal.spec;
  const copy = spec.copy;
  const inst = spec.inst;

  const body = h('div', { class: 'cf' },
    h('p', { class: 'cf-lead' }, copy.lead(inst)),
    h('ul', { class: 'cf-list' }, spec.points.map((point) => h('li', { text: point }))),
    h('div', { class: 'cf-target' },
      h('span', { class: 'cf-t', text: '实例' }),
      h('span', { class: 'cf-v mono', text: inst.name }),
      spec.kind === 'remove' && inst.root
        ? [h('span', { class: 'cf-t', text: '目录' }), h('span', { class: 'cf-v mono', text: inst.root, title: inst.root })]
        : null),
    spec.error ? h('pre', { class: 'out', text: spec.error }) : null);

  const foot = [
    h('button', { class: 'btn outline', type: 'button', disabled: spec.busy, onclick: () => closeModal() }, '取消'),
    h('button', {
      class: 'btn ink' + (copy.danger ? ' danger' : ''),
      type: 'button',
      disabled: spec.busy,
      onclick: () => runConfirm(),
    }, spec.busy ? '正在执行…' : copy.label),
  ];

  modalShell({
    title: copy.title,
    sub: inst.name,
    subMono: true,
    body,
    foot,
    busy: spec.busy,
    wide: copy.danger,
  });
}

async function runConfirm() {
  const spec = state.modal && state.modal.spec;
  if (!spec || spec.busy) return;
  spec.busy = true;
  spec.error = null;
  renderConfirmModal();
  try {
    const res = await window.pal.action(spec.inst.name, spec.kind);
    if (!res || res.ok !== true) {
      spec.busy = false;
      spec.error = (res && (res.error || res.stderr || res.stdout)) || `pal ${spec.kind} 返回非 0`;
      renderConfirmModal();
      return;
    }
    const label = spec.copy.label;
    const name = spec.inst.name;
    closeModal();
    toast(`${name} · ${label}完成`);
    await refresh();
  } catch (err) {
    spec.busy = false;
    spec.error = String((err && err.message) || err);
    if (state.modal) renderConfirmModal();
  }
}

/* ---------- L3 关于 ---------- */
function renderAboutModal() {
  const version = state.info && state.info.version ? ` ${state.info.version}` : '';
  const body = h('div', { class: 'about' },
    h('p', {
      class: 'lead',
      text: `PAL 是本地实例启动器：顶部选 harness，三个视图分别是启动、整合包、设置。启动视图只放当前整合包，全部整合包在「整合包」，数据目录与快捷键在「设置」。`,
    }),
    h('div', { class: 'kb-table' }, KEYMAP.map(([key, label]) => h('div', { class: 'kb-row' },
      h('kbd', { text: key }),
      h('span', { text: label })))),
    h('p', { class: 'hint', text: '终端里的输出只属于当前会话；关掉 PAL 不会停掉已经在后台跑的服务，用「停止」显式收回。' }));

  modalShell({
    title: `关于${version ? ` · ${version.trim()}` : ''}`,
    body,
    foot: [h('button', { class: 'btn ink', type: 'button', onclick: () => closeModal() }, '知道了')],
  });
}

/* ---------- 键盘 ---------- */
function trapFocus(event) {
  const root = $('modal-root');
  const focusables = Array.from(root.querySelectorAll('button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'))
    .filter((el) => el.offsetParent !== null);
  if (!focusables.length) return;
  const first = focusables[0];
  const last = focusables[focusables.length - 1];
  const active = document.activeElement;
  if (!root.contains(active) || active === root.querySelector('.modal')) {
    event.preventDefault();
    (event.shiftKey ? last : first).focus();
  } else if (event.shiftKey && active === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && active === last) {
    event.preventDefault();
    first.focus();
  }
}

function movePackFocus(delta) {
  const rows = Array.from(document.querySelectorAll('#lib-scroll .pk-row'));
  if (!rows.length) return;
  const index = rows.indexOf(document.activeElement);
  const next = index < 0
    ? (delta > 0 ? 0 : rows.length - 1)
    : Math.min(rows.length - 1, Math.max(0, index + delta));
  rows[next].focus();
}

function moveMenuFocus(delta) {
  const items = Array.from($('popover').querySelectorAll('.pm-item'));
  if (!items.length) return;
  const index = items.indexOf(document.activeElement);
  const next = (index + delta + items.length) % items.length;
  items[index < 0 ? 0 : next].focus();
}

function inEditable(target) {
  return Boolean(target && target.closest
    && target.closest('input, select, textarea, [contenteditable="true"], #term'));
}

document.addEventListener('keydown', (event) => {
  const target = event.target;

  if (state.modal) {
    if (event.key === 'Escape') { event.preventDefault(); closeModal(); return; }
    if (event.key === 'Tab') { trapFocus(event); return; }
    return;
  }

  if (state.menu) {
    if (event.key === 'Escape') { event.preventDefault(); closeMenu({ restore: true }); return; }
    if (event.key === 'ArrowDown') { event.preventDefault(); moveMenuFocus(1); return; }
    if (event.key === 'ArrowUp') { event.preventDefault(); moveMenuFocus(-1); return; }
  }

  if (inEditable(target)) return;

  if (event.key === 'Escape') {
    if (state.view === 'library' && state.detailId) { event.preventDefault(); backToLibrary(); }
    return;
  }

  if (event.key === 'F5') {
    event.preventDefault();
    refresh();
    return;
  }

  if ((event.metaKey || event.ctrlKey) && /^[1-3]$/.test(event.key)) {
    event.preventDefault();
    setView(NAV[Number(event.key) - 1].id);
    return;
  }

  const navBtn = target && target.closest && target.closest('.nav-btn');
  if (navBtn && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
    event.preventDefault();
    const index = NAV.findIndex((x) => x.id === state.view);
    const next = (index + (event.key === 'ArrowRight' ? 1 : -1) + NAV.length) % NAV.length;
    setView(NAV[next].id);
    const btn = $(`nav-${NAV[next].id}`);
    if (btn) btn.focus();
    return;
  }

  const tabBtn = target && target.closest && target.closest('.tab');
  if (tabBtn && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
    event.preventDefault();
    const ids = TABS.map((x) => x.id);
    const index = ids.indexOf(state.tab);
    const next = (index + (event.key === 'ArrowRight' ? 1 : -1) + ids.length) % ids.length;
    selectTab(ids[next]);
    const btn = document.querySelector(`.tab[data-tab="${ids[next]}"]`);
    if (btn) btn.focus();
    return;
  }

  if (state.view === 'library' && !state.detailId && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
    event.preventDefault();
    movePackFocus(event.key === 'ArrowDown' ? 1 : -1);
    return;
  }

  if (event.key === 'Enter' && state.view === 'launch') {
    const onControl = target && target.closest && target.closest('button, a, input, select, textarea, [contenteditable]');
    if (onControl) return;
    const inst = currentPack();
    if (inst) launchInstance(inst);
  }
});

document.addEventListener('click', (event) => {
  if (state.menu) {
    if (event.target.closest('#popover') || event.target.closest('.ract-more')) { /* 自己 */ }
    else { closeMenu(); }
  }
});

/* ---------- 绑定 ---------- */
$('refresh').addEventListener('click', refresh);
$('add-pack').addEventListener('click', () => openInstall());
$('about').addEventListener('click', () => openModal({ kind: 'about' }));
$('harness-switch').addEventListener('change', (event) => switchHarness(event.target.value));

document.querySelectorAll('[data-icon]').forEach((node) => {
  node.innerHTML = svgIcon(node.dataset.icon);
});

window.addEventListener('resize', () => {
  if (state.menu) placePopover(state.menu.rect);
});

// 拖入 .phub 或 Pack 目录：直接进安装弹层的第一步（已选中），再选 harness。
window.addEventListener('dragover', (event) => {
  if (!event.dataTransfer || !Array.from(event.dataTransfer.types).includes('Files')) return;
  event.preventDefault();
  document.body.classList.add('drag-over');
});
window.addEventListener('dragleave', (event) => {
  if (event.relatedTarget === null) document.body.classList.remove('drag-over');
});
window.addEventListener('drop', (event) => {
  event.preventDefault();
  document.body.classList.remove('drag-over');
  const file = event.dataTransfer && event.dataTransfer.files && event.dataTransfer.files[0];
  if (!file) return;
  const path = window.pal.pathForFile(file);
  if (!path) { toast('读不到拖入文件的路径', true); return; }
  openInstall(state.harness || 'dsh', path);
});

/* ---------- 启动 ---------- */
loadBrief();
render();
refresh();
loadInfo();
