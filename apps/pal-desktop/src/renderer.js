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
  trash: '<path d="M4.8 7.2h14.4M9.6 7.2V5.4a1 1 0 0 1 1-1h2.8a1 1 0 0 1 1 1v1.8"/><path d="M6.6 7.2 7.5 19a1 1 0 0 0 1 .9h7a1 1 0 0 0 1-.9l.9-11.8M10.4 10.8v5.4M13.6 10.8v5.4"/>',
  sliders: '<path d="M5 7.5h14M5 12h14M5 16.5h14"/><circle cx="9" cy="7.5" r="1.6" style="fill:var(--raise)"/><circle cx="15" cy="12" r="1.6" style="fill:var(--raise)"/><circle cx="10.5" cy="16.5" r="1.6" style="fill:var(--raise)"/>',
  x: '<path d="M6.5 6.5 17.5 17.5M17.5 6.5 6.5 17.5"/>',
  arrow: '<path d="M5 12h13M13 6.8 18.2 12 13 17.2"/>',
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

const state = {
  instances: [],
  filter: 'all',
  homeByHarness: {},
  selectedId: null,
  loading: true,
  error: null,
  tab: 'overview', // overview | modes | manage
  menuOpen: false, // 宿主筛选菜单
  rowMenu: null, // { id, x, y, anchor }
  modal: null, // { kind, ... }
  busy: null, // { id, action }
  term: null,
  fit: null,
  session: null, // { id, name, live, exitCode }
  lastDims: '',
  panelOpen: false,
};

/* ---------- 数据 ---------- */
const hostOf = (id) => HOSTS.find((x) => x.id === id) || null;
const hostLabel = (id) => (hostOf(id) ? hostOf(id).label : id);
const hostFull = (id) => (hostOf(id) ? hostOf(id).full : id);
const hostCode = (id) => (hostOf(id) ? hostOf(id).code : String(id).slice(0, 2).toUpperCase());
const packText = (inst) => (inst.pack ? `${inst.pack.name}@${inst.pack.version}` : '');
const selected = () => state.instances.find((x) => x.id === state.selectedId) || null;
const byId = (id) => state.instances.find((x) => x.id === id) || null;
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

/** 每个 harness 只占左栏一行：优先记住的那份 home，否则运行中的，否则第一份。 */
function currentForHost(host) {
  const list = state.instances.filter((x) => x.harness === host);
  if (!list.length) return null;
  const remembered = state.homeByHarness[host];
  return list.find((x) => x.id === remembered) || list.find(isRunning) || list[0];
}

function visible() {
  return HOSTS.map((host) => currentForHost(host.id)).filter(Boolean);
}

function homesOf(host) {
  return state.instances.filter((x) => x.harness === host);
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
    const selectedInst = byId(state.selectedId);
    if (selectedInst) state.homeByHarness[selectedInst.harness] = selectedInst.id;
    render();
  } catch (err) {
    state.loading = false;
    state.error = String((err && err.message) || err);
    render();
  }
}

function render() {
  const installed = visible();
  const rail = document.querySelector('.rail');
  const work = document.querySelector('.work');
  const single = installed.length <= 1;
  if (rail) rail.classList.toggle('hidden', single);
  if (work) work.classList.toggle('no-rail', single);
  renderHarnessSwitch(installed);
  renderRail();
  renderPane();
  renderPanel();
  renderStatus();
}

function renderHarnessSwitch(installed) {
  const select = $('harness-switch');
  if (!select) return;
  select.textContent = '';
  if (!installed.length) {
    select.append(h('option', { value: '', text: '未安装' }));
    select.disabled = true;
    return;
  }
  select.disabled = false;
  for (const inst of installed) {
    select.append(h('option', {
      value: inst.id,
      selected: inst.id === state.selectedId,
      text: `${hostLabel(inst.harness)} · ${inst.name}`,
    }));
  }
}

