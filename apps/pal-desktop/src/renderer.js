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
  check: '<path d="M5 12.5 9.7 17 19 6.5"/>',
  stop: '<rect x="6.6" y="6.6" width="10.8" height="10.8" rx="2"/>',
  expand: '<path d="M9.5 4.5H5.5a1 1 0 0 0-1 1v4M14.5 19.5h4a1 1 0 0 0 1-1v-4M4.5 14.5v4a1 1 0 0 0 1 1h4M19.5 9.5v-4a1 1 0 0 0-1-1h-4"/>',
  collapse: '<path d="M4.5 9.5h4a1 1 0 0 0 1-1v-4M19.5 14.5h-4a1 1 0 0 0-1 1v4M14.5 4.5v4a1 1 0 0 0 1 1h4M9.5 19.5v-4a1 1 0 0 0-1-1h-4"/>',
  external: '<path d="M13.5 4.5H19a.5.5 0 0 1 .5.5v5.5M19.2 4.8 11.5 12.5"/><path d="M17 14.2v4.3a1.5 1.5 0 0 1-1.5 1.5H5.5A1.5 1.5 0 0 1 4 18.5V8.5A1.5 1.5 0 0 1 5.5 7h4.4"/>',
  terminal: '<rect x="3.4" y="4.8" width="17.2" height="14.4" rx="2.2"/><path d="M7.2 10.2 9.6 12.2 7.2 14.2M12.2 14.6h4.6"/>',
  alert: '<path d="M12 4.8 20.5 19.5h-17z"/><path d="M12 10.4v3.6M12 16.6v.02"/>',
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

const state = {
  instances: [],
  filter: 'all',
  selectedId: null,
  loading: true,
  error: null,
  menuOpen: false,
  term: null,
  fit: null,
  session: null, // { id, name, live, exitCode }
  lastDims: '',
  panelOpen: true,
};

/* ---------- 数据 ---------- */
const hostOf = (id) => HOSTS.find((x) => x.id === id) || null;
const hostLabel = (id) => (hostOf(id) ? hostOf(id).label : id);
const hostFull = (id) => (hostOf(id) ? hostOf(id).full : id);
const hostCode = (id) => (hostOf(id) ? hostOf(id).code : String(id).slice(0, 2).toUpperCase());
const packText = (inst) => (inst.pack ? `${inst.pack.name}@${inst.pack.version}` : '');
const selected = () => state.instances.find((x) => x.id === state.selectedId) || null;
const isRunning = (inst) => inst.status === 'running';
const isBroken = (inst) => inst.status === 'broken' || inst.status === 'failed';

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

function visible() {
  const list = state.filter === 'all'
    ? state.instances.slice()
    : state.instances.filter((x) => x.harness === state.filter);
  return list.sort((a, b) => {
    const ar = isRunning(a) ? 0 : 1;
    const br = isRunning(b) ? 0 : 1;
    if (ar !== br) return ar - br;
    return String(a.name).localeCompare(String(b.name));
  });
}

function toast(text, bad) {
  const node = h('div', { class: 'toast' + (bad ? ' bad' : '') },
    h('span', { class: 'tdot' }),
    h('span', { text }));
  $('toasts').append(node);
  setTimeout(() => node.remove(), bad ? 5200 : 2600);
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
    const stillThere = state.instances.some((x) => x.id === state.selectedId);
    if (!stillThere) {
      const running = state.instances.find(isRunning);
      state.selectedId = running ? running.id : (state.instances[0] ? state.instances[0].id : null);
    }
    render();
  } catch (err) {
    state.loading = false;
    state.error = String((err && err.message) || err);
    render();
  }
}

function render() {
  renderRail();
  renderPane();
  syncPanel();
  renderStatus();
}

/* ---------- 左栏 ---------- */
function renderRail() {
  const list = visible();
  $('count').textContent = state.error ? '—' : String(state.instances.length);
  $('filter-label').textContent = state.filter === 'all' ? '全部' : hostLabel(state.filter);
  const showEmpty = !list.length && !state.loading && state.instances.length > 0;
  $('empty').classList.toggle('hidden', !showEmpty);
  $('home-list').classList.toggle('hidden', list.length === 0 && !state.loading);
  if (showEmpty) {
    $('empty').querySelector('.re-body').textContent = `另外 ${state.instances.length} 个实例在别的宿主下。`;
  }

  const box = $('home-list');
  box.textContent = '';

  if (state.loading && !state.instances.length) {
    for (let i = 0; i < 5; i += 1) {
      box.append(h('div', { class: 'sk-row pulse' },
        h('div', { class: 'sk-tile' }),
        h('div', {}, h('div', { class: 'sk-line' }), h('div', { class: 'sk-line' }))));
    }
    return;
  }

  for (const inst of list) box.append(railRow(inst));

  const active = box.querySelector('.row.sel');
  if (active) active.scrollIntoView({ block: 'nearest' });
}