/* ---------- 左栏：导航层 ---------- */
function renderRail() {
  if (state.rowMenu) closeRowMenu({ restore: false });

  const list = visible();
  $('count').textContent = state.error ? '—' : String(list.length);
  $('filter-label').textContent = '按宿主';
  const showEmpty = !list.length && !state.loading && state.instances.length === 0;
  $('empty').classList.toggle('hidden', !showEmpty);
  $('home-list').classList.toggle('hidden', list.length === 0 && !state.loading);

  const box = $('home-list');
  box.textContent = '';

  if (state.loading && !state.instances.length) {
    for (let i = 0; i < 5; i += 1) {
      box.append(h('div', { class: 'sk-row pulse' },
        h('div', { class: 'sk-tile' }),
        h('div', { class: 'sk-bar' })));
    }
    return;
  }

  for (const inst of list) box.append(railRow(inst));

  const active = box.querySelector('.row.sel');
  if (active) active.scrollIntoView({ block: 'nearest' });
}

function groupHead(label, count) {
  return h('div', { class: 'group-h' },
    h('span', { text: label }),
    h('span', { class: 'gh-n', text: String(count) }));
}

function railRow(inst) {
  if (inst.empty) {
    return h('div', {
      class: 'row empty',
      role: 'option',
      'aria-selected': 'false',
      tabindex: '-1',
      'data-id': inst.id,
      title: `${hostFull(inst.harness)} · 未安装`,
      onclick: () => { state.emptyHost = inst.harness; state.selectedId = null; render(); },
      ondblclick: () => { state.emptyHost = inst.harness; openInstall(); },
    },
    h('span', { class: `tile hm-${inst.harness}`, text: hostCode(inst.harness) }),
    h('span', { class: 'r-name' },
      h('span', { class: 'r-host', text: hostLabel(inst.harness) }),
      h('span', { class: 'r-pack', text: '未安装' })),
    h('span', { class: 'r-end' }, h('span', { class: 'r-dot idle' })));
  }
  const status = statusOf(inst);
  const sel = inst.id === state.selectedId;
  const running = isRunning(inst);
  const broken = isBroken(inst);
  const attention = running || broken;
  const title = `${hostFull(inst.harness)} · ${packText(inst) || '未挂钩整合包'} · ${status.text}`;

  const row = h('div', {
    class: 'row' + (sel ? ' sel' : ''),
    role: 'option',
    'aria-selected': sel ? 'true' : 'false',
    tabindex: sel ? '0' : '-1',
    'data-id': inst.id,
    title,
    onclick: () => selectInstance(inst.id),
    ondblclick: () => launchInstance(inst),
  },
  h('span', { class: `tile hm-${inst.harness}`, text: hostCode(inst.harness) }),
  h('span', { class: 'r-name' },
    h('span', { class: 'r-host', text: hostLabel(inst.harness) }),
    h('span', { class: 'r-pack', text: inst.name })),
  h('span', { class: 'r-end' },
    h('span', { class: status.key === 'idle' ? 'r-dot idle' : `r-dot ${status.key}` }),
    h('span', { class: 'r-acts' },
      h('button', {
        class: 'ract', type: 'button', tabindex: '-1',
        title: attention ? '停止' : '启动', 'aria-label': attention ? '停止' : '启动',
        onclick: (event) => {
          event.stopPropagation();
          if (attention) stopInstance(inst); else launchInstance(inst);
        },
      }, h('span', { class: 'ico', html: svgIcon(attention ? 'stop' : 'play') })),
      h('button', {
        class: 'ract ract-more', type: 'button', tabindex: '-1',
        title: '更多动作', 'aria-label': '更多动作', 'aria-haspopup': 'menu',
        onclick: (event) => {
          event.stopPropagation();
          openRowMenu(inst.id, event.currentTarget);
        },
      }, h('span', { class: 'ico dots', html: svgIcon('more') })))));

  row.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      event.stopPropagation();
      launchInstance(inst);
    } else if (event.key === 'ArrowRight') {
      event.preventDefault();
      event.stopPropagation();
      openRowMenu(inst.id, row.querySelector('.ract-more'));
    }
  });
  return row;
}

function selectInstance(id) {
  const inst = byId(id);
  if (!inst) return;
  state.emptyHost = null;
  state.homeByHarness[inst.harness] = id;
  if (state.selectedId === id) return;
  state.selectedId = id;
  render();
}

function selectHome(host, id) {
  state.homeByHarness[host] = id;
  state.selectedId = id;
  render();
}

/* ---------- 右栏：详情层 ---------- */
function renderPane() {
  const head = $('pane-head');
  const tabs = $('tabs');
  const body = $('pane-body');
  head.textContent = '';
  tabs.textContent = '';
  body.textContent = '';
  body.dataset.tab = state.tab;
  const inst = selected();

  if (state.loading && !state.instances.length) {
    head.classList.add('hidden');
    tabs.classList.add('hidden');
    body.append(h('div', { class: 'sk-block pulse' }));
    return;
  }

  if (state.error) {
    head.classList.add('hidden');
    tabs.classList.add('hidden');
    body.append(h('div', { class: 'err' },
      h('h4', { text: '读不到实例列表' }),
      h('pre', { text: state.error }),
      h('button', { class: 'btn outline', type: 'button', onclick: refresh }, '重试')));
    return;
  }

  if (!inst) {
    head.classList.add('hidden');
    tabs.classList.add('hidden');
    body.append(emptyPane(state.emptyHost));
    return;
  }

  head.classList.remove('hidden');
  tabs.classList.remove('hidden');
  renderHead(head, inst);
  renderTabs(tabs, inst);
  renderTabBody(body, inst);
}

function emptyPane(pickedHost) {
  const host = pickedHost || state.emptyHost || (state.filter !== 'all' ? state.filter : 'dsh');
  return h('div', { class: 'pane-empty' },
    h('p', { class: 'pe-title', text: `${hostLabel(host)} 还没有整合包` }),
    h('p', {
      class: 'pe-body',
      text: '给这个 harness 装一个包：选一个 Pack 目录，PAL 会为它建一个 home。装好之后，这里就是它的启动面板。',
    }),
    h('div', { class: 'pe-actions' },
      h('button', { class: 'btn ink', type: 'button', onclick: () => openInstall(host) },
        h('span', { class: 'ico', html: svgIcon('folder-plus') }), '添加整合包')),
    h('pre', { class: 'pe-cli', text: `$ pal install <pack 目录> --host ${host}` }));
}

function renderHead(head, inst) {
  const status = statusOf(inst);
  const running = isRunning(inst);
  const broken = isBroken(inst);
  const homes = homesOf(inst.harness);

  const eyebrow = h('div', { class: 'eyebrow' },
    h('span', { class: `tile ph-tile hm-${inst.harness}`, text: hostCode(inst.harness) }),
    h('span', { class: 'ph-host', text: inst.name }));

  const subline = h('div', { class: 'subline' },
    h('span', { class: 'mono', text: packText(inst) || '未挂钩整合包' }),
    h('span', { class: 'sep' }),
    h('span', { class: `pill ${status.key === 'idle' ? '' : status.key}` },
      status.key === 'idle' ? null : h('span', { class: `dot ${status.key}` }),
      status.text));

  const picker = h('div', { class: 'pack-pick' },
    h('span', { class: 'pack-pick-label', text: '整合包' }),
    homes.length > 1
      ? h('select', {
          class: 'pack-select',
          'aria-label': '切换整合包',
          onchange: (event) => selectHome(inst.harness, event.target.value),
        }, homes.map((home) => h('option', {
          value: home.id,
          selected: home.id === inst.id,
          text: `${home.name}${isRunning(home) ? ' · 运行中' : ''}`,
        })))
      : h('span', { class: 'pack-current', text: inst.name }),
    h('button', { class: 'link-btn', type: 'button', onclick: openInstall }, '+ 安装'));

  head.append(h('div', { class: 'ph-main' },
    eyebrow,
    h('h1', { class: 'inst-name', text: hostLabel(inst.harness), title: hostFull(inst.harness) }),
    subline,
    picker));

  const act = h('div', { class: 'ph-act' });
  act.append(primaryButton(inst));

  const note = headNote(inst, running, broken);
  if (note) act.append(h('div', { class: 'ph-note' + (broken ? ' bad' : ''), text: note }));
  head.append(act);
}

function headNote(inst, running, broken) {
  if (broken) return '记录还停在 running，pid 已经不在了';
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

const TABS = [
  { id: 'overview', label: '概览' },
  { id: 'modes', label: '启动方式' },
  { id: 'manage', label: '管理' },
];

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
  renderPane();
}