function railRow(inst) {
  const status = statusOf(inst);
  const sub = packText(inst) || hostFull(inst.harness);
  const row = h('button', {
    class: 'row' + (inst.id === state.selectedId ? ' sel' : ''),
    type: 'button',
    role: 'option',
    'aria-selected': inst.id === state.selectedId ? 'true' : 'false',
    title: `${inst.name} · ${status.text}`,
    onclick: () => { state.selectedId = inst.id; render(); },
    ondblclick: () => launchInstance(inst),
  },
  h('span', { class: `tile hm-${inst.harness}`, text: hostCode(inst.harness) }),
  h('span', { class: 'r-main' },
    h('span', { class: 'r-name', text: inst.name }),
    h('span', { class: 'r-sub', text: sub })),
  status.key === 'idle'
    ? h('span', { class: 'r-state' })
    : h('span', { class: 'r-state' }, h('span', { class: `dot ${status.key}` })));
  row.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') { event.stopPropagation(); launchInstance(inst); }
  });
  return row;
}

/* ---------- 右栏 ---------- */
function renderPane() {
  const head = $('pane-head');
  const body = $('pane-body');
  head.textContent = '';
  body.textContent = '';
  const noInstances = !state.instances.length && !state.error;

  if (state.loading && !state.instances.length) {
    head.classList.add('hidden');
    body.append(h('div', { class: 'sk-block pulse' }));
    return;
  }

  if (state.error) {
    head.classList.add('hidden');
    body.append(h('div', { class: 'err' },
      h('h4', { text: '读不到实例列表' }),
      h('pre', { text: state.error }),
      h('button', { class: 'btn outline', type: 'button', onclick: refresh }, '重试')));
    return;
  }

  const inst = selected();
  if (!inst || noInstances) {
    head.classList.add('hidden');
    body.append(emptyPane());
    return;
  }

  head.classList.remove('hidden');
  renderHead(head, inst);
  renderBody(body, inst);
}

function emptyPane() {
  const anyHere = state.instances.length > 0;
  const host = state.filter !== 'all' ? state.filter : 'dsh';
  return h('div', { class: 'pane-empty' },
    h('p', { class: 'pe-title', text: anyHere ? '这个宿主下没有实例' : '还没有实例' }),
    h('p', {
      class: 'pe-body',
      text: anyHere
        ? '换一个宿主筛选，或者也给这个宿主装一个整合包。'
        : '选一个整合包目录，PAL 会为它建一个 home 并列到左边。装好之后，这一栏就是它的启动面板。',
    }),
    h('div', { class: 'pe-actions' },
      h('button', { class: 'btn ink', type: 'button', onclick: installPack },
        h('span', { class: 'ico', html: svgIcon('folder-plus') }), '添加整合包')),
    h('pre', { class: 'pe-cli', text: `$ pal install <pack 目录> --host ${host}` }));
}

function renderHead(head, inst) {
  const status = statusOf(inst);
  const mode = defaultMode(inst);
  const running = isRunning(inst);

  const eyebrow = h('div', { class: 'eyebrow' },
    hostFull(inst.harness),
    h('span', { class: 'sep' }),
    h('span', { class: 'mono', text: inst.id }));

  const subline = h('div', { class: 'subline' },
    h('span', { class: 'mono', text: packText(inst) || '未挂钩整合包' }),
    h('span', { class: 'sep' }),
    h('span', { class: `pill ${status.key === 'idle' ? '' : status.key}` },
      status.key === 'idle' ? null : h('span', { class: `dot ${status.key}` }),
      status.text));

  head.append(h('div', { class: 'ph-main' },
    eyebrow,
    h('h1', { class: 'inst-name', text: inst.name, title: inst.name }),
    subline));

  const act = h('div', { class: 'ph-act' });
  act.append(primaryButton(inst));

  const btns = h('div', { class: 'ph-btns' });
  if (inst.url) {
    btns.append(h('button', {
      class: 'btn', id: 'open-page', type: 'button',
      onclick: () => window.pal.openExternal(inst.url),
    }, h('span', { class: 'ico', html: svgIcon('external') }), '打开页面'));
  }
  if (btns.childElementCount) act.append(btns);

  const note = state.session && state.session.id === inst.id && state.session.live
    ? '' : paneNote(inst, mode, running);
  if (note) act.append(h('div', { class: 'ph-note', text: note }));
  head.append(act);
}