/** 每一屏底部的句号：发丝线 + 这一屏动作的命令行等价。 */
function tabFoot(cmd) {
  return h('footer', { class: 'tab-foot' },
    h('span', { class: 'tf-k', text: '命令行等价' }),
    h('code', { class: 'tf-c', text: cmd }));
}

function renderTabBody(body, inst) {
  if (state.tab === 'modes') body.append(modesBody(inst));
  else if (state.tab === 'manage') body.append(manageBody(inst));
  else body.append(overviewBody(inst));
}

/* ---------- 概览 ---------- */
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
    next,
    tabFoot(running || broken
      ? `$ pal stop ${inst.name}`
      : `$ pal start ${inst.name} --mode ${(defaultMode(inst) || {}).id || 'web'}`));
}

function launchHint(inst, mode, running, broken) {
  if (broken) return '先停止清记录';
  if (running) return inst.url ? '服务在跑，用「打开页面」进界面' : '进程在跑，先停止再换模式';
  if (!mode) return '这个宿主没有声明启动模式';
  if (mode.available === false) return '这个模式在当前 home 上不可用';
  if (mode.kind === 'foreground') return '启动会在下面终端里开一个前台会话';
  if (mode.kind === 'server') return '启动后起本地服务，并自动用浏览器打开';
  if (mode.kind === 'app') return '启动会拉起宿主的桌面窗口';
  return '';
}

function factRows(inst) {
  const rows = [['路径', inst.root || '—', !inst.root]];
  if (inst.home && inst.home !== inst.root) rows.push(['Home', inst.home, false]);
  if (inst.profile) rows.push(['Profile', inst.profile, false]);
  // 形态决定「删除」会删掉什么，值得在概览里就让人看见。
  rows.push(['形态', inst.attached
    ? 'attached home · 装在宿主自己的目录'
    : inst.managed === false
      ? '接管目录 · 不归 PAL 整根管'
      : '托管 home · PAL 数据目录下', false]);
  if (inst.harnessVersion) rows.push(['宿主版本', String(inst.harnessVersion), false]);
  if (inst.createdAt) rows.push(['建于', dateText(inst.createdAt), false]);
  // 实例 ID 不在这里重复：它在「管理」里，旁边就有复制。
  return rows;
}

function dateText(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/* ---------- 启动方式 ---------- */
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
      // 右侧说的必须是「这个模式」的状态，不是实例状态：运行中时它没在跑，只是还不能切。
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
      h('div', { class: 'mode-item' }, h('div', { class: 'mode-note', text: '这个宿主没有声明启动模式' })));

  return h('div', { class: 'mb' },
    h('p', { class: 'sec-lead', text: lead }),
    list,
    tabFoot(`$ pal start ${inst.name} --list-modes`));
}

/* ---------- 管理 ---------- */
function manageBody(inst) {
  const running = isRunning(inst);
  const broken = isBroken(inst);
  const blocked = running || broken;
  const busy = state.busy && state.busy.id === inst.id;
  const attached = inst.attached === true;

  const row = (title, desc, buttons) => h('div', { class: 'mg-row' },
    h('div', { class: 'mgr-main' },
      h('span', { class: 'mgr-t', text: title }),
      h('span', { class: 'mgr-s', text: desc })),
    h('div', { class: 'mgr-act' }, buttons));

  const btn = (label, opts = {}) => h('button', {
    class: 'btn outline' + (opts.danger ? ' danger' : ''),
    type: 'button',
    disabled: opts.disabled || false,
    title: opts.title || null,
    onclick: opts.onclick,
  }, label);

  return h('div', { class: 'mg' },
    h('section', { class: 'mg-group' },
      h('h3', { class: 'mg-h', text: '整合包' }),
      row('更新到最新版', blocked ? '先停止实例，才能换版本' : '从 registry 拉最新版覆盖当前安装；本地改过的文件会拦住更新',
        btn('更新', { disabled: blocked || busy, onclick: () => confirmAction('update', inst) })),
      row('卸载整合包',
        blocked ? '先停止实例，才能卸包' : '摘掉包写进这个 home 的文件，实例记录与目录保留，可以重新装',
        btn('卸载', { disabled: blocked || busy, onclick: () => confirmAction('uninstall', inst) }))),

    h('section', { class: 'mg-group' },
      h('h3', { class: 'mg-h', text: '位置' }),
      row('打开所在文件夹', inst.root || '这个实例没有记录路径',
        h('div', { class: 'mgr-act' },
          btn('打开', { disabled: !inst.root, onclick: () => reveal(inst) }),
          btn('复制路径', { disabled: !inst.root, onclick: () => copyText(inst.root, '路径已复制') }))),
      row('实例 ID', inst.id,
        btn('复制', { onclick: () => copyText(inst.id, '实例 ID 已复制') }))),

    h('section', { class: 'mg-group danger' },
      h('h3', { class: 'mg-h', text: '危险操作' }),
      row(`删除这个实例${attached ? '（只摘记录）' : ''}`,
        attached
          ? 'attached home：只删 PAL 的记录，目录与用户文件留在原处'
          : '删除前会先停进程，整个 home 目录（含会话与凭据）一起删掉，不可恢复',
        btn('删除…', { danger: true, disabled: busy, onclick: () => confirmAction('remove', inst) }))),
    tabFoot(`$ pal update --home ${inst.name}`));
}