function paneNote(inst, mode, running) {
  if (isBroken(inst)) return '记录还停在 running，pid 已经不在了：点「停止」清掉这条记录';
  if (!running && mode && mode.available === false) return mode.reason || '这个模式在当前 home 上不可用';
  if (running) return inst.url ? '服务在跑：用「打开页面」进界面' : '进程在跑：先停止再换模式';
  if (mode && mode.kind === 'foreground') return '启动会在下方终端里开一个前台会话';
  if (mode && mode.kind === 'server') return '启动后起本地服务，并自动用浏览器打开页面';
  return '';
}

function primaryButton(inst) {
  const running = isRunning(inst);
  const broken = isBroken(inst);
  const mode = defaultMode(inst);
  if (running || broken) {
    return h('button', {
      class: 'launch stop', type: 'button',
      title: broken ? '记录还停在 running，但 pid 已经不在：停止会清掉这条记录' : '停止这个实例',
      onclick: () => stopInstance(inst),
    }, h('span', { class: 'ico', html: svgIcon('stop') }), '停止');
  }
  if (!mode || mode.available === false) {
    return h('button', {
      class: 'launch off', type: 'button', disabled: true,
      title: (mode && mode.reason) || '这个实例没有可用的启动模式',
    }, '不可启动');
  }
  return h('button', {
    class: 'launch', type: 'button', title: `${mode.label}（${mode.id}）`,
    onclick: () => launchInstance(inst),
  }, '启动');
}

function renderBody(body, inst) {
  body.append(h('div', { class: 'cols' },
    h('section', { class: 'col' },
      h('h2', { class: 'sec-t' }, '概览'),
      factList(inst)),
    h('section', { class: 'col' },
      h('h2', { class: 'sec-t' }, '启动方式', h('span', { class: 'n', text: String((inst.modes || []).length) })),
      modeList(inst))));
}

function factList(inst) {
  const mode = defaultMode(inst);
  const rows = [
    ['实例 ID', inst.id, false],
    ['路径', inst.root || '—', !inst.root],
  ];
  if (inst.home && inst.home !== inst.root) rows.push(['Home', inst.home, false]);
  if (inst.url) rows.push(['地址', inst.url, false]);
  else if (inst.port) rows.push(['端口', String(inst.port), false]);
  if (inst.pid) rows.push(['PID', String(inst.pid), false]);
  if (inst.profile) rows.push(['Profile', inst.profile, false]);
  if (inst.launchMode) rows.push(['上次模式', inst.launchMode, false]);
  rows.push(['默认模式', mode ? `${mode.id} · ${kindWord(mode.kind)}` : '—', !mode]);

  return h('dl', { class: 'facts' },
    rows.map(([key, value, dim]) => h('div', { class: 'fact' },
      h('dt', { text: key }),
      h('dd', { class: dim ? 'dim' : '', text: value, title: value }))));
}

function modeList(inst) {
  const modes = inst.modes || [];
  const running = isRunning(inst);
  const broken = isBroken(inst);
  if (!modes.length) {
    return h('div', { class: 'modes' },
      h('div', { class: 'mode-item' }, h('div', { class: 'mode-note', text: '这个宿主没有声明启动模式' })));
  }
  return h('div', { class: 'modes' },
    modes.map((mode) => {
      const off = running || broken || mode.available === false;
      const side = running || broken ? '运行中' : mode.available === false ? '不可用' : '启动';
      return h('div', { class: 'mode-item' },
        h('button', {
          class: 'mode-btn', type: 'button', disabled: off,
          title: mode.available === false ? (mode.reason || '不可用') : running || broken ? '先停止再启动' : `以 ${mode.id} 启动`,
          onclick: () => launchMode(inst, mode),
        },
        h('span', { class: 'mi-main' },
          h('span', { class: 'mi-label' },
            mode.label || mode.id,
            mode.default ? h('span', { class: 'tag', text: '默认' }) : null),
          h('span', { class: 'mi-id', text: `--mode ${mode.id}` })),
        h('span', { class: 'mi-side' },
          side,
          off ? null : h('span', { class: 'ico', html: svgIcon('chevron-right') }))));
    }));
}