/* ---------- 终端面板 ---------- */
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
  const inst = selected();
  const mode = panelModeOf(inst);
  const open = Boolean(state.session) || state.panelOpen;
  bar.textContent = '';

  panel.className = 'panel'
    + (mode === 'hidden' ? ' hidden' : '')
    + (mode === 'note' ? ' note-mode' : '')
    + (mode === 'term' && !open ? ' collapsed' : '');

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
    idle.append(h('span', { class: 'ln cmd', text: '选一个实例' }));
    return;
  }
  const fg = foregroundMode(inst);
  if (isRunning(inst) || isBroken(inst)) {
    idle.append(
      h('span', { class: 'ln', text: isBroken(inst)
        ? '记录停在 running，进程已经不在了。'
        : '服务进程在跑：它的输出去宿主自己的日志里看。' }),
      h('span', { class: 'ln', text: '要开前台终端，先在这里停止它。' }));
    return;
  }
  if (!fg) {
    idle.append(h('span', { class: 'ln', text: '这个宿主只声明了服务类模式，没有可交互的前台会话。' }));
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

/* ---------- 状态栏 ---------- */
function renderStatus() {
  const total = visible().length;
  const live = state.instances.filter(isRunning).length;
  const box = $('sb-count');
  box.textContent = '';
  box.append(h('b', { text: String(total) }), ' 个 harness');
  if (live) box.append(' · ', h('b', { text: String(live) }), ' 个运行中');

  const filterBox = $('sb-filter');
  filterBox.textContent = '按 harness 分组';
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
  try {
    const res = await window.pal.reveal(inst.root);
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

/* ---------- 宿主筛选菜单 ---------- */
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
      onclick: () => {
        state.filter = item.id;
        closeMenu();
        render();
        $('filter-btn').focus();
      },
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
  const first = $('filter-menu').querySelector('.menu-item');
  if (first) first.focus();
}

function closeMenu() {
  state.menuOpen = false;
  $('filter-menu').classList.add('hidden');
  $('filter-btn').setAttribute('aria-expanded', 'false');
}

/* ---------- 实例行菜单 ---------- */
function openRowMenu(id, anchor) {
  if (state.selectedId !== id) {
    state.selectedId = id;
    render();
  }
  const row = document.querySelector(`.row[data-id="${CSS.escape(id)}"]`);
  const bar = row ? row.querySelector('.ract-more') : anchor;
  if (!bar) return;
  const rect = bar.getBoundingClientRect();
  state.rowMenu = { id, rect, anchor: bar };
  renderRowMenu();
  const first = $('popover').querySelector('.pm-item');
  if (first) first.focus();
}

function rowMenuItems(inst) {
  const running = isRunning(inst);
  const broken = isBroken(inst);
  const items = [];
  items.push(running || broken
    ? { label: '停止', icon: 'stop', run: () => stopInstance(inst) }
    : { label: '启动', icon: 'play', run: () => launchInstance(inst) });
  if (inst.url) items.push({ label: '打开页面', icon: 'external', run: () => openExternal(inst.url) });
  items.push({ label: '打开「管理」', icon: 'sliders', run: () => selectTab('manage') });
  items.push({ sep: true });
  if (inst.root) {
    items.push({ label: '打开所在文件夹', icon: 'folder', run: () => reveal(inst) });
    items.push({ label: '复制路径', icon: 'copy', run: () => copyText(inst.root, '路径已复制') });
  }
  return items;
}

function renderRowMenu() {
  const box = $('popover');
  const menu = state.rowMenu;
  if (!menu) { box.classList.add('hidden'); box.textContent = ''; return; }
  const inst = byId(menu.id);
  if (!inst) { closeRowMenu({ restore: false }); return; }

  box.textContent = '';
  box.classList.remove('hidden');
  for (const item of rowMenuItems(inst)) {
    if (item.sep) { box.append(h('div', { class: 'pm-sep' })); continue; }
    box.append(h('button', {
      class: 'pm-item', type: 'button', role: 'menuitem',
      onclick: () => {
        closeRowMenu({ restore: true });
        item.run();
      },
    },
    h('span', { class: 'ico', html: svgIcon(item.icon) }),
    h('span', { class: 'pm-label', text: item.label })));
  }

  // 贴着 ⋯ 往列表右侧展开，被操作的那一行保持可见；右边放不下才翻到上方 / 左侧
  const width = box.offsetWidth || 186;
  const height = box.offsetHeight || 160;
  const rect = menu.rect;
  const railRight = document.querySelector('.rail')?.getBoundingClientRect().right ?? rect.right;
  let x = railRight + 6;
  let y = rect.bottom + 5;
  if (x + width > window.innerWidth - 10) x = Math.max(8, rect.right - width);
  if (y + height > window.innerHeight - 10) y = Math.max(10, rect.top - height - 5);
  x = Math.min(Math.max(8, x), window.innerWidth - width - 8);
  box.style.left = `${Math.round(x)}px`;
  box.style.top = `${Math.round(y)}px`;
}

function closeRowMenu(opts = {}) {
  const menu = state.rowMenu;
  state.rowMenu = null;
  $('popover').classList.add('hidden');
  $('popover').textContent = '';
  if (opts.restore && menu) {
    const row = document.querySelector(`.row[data-id="${CSS.escape(menu.id)}"]`);
    const bar = row ? row.querySelector('.ract-more') : menu.anchor;
    if (bar && bar.isConnected) bar.focus();
  }
}

/* ---------- 弹层：通用外壳 ---------- */
function openModal(spec) {
  state.modal = { returnFocus: document.activeElement, ...spec };
  renderModal();
  // 焦点落在 dialog 容器上：不压任何按钮，Tab 之后再进控件。
  const box = $('modal-root').querySelector('.modal');
  if (box) box.focus();
}

function closeModal() {
  const modal = state.modal;
  state.modal = null;
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
  // 重渲染后原来的按钮没了：焦点落回弹层本身，别丢到 body 上。
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

/* ---------- 弹层：添加整合包 ---------- */
function openInstall(pickedHost) {
  const current = selected();
  const host = pickedHost || state.emptyHost || (current ? current.harness : 'dsh');
  state.install = {
    step: 1, host, dir: null, preview: null, name: null, done: false, busy: false, error: null, raw: '',
  };
  openModal({ kind: 'install', title: '添加整合包' });
}

function stepsBar(step) {
  const labels = ['选宿主', '选目录', '确认'];
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
            h('p', { class: 'fin-s', text: `宿主 ${host ? host.full : ins.host}；实例已出现在左边，可以直接启动。` })))
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
    modalShell({ title: '添加整合包', sub: ins.done ? '完成' : '失败', body, foot, busy: ins.busy });
    return;
  }

  if (ins.step === 1) {
    body = h('div', { class: 'pickwrap' },
      stepsBar(1),
      h('p', { class: 'lead', text: '装进哪个宿主的 home？默认跟着当前筛选 / 选中实例走。' }),
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
          h('span', { class: 'pick-s', text: count ? `${count} 个实例` : '还没有实例' })),
        h('span', { class: 'pick-check', html: ins.host === item.id ? svgIcon('check') : '' }));
      })),
      h('p', { class: 'hint', text: '托管 home 建在 PAL 数据目录下；attached 宿主也可以随后在命令行用 --home 装进它自己的目录。' }));
    foot = [
      h('button', { class: 'btn', type: 'button', onclick: () => closeModal() }, '取消'),
      h('button', {
        class: 'btn ink', type: 'button',
        onclick: () => { ins.step = 2; renderModal(); },
      }, '下一步'),
    ];
  } else if (ins.step === 2) {
    body = h('div', { class: 'pickwrap' },
      stepsBar(2),
      h('p', { class: 'lead', text: `选一个 Pack 目录，PAL 会把它装进 ${host ? host.full : ins.host}。` }),
      h('div', { class: 'dirpick' },
        h('code', { class: 'dirpath' + (ins.dir ? '' : ' empty'), text: ins.dir || '还没有选目录' }),
        h('button', {
          class: 'btn outline', type: 'button',
          onclick: () => pickDirectory(),
        }, h('span', { class: 'ico', html: svgIcon('folder') }), '选择目录…')),
      h('p', { class: 'hint', text: '目录里要有 pack 清单（packhub.yml）；下一步会先算一遍安装计划，不落盘。' }));
    foot = [
      h('button', { class: 'btn outline', type: 'button', onclick: () => { ins.step = 1; renderModal(); } },
        h('span', { class: 'ico', html: svgIcon('chevron-left') }), '返回'),
      h('button', {
        class: 'btn ink', type: 'button', disabled: !ins.dir,
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
    title: '添加整合包',
    sub: `${ins.step < 4 ? `第 ${Math.min(ins.step, 3)} 步，共 3 步` : ''}`,
    body,
    foot,
    busy: ins.busy,
  });
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
    if (ins.name) {
      const fresh = state.instances.find((x) => x.name === ins.name);
      if (fresh) { state.selectedId = fresh.id; render(); }
    }
    toast(ins.name ? `已装好 ${ins.name}` : '安装完成');
  } catch (err) {
    ins.busy = false;
    ins.step = 4;
    ins.done = false;
    ins.error = String((err && err.message) || err);
    renderModal();
  }
}