/* ---------- 状态栏 ---------- */
function renderStatus() {
  const total = state.instances.length;
  const live = state.instances.filter(isRunning).length;
  const box = $('sb-count');
  box.textContent = '';
  box.append(h('b', { text: String(total) }), ' 个实例');
  if (live) box.append(' · ', h('b', { text: String(live) }), ' 个运行中');

  const filterBox = $('sb-filter');
  filterBox.textContent = '';
  if (state.filter !== 'all') {
    filterBox.append('筛选：', h('b', { text: hostLabel(state.filter) }),
      h('button', {
        class: 'sb-x', type: 'button', title: '清除筛选',
        onclick: () => { state.filter = 'all'; render(); },
      }, '×'));
  }
}

/* ---------- 动作 ---------- */
async function launchInstance(inst) {
  const mode = defaultMode(inst);
  if (!mode) { toast('这个实例没有启动模式', true); return; }
  await launchMode(inst, mode);
}

async function launchMode(inst, mode) {
  if (isRunning(inst)) { toast('进程在跑：先停止再启动', true); return; }
  if (mode.available === false) { toast(mode.reason || '这个模式不可用', true); return; }
  if (mode.kind === 'foreground') { await openTerminal(inst); return; }
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
  }
}

async function stopInstance(inst) {
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
  }
}

async function installPack() {
  const current = selected();
  const host = state.filter !== 'all' ? state.filter : (current ? current.harness : 'dsh');
  try {
    const res = await window.pal.install(host);
    if (!res || res.canceled) return;
    if (!res.ok) {
      toast(`安装失败：${String(res.stderr || res.stdout || '').trim() || 'pal install 返回非 0'}`, true);
      return;
    }
    toast('安装完成');
    await refresh();
  } catch (err) {
    toast(`安装失败：${(err && err.message) || err}`, true);
  }
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
    render();
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
      syncPanel();
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
  syncPanel();
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
  render();
}

async function killSession() {
  try {
    await window.pal.termKill();
  } catch { /* 已经退出 */ }
  state.session = null;
  if (state.term) state.term.clear();
  syncPanel();
  toast('终端会话已结束');
}

function syncPanel() {
  const panel = $('panel');
  panel.classList.toggle('collapsed', !state.panelOpen);
  panel.classList.toggle('hidden', !selected() && !state.session);
  panel.classList.toggle('wide', Boolean(state.session));
  const toggle = $('panel-toggle');
  toggle.querySelector('.pt-label').textContent = state.panelOpen ? '收起' : '展开';
  toggle.querySelector('.ico').innerHTML = svgIcon(state.panelOpen ? 'collapse' : 'expand');
  toggle.title = state.panelOpen ? '收起终端面板' : '展开终端面板';

  const session = state.session;
  const box = $('panel-state');
  box.textContent = '';
  box.classList.toggle('live', Boolean(session && session.live));
  box.append(h('span', { class: 'dot' }));

  const idle = $('panel-idle');
  idle.textContent = '';
  const kill = $('panel-kill');

  if (session) {
    kill.disabled = !session.live;
    const dims = state.term && session.live ? ` · ${state.term.cols}×${state.term.rows}` : '';
    box.append(session.live ? `pal run ${session.name}${dims}` : `${session.name} · 已退出 code ${session.exitCode}`);
    idle.classList.add('hidden');
    return;
  }

  kill.disabled = true;
  idle.classList.remove('hidden');
  const inst = selected();
  if (!inst) {
    box.append('未连接');
    idle.append(h('span', { class: 'ln cmd', text: '选一个实例' }));
    return;
  }
  if (isRunning(inst) || isBroken(inst)) {
    const modeId = inst.launchMode || (defaultMode(inst) ? defaultMode(inst).id : 'web');
    box.append(isBroken(inst) ? '记录异常' : `进程运行中${inst.pid ? ` · pid ${inst.pid}` : ''}`);
    idle.append(
      h('span', { class: 'ln cmd' }, '$ ', h('b', { text: `pal start ${inst.name} --mode ${modeId}` })),
      h('span', { class: 'ln gap' }, h('i', { class: 'k', text: 'run' }),
        isBroken(inst) ? '记录停在 running，pid 已经不在了' : (inst.pid ? `pid ${inst.pid}` : 'running')),
      inst.url ? h('span', { class: 'ln' }, h('i', { class: 'k', text: 'url' }), inst.url) : null);
    return;
  }
  const fg = foregroundMode(inst);
  if (!fg) {
    const mode = defaultMode(inst);
    box.append(`${hostLabel(inst.harness)} 无前台模式`);
    idle.append(
      h('span', { class: 'ln cmd', text: '$ ' }, h('b', { text: `pal start ${inst.name}${mode ? ` --mode ${mode.id}` : ''}` })),
      h('span', { class: 'ln' }, h('i', { class: 'k', text: 'cwd ' }), inst.root || '—'),
      h('span', { class: 'ln gap', text: `${hostLabel(inst.harness)} 只声明了${mode ? kindWord(mode.kind) : '启动'}模式，输出不进这个面板` }));
    return;
  }
  box.append('未连接');
  idle.append(
    h('span', { class: 'ln cmd', text: '$ ' }, h('b', { text: `pal run ${inst.name}` })),
    h('span', { class: 'ln' }, h('i', { class: 'k', text: 'cwd ' }), inst.root || '—'),
    h('span', { class: 'ln' }, h('i', { class: 'k', text: 'mode' }), `${fg.id} · ${fg.label || fg.id}`),
    h('span', { class: 'ln gap', text: '点「启动」或双击实例，在这里跑前台 TUI' }),
    h('span', { class: 'ln cmd', text: '$ ' }, h('span', { class: 'caret' })));
}

/* ---------- 筛选菜单 ---------- */
function renderMenu() {
  const box = $('filter-menu');
  box.textContent = '';
  const items = [{ id: 'all', label: '全部', count: state.instances.length }].concat(
    HOSTS.map((host) => ({
      id: host.id,
      label: host.full,
      count: state.instances.filter((x) => x.harness === host.id).length,
    })).filter((item) => item.count > 0 || state.filter === item.id));
  for (const item of items) {
    box.append(h('button', {
      class: 'menu-item', type: 'button', role: 'menuitem',
      onclick: () => { state.filter = item.id; closeMenu(); render(); },
    },
    h('span', { class: 'mi-ico', html: state.filter === item.id ? svgIcon('check') : '' }),
    h('span', { class: 'mi-name', text: item.label }),
    h('span', { class: 'mi-n', text: String(item.count) })));
  }
}

function openMenu() {
  state.menuOpen = true;
  renderMenu();
  $('filter-menu').classList.remove('hidden');
  $('filter-btn').setAttribute('aria-expanded', 'true');
}

function closeMenu() {
  state.menuOpen = false;
  $('filter-menu').classList.add('hidden');
  $('filter-btn').setAttribute('aria-expanded', 'false');
}

/* ---------- 交互绑定 ---------- */
function moveSelection(delta) {
  const list = visible();
  if (!list.length) return;
  const index = list.findIndex((x) => x.id === state.selectedId);
  const next = Math.min(list.length - 1, Math.max(0, (index < 0 ? 0 : index) + delta));
  state.selectedId = list[next].id;
  render();
}

document.addEventListener('keydown', (event) => {
  const target = event.target;
  const inTerm = target && target.closest && target.closest('#term');
  if (inTerm) return;
  const onControl = target && target.closest && target.closest('button, a, input, textarea, [contenteditable]');

  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    moveSelection(event.key === 'ArrowDown' ? 1 : -1);
  } else if (event.key === 'Enter' && !onControl) {
    const inst = selected();
    if (inst) launchInstance(inst);
  } else if (event.key === 'Escape' && state.menuOpen) {
    closeMenu();
  } else if (event.key === 'F5') {
    event.preventDefault();
    refresh();
  }
});

document.addEventListener('click', (event) => {
  if (!state.menuOpen) return;
  if (event.target.closest('#filter-menu') || event.target.closest('#filter-btn')) return;
  closeMenu();
});

$('refresh').addEventListener('click', refresh);
$('add-pack').addEventListener('click', installPack);
$('filter-btn').addEventListener('click', () => (state.menuOpen ? closeMenu() : openMenu()));
$('panel-toggle').addEventListener('click', () => {
  state.panelOpen = !state.panelOpen;
  syncPanel();
  requestAnimationFrame(() => fitTerminal());
});
$('panel-kill').addEventListener('click', killSession);

document.querySelectorAll('[data-icon]').forEach((node) => {
  node.innerHTML = svgIcon(node.dataset.icon);
});

refresh();