/* ---------- 弹层：危险操作确认 ---------- */
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
    closeModal();
    toast(`${spec.inst.name} · ${label}完成`);
    await refresh();
  } catch (err) {
    spec.busy = false;
    spec.error = String((err && err.message) || err);
    if (state.modal) renderConfirmModal();
  }
}

/* ---------- 弹层：关于 ---------- */
function renderAboutModal() {
  const keys = [
    ['↑ ↓', '在实例列表里移动选择'],
    ['↵', '启动选中的实例'],
    ['→', '在选中行上打开动作菜单'],
    ['F5', '重新读取实例列表'],
    ['Esc', '关闭菜单 / 弹层'],
  ];
  const body = h('div', { class: 'about' },
    h('p', { class: 'lead', text: 'PAL 是本地实例启动器：每个整合包装进一个 home，左边是实例，右边是这一份实例的详情。' }),
    h('div', { class: 'kb-table' }, keys.map(([k, v]) => h('div', { class: 'kb-row' },
      h('kbd', { text: k }),
      h('span', { text: v })))),
    h('p', { class: 'hint', text: '终端里的输出只属于当前会话；关掉 PAL 不会停掉已经在后台跑的服务，用「停止」显式收回。' }));

  modalShell({
    title: '关于与快捷键',
    body,
    foot: [h('button', { class: 'btn ink', type: 'button', onclick: () => closeModal() }, '知道了')],
  });
}

/* ---------- 键盘 ---------- */
function focusRow(id) {
  const row = document.querySelector(`.row[data-id="${CSS.escape(id)}"]`);
  if (row) row.focus({ preventScroll: true });
}

function moveSelection(delta) {
  const list = visible();
  if (!list.length) return;
  const index = list.findIndex((x) => x.id === state.selectedId);
  const next = Math.min(list.length - 1, Math.max(0, (index < 0 ? 0 : index) + delta));
  state.selectedId = list[next].id;
  render();
  focusRow(state.selectedId);
}

function trapFocus(event) {
  const root = $('modal-root');
  const focusables = Array.from(root.querySelectorAll('button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'))
    .filter((el) => el.offsetParent !== null);
  if (!focusables.length) return;
  const first = focusables[0];
  const last = focusables[focusables.length - 1];
  const active = document.activeElement;
  // 焦点在 dialog 容器上（刚打开 / 刚重渲染）时，Tab 必须进第一个控件，Shift+Tab 进最后一个。
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

function moveMenuFocus(delta) {
  const items = Array.from($('popover').querySelectorAll('.pm-item'));
  if (!items.length) return;
  const index = items.indexOf(document.activeElement);
  const next = (index + delta + items.length) % items.length;
  items[index < 0 ? 0 : next].focus();
}

document.addEventListener('keydown', (event) => {
  const target = event.target;
  const inTerm = target && target.closest && target.closest('#term');

  if (state.modal) {
    if (event.key === 'Escape') { event.preventDefault(); closeModal(); return; }
    if (event.key === 'Tab') { trapFocus(event); return; }
    return;
  }

  if (inTerm) return;

  if (state.rowMenu) {
    if (event.key === 'Escape') { event.preventDefault(); closeRowMenu({ restore: true }); return; }
    if (event.key === 'ArrowDown') { event.preventDefault(); moveMenuFocus(1); return; }
    if (event.key === 'ArrowUp') { event.preventDefault(); moveMenuFocus(-1); return; }
  }

  if (event.key === 'Escape') {
    if (state.menuOpen) { closeMenu(); $('filter-btn').focus(); }
    return;
  }
  if (event.key === 'F5') {
    event.preventDefault();
    refresh();
    return;
  }
  if (state.menuOpen) {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const items = Array.from($('filter-menu').querySelectorAll('.menu-item'));
      const index = items.indexOf(document.activeElement);
      const next = (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
      items[index < 0 ? 0 : next].focus();
    }
    return;
  }

  const onControl = target && target.closest && target.closest('button, a, input, textarea, [contenteditable]');

  if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
    // tablist 的标准行为：← → 在屏之间移动，焦点跟着走。
    const tab = target && target.closest && target.closest('.tab');
    if (tab) {
      event.preventDefault();
      const ids = TABS.map((item) => item.id);
      const index = ids.indexOf(state.tab);
      const next = (index + (event.key === 'ArrowRight' ? 1 : -1) + ids.length) % ids.length;
      selectTab(ids[next]);
      const btn = document.querySelector(`.tab[data-tab="${ids[next]}"]`);
      if (btn) btn.focus();
      return;
    }
  }

  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    moveSelection(event.key === 'ArrowDown' ? 1 : -1);
  } else if (event.key === 'ArrowRight' && target && target.closest && target.closest('.row')) {
    event.preventDefault();
    const inst = selected();
    if (inst) openRowMenu(inst.id, document.querySelector(`.row[data-id="${CSS.escape(inst.id)}"] .ract-more`));
  } else if (event.key === 'Enter' && !onControl) {
    const inst = selected();
    if (inst) launchInstance(inst);
  }
});

document.addEventListener('click', (event) => {
  if (state.menuOpen) {
    if (event.target.closest('#filter-menu') || event.target.closest('#filter-btn')) { /* 自己 */ }
    else { closeMenu(); }
  }
  if (state.rowMenu) {
    if (event.target.closest('#popover') || event.target.closest('.ract-more')) { /* 自己 */ }
    else { closeRowMenu({ restore: false }); }
  }
});

/* ---------- 绑定 ---------- */
$('refresh').addEventListener('click', refresh);
$('add-pack').addEventListener('click', openInstall);
$('about').addEventListener('click', () => openModal({ kind: 'about', title: '关于与快捷键' }));
$('harness-switch').addEventListener('change', (event) => {
  const inst = byId(event.target.value);
  if (!inst) return;
  state.emptyHost = null;
  state.homeByHarness[inst.harness] = inst.id;
  state.selectedId = inst.id;
  render();
});
$('filter-btn').addEventListener('click', () => (state.menuOpen ? closeMenu() : openMenu()));

document.querySelectorAll('[data-icon]').forEach((node) => {
  node.innerHTML = svgIcon(node.dataset.icon);
});

window.addEventListener('resize', () => {
  if (state.rowMenu) renderRowMenu();
});

refresh();
