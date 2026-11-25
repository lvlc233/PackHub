// `pal ui` 的单页 HTML：内联 CSS/JS，不引 CDN、不用框架，动态内容一律 textContent / 属性赋值。
//
// 页面分三个 tab（Homes / 安装 / 活动）。安装与管理动作不在这里实现：表单只拼 POST body，
// 真正的安装 / 更新 / 回滚 / 卸载 / 删除 / 体检都由服务端 spawn 同一条 pal 命令（见 uiSpawn.ts）。
export const PAGE_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>PAL 启动器</title>
<style>
:root { color-scheme: light; }
* { box-sizing: border-box; }
body { margin: 0; font: 14px/1.5 system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif; background: #f5f6f8; color: #1f2328; }
body.busy { cursor: progress; }
body.busy button { opacity: .55; }
header { position: sticky; top: 0; z-index: 6; display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 12px; padding: 12px 20px; background: #fff; border-bottom: 1px solid #e3e6ea; }
.brand { display: flex; align-items: center; gap: 18px; flex-wrap: wrap; }
h1 { margin: 0; font-size: 18px; }
.tabs { display: flex; gap: 4px; }
.tab { font: inherit; border: 1px solid transparent; background: transparent; color: #57606a; border-radius: 6px; padding: 4px 12px; cursor: pointer; }
.tab:hover { background: #eef1f4; }
.tab.active { background: #eaeef2; color: #1f2328; border-color: #d0d7de; font-weight: 600; }
.toolbar { display: flex; align-items: center; gap: 12px; color: #57606a; }
button { font: inherit; border: 1px solid #d0d7de; background: #f6f8fa; color: #1f2328; border-radius: 6px; padding: 5px 10px; cursor: pointer; }
button:hover:not(:disabled) { background: #eef1f4; }
button:disabled { opacity: .5; cursor: not-allowed; }
button.primary { background: #1f6feb; border-color: #1f6feb; color: #fff; }
button.primary:hover:not(:disabled) { background: #1a5fd0; }
button.danger { color: #cf222e; border-color: #ffcecb; background: #fff5f5; }
button.ghost { background: transparent; border-color: transparent; color: #57606a; }
.busybar { position: sticky; top: 0; z-index: 5; padding: 4px 20px; font-size: 12px; background: #fff8c5; border-bottom: 1px solid #e6d27a; color: #6b5900; }
.errorbar { display: flex; gap: 10px; align-items: flex-start; padding: 8px 20px; background: #ffebe9; border-bottom: 1px solid #ffcecb; color: #a40e26; font-size: 13px; }
.errorbar span { flex: 1; white-space: pre-wrap; overflow-wrap: anywhere; }
.errorbar button { border-color: #ffcecb; background: #fff5f5; color: #a40e26; padding: 1px 8px; }
.panel { padding: 18px 20px 60px; }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(370px, 1fr)); gap: 14px; }
.card { background: #fff; border: 1px solid #e3e6ea; border-radius: 10px; padding: 14px 16px; }
.card-head { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.name { margin: 0; font-size: 15px; font-weight: 600; word-break: break-all; }
.host, .pack { color: #57606a; font-size: 12px; }
.badges { margin-left: auto; display: flex; flex-wrap: wrap; gap: 6px; }
.badge { font-size: 12px; padding: 1px 7px; border-radius: 999px; background: #eef1f4; color: #57606a; }
.badge.run { background: #dafbe1; color: #1a7f37; }
.badge.attached { background: #ddf4ff; color: #0969da; }
.badge.managed { background: #f6f8fa; color: #57606a; border: 1px solid #e3e6ea; }
.badge.health.idle { cursor: pointer; }
.badge.health.ok { background: #dafbe1; color: #1a7f37; }
.badge.health.warn { background: #fff8c5; color: #7d4e00; }
.badge.health.fail { background: #ffebe9; color: #a40e26; }
.actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-top: 12px; }
.meta { margin-top: 10px; color: #57606a; font-size: 12px; display: flex; flex-wrap: wrap; gap: 10px; align-items: center; }
.meta button { padding: 3px 9px; font-size: 12px; }
.open { color: #0969da; }
.empty { grid-column: 1 / -1; background: #fff; border: 1px dashed #d0d7de; border-radius: 10px; padding: 28px; text-align: center; }
.empty p { margin: 6px 0; }
.hint { color: #57606a; font-size: 13px; }
.bad-text { color: #a40e26; }
.toast { position: fixed; left: 50%; bottom: 24px; transform: translateX(-50%); background: #1f2328; color: #fff; padding: 8px 14px; border-radius: 8px; max-width: 80vw; z-index: 30; }
.toast.bad { background: #cf222e; }
.panel-head { max-width: 900px; }
.panel-head h2 { margin: 0 0 4px; font-size: 16px; }
.form { background: #fff; border: 1px solid #e3e6ea; border-radius: 10px; padding: 16px; max-width: 900px; display: grid; gap: 10px; margin-top: 12px; }
.row { display: grid; grid-template-columns: 140px 1fr; gap: 12px; align-items: center; }
.row label { color: #57606a; font-size: 13px; }
input[type="text"], select { font: inherit; padding: 6px 8px; border: 1px solid #d0d7de; border-radius: 6px; background: #fff; color: #1f2328; width: 100%; }
.actions-row .actions { margin-top: 0; }
.result { margin-top: 14px; background: #fff; border: 1px solid #e3e6ea; border-radius: 10px; padding: 14px 16px; max-width: 900px; }
.result h3 { margin: 0 0 8px; font-size: 14px; }
.plan-name { margin: 4px 0 8px; font-size: 13px; }
.plan-actions, .plan-issues { margin: 6px 0; padding-left: 20px; font: 12px/1.6 ui-monospace, SFMono-Regular, Consolas, monospace; overflow-wrap: anywhere; }
.output { margin: 10px 0 0; padding: 10px 12px; background: #fafbfc; border: 1px solid #e3e6ea; border-radius: 8px; font: 12px/1.55 ui-monospace, SFMono-Regular, Consolas, monospace; white-space: pre-wrap; overflow-wrap: anywhere; max-height: 46vh; overflow: auto; }
.output.bad { color: #a40e26; background: #fff5f5; border-color: #ffcecb; }
.activity { list-style: none; margin: 12px 0 0; padding: 0; display: grid; gap: 6px; max-width: 900px; }
.act { background: #fff; border: 1px solid #e3e6ea; border-radius: 8px; padding: 8px 10px; display: flex; flex-wrap: wrap; gap: 10px; font-size: 13px; }
.act.bad { border-color: #ffcecb; }
.act-time { color: #57606a; font-family: ui-monospace, SFMono-Regular, Consolas, monospace; }
.act-action { font-weight: 600; }
.act-state.ok { color: #1a7f37; }
.act-state.bad { color: #cf222e; }
.act-detail { flex-basis: 100%; color: #57606a; font-size: 12px; white-space: pre-wrap; overflow-wrap: anywhere; }
.drawer { position: fixed; top: 0; right: 0; bottom: 0; width: min(780px, 94vw); background: #fff; border-left: 1px solid #e3e6ea; box-shadow: -8px 0 24px rgba(0,0,0,.08); z-index: 20; display: flex; flex-direction: column; }
.drawer-head { display: flex; align-items: center; gap: 10px; padding: 12px 14px; border-bottom: 1px solid #e3e6ea; }
.drawer-head h2 { margin: 0; font-size: 14px; }
.drawer-head button { margin-left: auto; }
.drawer-body { flex: 1; overflow: auto; padding: 12px 14px; }
.block { margin-bottom: 18px; }
.block h3 { margin: 0 0 8px; font-size: 13px; color: #57606a; text-transform: none; }
.kv { display: grid; grid-template-columns: 96px 1fr; gap: 4px 12px; margin: 0; font-size: 13px; }
.kv dt { color: #57606a; }
.kv dd { margin: 0; overflow-wrap: anywhere; font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 12px; }
.checks { list-style: none; margin: 0; padding: 0; display: grid; gap: 4px; font-size: 13px; }
.checks li { display: flex; gap: 8px; align-items: baseline; }
.check-tag { font-size: 11px; padding: 0 6px; border-radius: 999px; background: #eef1f4; color: #57606a; }
.check-tag.ok { background: #dafbe1; color: #1a7f37; }
.check-tag.warn { background: #fff8c5; color: #7d4e00; }
.check-tag.fail { background: #ffebe9; color: #a40e26; }
.drawer-output { border-top: 1px solid #e3e6ea; background: #fafbfc; padding: 10px 14px; max-height: 32vh; overflow: auto; }
.drawer-output h3 { margin: 0 0 6px; font-size: 12px; color: #57606a; }
.drawer-output pre { margin: 0; font: 12px/1.55 ui-monospace, SFMono-Regular, Consolas, monospace; white-space: pre-wrap; overflow-wrap: anywhere; }
[hidden] { display: none !important; }
</style>
</head>
<body>
<header>
  <div class="brand">
    <h1>PAL 启动器</h1>
    <nav class="tabs" role="tablist">
      <button type="button" role="tab" class="tab active" id="tab-homes" data-tab="homes" aria-selected="true">Homes</button>
      <button type="button" role="tab" class="tab" id="tab-install" data-tab="install" aria-selected="false">安装</button>
      <button type="button" role="tab" class="tab" id="tab-activity" data-tab="activity" aria-selected="false">活动</button>
    </nav>
  </div>
  <div class="toolbar">
    <label><input type="checkbox" id="auto" checked> 自动刷新（2s）</label>
    <button id="refresh" type="button">刷新</button>
  </div>
</header>
<div id="busy" class="busybar" hidden></div>
<div id="errorbar" class="errorbar" hidden>
  <span id="error-text"></span>
  <button id="error-close" type="button" aria-label="关闭错误">×</button>
</div>
<main id="panel-homes" class="panel">
  <div id="list" class="grid"></div>
</main>
<section id="panel-install" class="panel" hidden>
  <div class="panel-head">
    <h2>安装</h2>
    <p class="hint">表单调的就是 <code>pal install</code>：预览 = <code>--dry-run --json</code>，安装 = 同一条命令去掉 dry-run。参数与用法错都由 CLI 判。</p>
  </div>
  <form id="install-form" class="form" autocomplete="off">
    <div class="row" id="row-source">
      <label for="source">包来源</label>
      <input id="source" type="text" placeholder="本地目录路径 / .phub / registry 名（name 或 name@version）">
    </div>
    <div class="row" id="row-host">
      <label for="host">宿主</label>
      <select id="host"></select>
    </div>
    <div class="row" id="row-target">
      <label for="target">target</label>
      <select id="target">
        <option value="managed">managed（默认，建命名 home）</option>
        <option value="attached">attached（--home，宿主全局目录）</option>
        <option value="project">project（--project，项目目录）</option>
      </select>
    </div>
    <div class="row" id="row-name">
      <label for="name">名字</label>
      <input id="name" type="text" placeholder="不写用 &lt;host&gt;-&lt;packSlug&gt;">
    </div>
    <div class="row" id="row-root">
      <label for="root">--root</label>
      <input id="root" type="text" placeholder="managed 的根目录（可选，绝对路径）">
    </div>
    <div class="row" id="row-home">
      <label for="home">--home</label>
      <input id="home" type="text" placeholder="宿主的全局目录，例如 ~/.config/opencode">
    </div>
    <div class="row" id="row-project">
      <label for="project">--project</label>
      <input id="project" type="text" placeholder="项目目录（不存在会创建）">
    </div>
    <div class="row" id="row-profile">
      <label for="profile">--profile</label>
      <input id="profile" type="text" placeholder="dsh attached 的 profile（不写 = 全部已有）">
    </div>
    <div class="row" id="row-fromHome">
      <label for="fromHome">--from-home</label>
      <input id="fromHome" type="text" placeholder="managed 专用：从该宿主已有全局目录带凭据（可选）">
    </div>
    <div class="row actions-row">
      <span></span>
      <div class="actions">
        <button id="preview" type="button">预览</button>
        <button id="install" type="button" class="primary">安装</button>
      </div>
    </div>
  </form>
  <div id="plan-result" class="result" hidden></div>
  <pre id="install-result" class="output" hidden></pre>
</section>
<section id="panel-activity" class="panel" hidden>
  <div class="panel-head">
    <h2>活动</h2>
    <p class="hint">本页最近的操作（最多 50 条，只存在页面内存里，刷新就没了）。</p>
  </div>
  <ol id="activity-list" class="activity"></ol>
</section>
<aside id="drawer" class="drawer" hidden>
  <div class="drawer-head">
    <h2 id="drawer-title">详情</h2>
    <button id="drawer-close" type="button">关闭</button>
  </div>
  <div id="drawer-body" class="drawer-body"></div>
  <div id="action-output-wrap" class="drawer-output" hidden>
    <h3>输出</h3>
    <pre id="action-output"></pre>
  </div>
</aside>
<div id="toast" class="toast" hidden></div>
<script>
(function () {
  'use strict';

  var MAX_ACTIVITY = 50;
  var POLL_MS = 2000;

  var STATUS = { running: '运行中', stopped: '已停止', installed: '已安装', installing: '安装中', broken: '异常', failed: '失败' };
  var ACTION_LABEL = { update: '更新', rollback: '回滚', verify: '验证', uninstall: '卸载', remove: '删除' };
  var TABS = ['homes', 'install', 'activity'];

  var state = {
    instances: [],
    hosts: [],
    tab: 'homes',
    busy: 0,
    auto: true,
    health: {},
    logs: {},
    activities: [],
    detailId: null,
    detailSig: null,
    timer: null
  };

  function $(id) { return document.getElementById(id); }

  var ui = {
    list: $('list'), toast: $('toast'), busy: $('busy'),
    errorbar: $('errorbar'), errorText: $('error-text'), errorClose: $('error-close'),
    refresh: $('refresh'), auto: $('auto'),
    panelHomes: $('panel-homes'), panelInstall: $('panel-install'), panelActivity: $('panel-activity'),
    tabHomes: $('tab-homes'), tabInstall: $('tab-install'), tabActivity: $('tab-activity'),
    form: $('install-form'), source: $('source'), host: $('host'), target: $('target'),
    name: $('name'), root: $('root'), home: $('home'), project: $('project'),
    profile: $('profile'), fromHome: $('fromHome'),
    preview: $('preview'), install: $('install'),
    planResult: $('plan-result'), installResult: $('install-result'),
    activityList: $('activity-list'),
    drawer: $('drawer'), drawerTitle: $('drawer-title'), drawerBody: $('drawer-body'), drawerClose: $('drawer-close'),
    outputWrap: $('action-output-wrap'), output: $('action-output')
  };

  /* ---------- 基础 ---------- */

  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  function toast(message, bad) {
    ui.toast.textContent = message;
    ui.toast.className = bad ? 'toast bad' : 'toast';
    ui.toast.hidden = false;
    clearTimeout(toast._timer);
    toast._timer = setTimeout(function () { ui.toast.hidden = true; }, 4000);
  }

  function showError(message, output) {
    ui.errorText.textContent = message + (output ? '\\n' + output : '');
    ui.errorbar.hidden = false;
  }

  function clearError() {
    ui.errorText.textContent = '';
    ui.errorbar.hidden = true;
  }

  function tail(text, limit) {
    var max = limit || 1200;
    var value = text === undefined || text === null ? '' : String(text);
    return value.length > max ? '…' + value.slice(-max) : value;
  }

  function api(path, body) {
    var options = {};
    if (body !== undefined) {
      options.method = 'POST';
      options.headers = { 'content-type': 'application/json', 'x-pal-ui': '1' };
      options.body = JSON.stringify(body);
    }
    return fetch(path, options).then(function (res) {
      return res.text().then(function (text) {
        var data = null;
        try { data = text ? JSON.parse(text) : null; } catch (err) { data = null; }
        if (!res.ok) {
          var error = new Error(data && data.error ? data.error : 'HTTP ' + res.status);
          error.data = data;
          throw error;
        }
        return data;
      });
    });
  }

  function copy(text) {
    function done() { toast('已复制：' + text); }
    function failed() { toast('复制失败，请手动选择：' + text, true); }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, failed);
      return;
    }
    var area = document.createElement('textarea');
    area.value = text;
    document.body.appendChild(area);
    area.select();
    try { document.execCommand('copy'); done(); } catch (err) { failed(); }
    document.body.removeChild(area);
  }

  /* ---------- 忙碌 / 错误条 ---------- */

  function beginBusy(message) {
    state.busy += 1;
    ui.busy.textContent = message || '处理中…';
    ui.busy.hidden = false;
    document.body.classList.add('busy');
  }

  function endBusy() {
    state.busy = Math.max(0, state.busy - 1);
    if (state.busy === 0) {
      ui.busy.hidden = true;
      document.body.classList.remove('busy');
    }
  }

  // 长操作期间所有按钮都不响应（含键盘触发）：捕获阶段直接吃掉 click。
  document.addEventListener('click', function (event) {
    if (!state.busy) return;
    var target = event.target;
    var button = target && target.closest ? target.closest('button') : null;
    if (!button) return;
    event.preventDefault();
    event.stopPropagation();
  }, true);

  /* ---------- 活动 ---------- */

  function record(action, target, ok, detail) {
    state.activities.unshift({
      at: new Date(),
      action: action,
      target: target,
      ok: ok,
      detail: detail || ''
    });
    if (state.activities.length > MAX_ACTIVITY) state.activities.length = MAX_ACTIVITY;
    renderActivity();
  }

  function renderActivity() {
    clear(ui.activityList);
    if (!state.activities.length) {
      ui.activityList.appendChild(el('li', 'hint', '还没有操作记录：启动、安装、更新、体检这些动作会记在这里。'));
      return;
    }
    for (var i = 0; i < state.activities.length; i += 1) {
      var item = state.activities[i];
      var row = el('li', item.ok ? 'act' : 'act bad');
      row.appendChild(el('span', 'act-time', item.at.toLocaleTimeString()));
      row.appendChild(el('span', 'act-action', item.action));
      row.appendChild(el('span', 'act-target', item.target));
      row.appendChild(el('span', 'act-state ' + (item.ok ? 'ok' : 'bad'), item.ok ? '成功' : '失败'));
      if (item.detail) row.appendChild(el('div', 'act-detail', item.detail));
      ui.activityList.appendChild(row);
    }
  }

  /* ---------- tab ---------- */

  function setTab(tab) {
    state.tab = tab;
    for (var i = 0; i < TABS.length; i += 1) {
      var name = TABS[i];
      var panel = name === 'homes' ? ui.panelHomes : name === 'install' ? ui.panelInstall : ui.panelActivity;
      var button = name === 'homes' ? ui.tabHomes : name === 'install' ? ui.tabInstall : ui.tabActivity;
      var active = name === tab;
      panel.hidden = !active;
      button.className = active ? 'tab active' : 'tab';
      button.setAttribute('aria-selected', active ? 'true' : 'false');
    }
    if (tab === 'homes') load();
    if (tab === 'activity') renderActivity();
  }

  /* ---------- 列表 ---------- */

  function load() {
    return api('/api/instances').then(function (data) {
      state.instances = data && data.instances ? data.instances : [];
      renderHomes();
      if (!state.detailId) return;
      var current = findInstance(state.detailId);
      if (!current) {
        closeDrawer();
        return;
      }
      // 轮询不重建抽屉：只在状态 / 端口 / pid / 体检结果变了时重画，免得每 2s 清掉正在填的输入
      if (detailSignature(current) !== state.detailSig) renderDetail();
    }).catch(function (err) {
      renderLoadError(err);
    });
  }

  function renderLoadError(err) {
    clear(ui.list);
    var box = el('div', 'empty');
    box.appendChild(el('p', '', '连不上 PAL 启动器：' + err.message));
    box.appendChild(el('p', 'hint', '这个页面可能已经停了：回到终端看 pal ui 的输出。'));
    ui.list.appendChild(box);
  }

  function renderHomes() {
    clear(ui.list);
    if (!state.instances.length) {
      ui.list.appendChild(emptyState());
      return;
    }
    for (var i = 0; i < state.instances.length; i += 1) ui.list.appendChild(card(state.instances[i]));
  }

  function emptyState() {
    var box = el('div', 'empty');
    box.appendChild(el('p', '', '还没有 home。先装一个：'));
    var go = el('button', 'primary', '去安装');
    go.addEventListener('click', function () { setTab('install'); });
    box.appendChild(go);
    box.appendChild(el('p', 'hint', '安装表单调的是同一条 pal install：填来源与宿主，先「预览」看会写哪些文件。'));
    return box;
  }

  function findInstance(id) {
    for (var i = 0; i < state.instances.length; i += 1) {
      if (state.instances[i].id === id) return state.instances[i];
    }
    return null;
  }

  function launchable(inst) {
    var out = [];
    var modes = inst.modes || [];
    for (var i = 0; i < modes.length; i += 1) {
      if (modes[i].kind !== 'foreground') out.push(modes[i]);
    }
    return out;
  }

  function card(inst) {
    var wrap = el('article', 'card');
    var head = el('div', 'card-head');
    head.appendChild(el('h2', 'name', inst.name));
    head.appendChild(el('span', 'host', inst.harness));
    if (inst.pack && inst.pack.name) head.appendChild(el('span', 'pack', inst.pack.name + '@' + inst.pack.version));
    var badges = el('div', 'badges');
    badges.appendChild(el('span', 'badge ' + (inst.status === 'running' ? 'run' : 'idle'), STATUS[inst.status] || inst.status));
    badges.appendChild(el('span', 'badge ' + (inst.attached ? 'attached' : 'managed'), inst.attached ? 'attached' : 'managed'));
    badges.appendChild(healthBadge(inst));
    head.appendChild(badges);
    wrap.appendChild(head);

    var running = inst.status === 'running';
    var actions = el('div', 'actions');
    var modes = launchable(inst);
    for (var i = 0; i < modes.length; i += 1) {
      actions.appendChild(startButton(inst, modes[i], running, modes.length));
    }
    var foreground = null;
    for (var j = 0; j < (inst.modes || []).length; j += 1) {
      if (inst.modes[j].kind === 'foreground') { foreground = inst.modes[j]; break; }
    }
    if (foreground) {
      actions.appendChild(terminalButton(inst, foreground));
      if (foreground.command) {
        var copyBtn = el('button', 'ghost', '复制命令');
        copyBtn.title = foreground.command;
        copyBtn.addEventListener('click', function () { copy(foreground.command); });
        actions.appendChild(copyBtn);
      }
    }
    if (inst.url && (inst.url.indexOf('http://') === 0 || inst.url.indexOf('https://') === 0)) {
      var link = el('a', 'open', '打开');
      link.href = inst.url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      actions.appendChild(link);
    }
    if (running) {
      var stop = el('button', 'danger', '停止');
      stop.addEventListener('click', function () { stopInstance(inst); });
      actions.appendChild(stop);
    }
    wrap.appendChild(actions);

    var meta = el('div', 'meta');
    if (inst.pid) meta.appendChild(el('span', '', 'pid ' + inst.pid));
    if (inst.port) meta.appendChild(el('span', '', '端口 ' + inst.port));
    var logs = el('button', '', '日志');
    logs.addEventListener('click', function () { openDetail(inst, true); });
    meta.appendChild(logs);
    var detail = el('button', 'primary', '详情');
    detail.addEventListener('click', function () { openDetail(inst, false); });
    meta.appendChild(detail);
    wrap.appendChild(meta);
    return wrap;
  }

  function startButton(inst, mode, running, total) {
    var label = mode.kind === 'app' ? '启动 App' : total > 1 ? '启动 ' + mode.label : '启动';
    var node = el('button', 'primary', label);
    if (!mode.available) {
      node.disabled = true;
      node.title = mode.reason || '当前 home 上不可用';
    } else if (running) {
      node.disabled = true;
      node.title = '已在运行，先停止';
    } else {
      node.addEventListener('click', function () { startInstance(inst, mode); });
    }
    return node;
  }

  function terminalButton(inst, mode) {
    var node = el('button', '', '终端');
    node.title = mode.command || '在终端窗口里跑 pal run';
    if (!mode.available) {
      node.disabled = true;
      node.title = mode.reason || '前台模式不可用';
      return node;
    }
    node.addEventListener('click', function () { openTerminal(inst); });
    return node;
  }

  function healthBadge(inst) {
    var entry = state.health[inst.id];
    var badge = el('span', 'badge health');
    if (entry && entry.loading) {
      badge.className = 'badge health idle';
      badge.textContent = '体检中…';
      return badge;
    }
    if (!entry) {
      badge.className = 'badge health idle';
      badge.textContent = '体检';
      badge.title = '按需体检：点这里或打开详情';
      badge.addEventListener('click', function () { loadHealth(inst); });
      return badge;
    }
    if (entry.error) {
      badge.className = 'badge health fail';
      badge.textContent = '体检失败';
      badge.title = entry.error;
      return badge;
    }
    var summary = entry.summary;
    var fails = 0;
    var warns = 0;
    for (var i = 0; i < summary.checks.length; i += 1) {
      if (summary.checks[i].status === 'fail') fails += 1;
      else if (summary.checks[i].status === 'warn') warns += 1;
    }
    badge.className = 'badge health ' + (fails ? 'fail' : warns ? 'warn' : 'ok');
    badge.textContent = fails ? '体检 ' + fails + ' 项失败' : warns ? '体检 ' + warns + ' 项警告' : '体检正常';
    badge.title = '打开详情看体检项';
    badge.addEventListener('click', function () { openDetail(inst, false); });
    return badge;
  }

  /* ---------- 启动 / 停止 / 终端 ---------- */

  function startInstance(inst, mode) {
    clearError();
    beginBusy('正在启动 ' + inst.name + '（' + mode.id + '）…');
    api('/api/start', { id: inst.id, mode: mode.id }).then(function () {
      record('启动', inst.name + ' · ' + mode.id, true);
      toast('已启动 ' + inst.name);
      return load();
    }).catch(function (err) {
      var data = err.data || {};
      record('启动', inst.name + ' · ' + mode.id, false, err.message);
      if (data.command) {
        copy(data.command);
        showError(err.message + '（命令已复制）', data.command);
      } else {
        showError('启动失败：' + err.message, data.details ? JSON.stringify(data.details) : '');
      }
      return load();
    }).then(function () { endBusy(); });
  }

  function stopInstance(inst) {
    clearError();
    beginBusy('正在停止 ' + inst.name + '…');
    api('/api/stop', { id: inst.id }).then(function () {
      record('停止', inst.name, true);
      toast('已停止 ' + inst.name);
      return load();
    }).catch(function (err) {
      record('停止', inst.name, false, err.message);
      showError('停止失败：' + err.message);
      return load();
    }).then(function () { endBusy(); });
  }

  function openTerminal(inst) {
    clearError();
    beginBusy('正在打开终端窗口…');
    api('/api/terminal', { id: inst.id }).then(function (data) {
      record('终端', inst.name, true, data.command || '');
      toast('已打开终端：' + (data.command || ''));
    }).catch(function (err) {
      record('终端', inst.name, false, err.message);
      showError('打开终端失败：' + err.message, err.data && err.data.hint ? err.data.hint : '');
    }).then(function () { endBusy(); });
  }

  /* ---------- 详情 ---------- */

  function openDetail(inst, withLogs) {
    state.detailId = inst.id;
    state.detailSig = null;
    ui.drawer.hidden = false;
    renderDetail();
    // 打开详情触发的体检不记进活动（不是用户点的）
    if (!state.health[inst.id]) loadHealth(inst, true);
    if (withLogs) loadLogs(inst);
  }

  function closeDrawer() {
    state.detailId = null;
    state.detailSig = null;
    ui.drawer.hidden = true;
  }

  /** 抽屉要重画的判据：状态 / 地址 / 进程 / 启动模式 / 体检结果；profile 输入等本地状态不参与。 */
  function detailSignature(inst) {
    var health = state.health[inst.id];
    var healthKey = !health
      ? 'none'
      : health.loading
        ? 'loading'
        : health.error
          ? 'error:' + health.error
          : JSON.stringify(health.summary);
    return [inst.status, inst.url || '', inst.port || '', inst.pid || '', inst.launchMode || '', healthKey].join('|');
  }

  function addKV(dl, key, value) {
    dl.appendChild(el('dt', '', key));
    dl.appendChild(el('dd', '', value === undefined || value === null || value === '' ? '—' : String(value)));
  }

  function renderDetail() {
    var inst = findInstance(state.detailId);
    if (!inst) { closeDrawer(); return; }
    state.detailSig = detailSignature(inst);
    ui.drawerTitle.textContent = '详情 · ' + inst.name;
    clear(ui.drawerBody);

    var info = el('section', 'block');
    info.appendChild(el('h3', '', '基本信息'));
    var dl = el('dl', 'kv');
    addKV(dl, '名称', inst.name);
    addKV(dl, '宿主', inst.harness);
    addKV(dl, 'Pack', inst.pack ? inst.pack.name + '@' + inst.pack.version : '');
    addKV(dl, '状态', STATUS[inst.status] || inst.status);
    addKV(dl, '类型', inst.attached ? 'attached' : 'managed');
    addKV(dl, 'root', inst.root);
    if (inst.home) addKV(dl, 'home', inst.home);
    addKV(dl, 'profile', inst.profile || (inst.harness === 'dsh' && inst.attached ? 'all' : '—'));
    addKV(dl, 'launchMode', inst.launchMode || '—');
    addKV(dl, '端口', inst.port);
    addKV(dl, 'pid', inst.pid);
    if (inst.url) addKV(dl, 'url', inst.url);
    info.appendChild(dl);
    ui.drawerBody.appendChild(info);

    ui.drawerBody.appendChild(healthSection(inst));
    ui.drawerBody.appendChild(actionSection(inst));
    ui.drawerBody.appendChild(logSection(inst));
  }

  function healthSection(inst) {
    var section = el('section', 'block');
    section.appendChild(el('h3', '', '体检（pal health --json）'));
    var entry = state.health[inst.id];
    if (entry && entry.loading) {
      section.appendChild(el('p', 'hint', '读取中…'));
      return section;
    }
    if (!entry) {
      section.appendChild(el('p', 'hint', '读取中…'));
      return section;
    }
    if (entry.error) {
      section.appendChild(el('p', 'bad-text', entry.error));
      var retry = el('button', '', '重新体检');
      retry.addEventListener('click', function () { refreshHealth(inst); });
      section.appendChild(retry);
      return section;
    }
    var list = el('ul', 'checks');
    for (var i = 0; i < entry.summary.checks.length; i += 1) {
      var check = entry.summary.checks[i];
      var row = el('li');
      row.appendChild(el('span', 'check-tag ' + check.status, check.status));
      row.appendChild(el('span', '', check.name + '：' + check.detail));
      list.appendChild(row);
    }
    section.appendChild(list);
    var again = el('button', '', '重新体检');
    again.addEventListener('click', function () { refreshHealth(inst); });
    section.appendChild(again);
    return section;
  }

  function actionSection(inst) {
    var section = el('section', 'block');
    section.appendChild(el('h3', '', '操作（都是 spawn 同一条 pal 命令）'));
    var profileInput = null;
    if (inst.harness === 'dsh' && inst.attached) {
      var profileRow = el('div', 'row');
      profileRow.appendChild(el('label', '', '更新用的 profile'));
      profileInput = el('input');
      profileInput.type = 'text';
      profileInput.placeholder = '留空沿用记录（' + (inst.profile || 'all') + '）；可填 all 或具体名字';
      profileRow.appendChild(profileInput);
      section.appendChild(profileRow);
    }
    var actions = el('div', 'actions');
    var update = el('button', 'primary', '更新');
    update.title = 'pal update --home ' + inst.id;
    update.addEventListener('click', function () {
      var profile = profileInput ? profileInput.value.trim() : '';
      runAction(inst, 'update', profile ? { profile: profile } : {});
    });
    actions.appendChild(update);
    var rollback = el('button', '', '回滚');
    rollback.title = 'pal rollback --home ' + inst.id;
    rollback.addEventListener('click', function () { runAction(inst, 'rollback', {}); });
    actions.appendChild(rollback);
    var verify = el('button', '', '验证');
    verify.title = 'pal verify --home ' + inst.id;
    verify.addEventListener('click', function () { runAction(inst, 'verify', {}); });
    actions.appendChild(verify);
    var uninstall = el('button', 'danger', '卸载');
    uninstall.title = 'pal uninstall --home ' + inst.id + '（保留目录）';
    uninstall.addEventListener('click', function () {
      if (!window.confirm('从 ' + inst.name + ' 卸掉 Pack 装进去的文件？目录会保留。')) return;
      runAction(inst, 'uninstall', {});
    });
    actions.appendChild(uninstall);
    var remove = el('button', 'danger', '删除');
    remove.title = inst.attached
      ? 'pal remove ' + inst.id + '（attached：只摘记录，目录保留）'
      : 'pal remove ' + inst.id + '（managed：删整根或归档）';
    remove.addEventListener('click', function () {
      var question = inst.attached
        ? '摘掉 ' + inst.name + ' 的 PAL 记录并卸包？目录 ' + inst.root + ' 会保留。'
        : '删除 ' + inst.name + '？managed home 的整根会被删掉或归档。';
      if (!window.confirm(question)) return;
      runAction(inst, 'remove', {});
    });
    actions.appendChild(remove);
    section.appendChild(actions);
    section.appendChild(el('p', 'hint', inst.attached
      ? 'attached home：删除只摘 PAL 记录（卸包 + 删记录），目录与用户文件保留；卸载同样保留目录。'
      : 'managed home：删除会删掉整根（或归档）；卸载只摘 Pack 装进去的文件、保留目录。'));
    return section;
  }

  function logSection(inst) {
    var section = el('section', 'block');
    section.appendChild(el('h3', '', '日志（logs/start.log 尾部）'));
    var entry = state.logs[inst.id];
    var pre = el('pre', 'output');
    pre.textContent = entry ? entry.text : '还没有读取';
    section.appendChild(pre);
    var button = el('button', '', entry ? '重新读取' : '读取日志');
    button.addEventListener('click', function () { loadLogs(inst); });
    section.appendChild(button);
    return section;
  }

  function loadLogs(inst) {
    api('/api/logs?id=' + encodeURIComponent(inst.id) + '&tail=200').then(function (data) {
      state.logs[inst.id] = {
        text: data && data.lines && data.lines.length ? data.lines.join('\\n') : '还没有日志',
        file: data ? data.file : ''
      };
      if (state.detailId === inst.id) renderDetail();
    }).catch(function (err) {
      state.logs[inst.id] = { text: '读日志失败：' + err.message };
      if (state.detailId === inst.id) renderDetail();
    });
  }

  function runAction(inst, action, extra) {
    var label = ACTION_LABEL[action] || action;
    var body = { action: action, id: inst.id };
    if (extra) {
      for (var key in extra) {
        if (Object.prototype.hasOwnProperty.call(extra, key)) body[key] = extra[key];
      }
    }
    clearError();
    setOutput('正在' + label + ' ' + inst.name + '…');
    beginBusy(label + ' ' + inst.name + '…');
    api('/api/home-action', body).then(function (data) {
      var text = outputOf(data);
      setOutput(text);
      if (data.ok) {
        record(label, inst.name, true);
        toast(label + '完成：' + inst.name);
        delete state.health[inst.id];
        delete state.logs[inst.id];
        return load().then(function () {
          if (!findInstance(inst.id)) {
            closeDrawer();
            return;
          }
          renderDetail();
          loadHealth(findInstance(inst.id), true);
        });
      }
      record(label, inst.name, false, tail(text));
      showError(label + '失败（exit ' + data.code + '）：' + inst.name, tail(text));
    }).catch(function (err) {
      record(label, inst.name, false, err.message);
      setOutput('失败：' + err.message);
      showError(label + '失败：' + err.message, err.data ? outputOf(err.data) : '');
    }).then(function () { endBusy(); });
  }

  function setOutput(text) {
    ui.outputWrap.hidden = false;
    ui.output.textContent = text;
  }

  function outputOf(data) {
    var parts = [];
    if (data && data.stdout) parts.push(String(data.stdout).trim());
    if (data && data.stderr) parts.push(String(data.stderr).trim());
    if (data && data.timedOut) parts.push('（命令超时，已终止）');
    return parts.join('\\n') || '（没有输出）';
  }

  /* ---------- 体检 ---------- */

  function loadHealth(inst, silent) {
    if (!state.health[inst.id]) {
      state.health[inst.id] = { loading: true };
      renderHomes();
      if (state.detailId === inst.id) renderDetail();
    }
    return api('/api/health?id=' + encodeURIComponent(inst.id)).then(function (data) {
      var summary = healthSummary(data ? data.json : null);
      if (summary) {
        state.health[inst.id] = { summary: summary };
      } else {
        state.health[inst.id] = {
          error: 'pal health 没有给出可解析的 JSON（exit ' + (data ? data.code : '?') + '）：' + tail(data ? (data.raw || data.stderr) : '')
        };
      }
      renderHomes();
      if (state.detailId === inst.id) renderDetail();
      if (!silent) record('体检', inst.name, Boolean(summary), summary ? '' : tail(data ? (data.raw || data.stderr) : ''));
    }).catch(function (err) {
      state.health[inst.id] = { error: '体检失败：' + err.message };
      renderHomes();
      if (state.detailId === inst.id) renderDetail();
      if (!silent) record('体检', inst.name, false, err.message);
    });
  }

  function healthSummary(json) {
    if (!json) return null;
    var report = Array.isArray(json) ? json[0] : json;
    if (!report || !Array.isArray(report.checks)) return null;
    return { ok: report.ok === true, checks: report.checks };
  }

  /** 用户点「重新体检」：清掉缓存再取，徽标回到「体检中…」。 */
  function refreshHealth(inst) {
    delete state.health[inst.id];
    return loadHealth(inst);
  }

  /* ---------- 安装 ---------- */

  function formBody() {
    var target = ui.target.value;
    var body = { source: ui.source.value.trim(), host: ui.host.value, target: target };
    if (target === 'managed') {
      if (ui.name.value.trim()) body.name = ui.name.value.trim();
      if (ui.root.value.trim()) body.root = ui.root.value.trim();
      if (ui.fromHome.value.trim()) body.fromHome = ui.fromHome.value.trim();
    } else if (target === 'attached') {
      body.home = ui.home.value.trim();
      if (ui.name.value.trim()) body.name = ui.name.value.trim();
      if (ui.profile.value.trim()) body.profile = ui.profile.value.trim();
    } else {
      body.project = ui.project.value.trim();
    }
    return body;
  }

  function checkForm(body) {
    if (!body.source) { showError('安装要一个包来源（本地目录 / .phub / registry 名）'); return false; }
    if (!body.host) { showError('安装要选一个宿主'); return false; }
    if (body.target === 'attached' && !body.home) { showError('attached target 要填宿主全局目录（--home）'); return false; }
    if (body.target === 'project' && !body.project) { showError('project target 要填项目目录（--project）'); return false; }
    return true;
  }

  function targetLabel(body) {
    return body.target + ' · ' + body.host + ' · ' + body.source;
  }

  function syncForm() {
    var target = ui.target.value;
    var host = ui.host.value;
    $('row-name').hidden = target === 'project';
    $('row-root').hidden = target !== 'managed';
    $('row-fromHome').hidden = target !== 'managed';
    $('row-home').hidden = target !== 'attached';
    $('row-project').hidden = target !== 'project';
    $('row-profile').hidden = !(target === 'attached' && host === 'dsh');
  }

  function renderHosts() {
    var current = ui.host.value;
    clear(ui.host);
    for (var i = 0; i < state.hosts.length; i += 1) {
      var host = state.hosts[i];
      var option = el('option', '', host.id + ' · ' + host.label + (host.attached ? '' : '（无 attached）'));
      option.value = host.id;
      ui.host.appendChild(option);
    }
    if (current) ui.host.value = current;
    if (!ui.host.value && state.hosts.length) ui.host.value = state.hosts[0].id;
    syncForm();
  }

  function loadHosts() {
    return api('/api/hosts').then(function (data) {
      state.hosts = data && data.hosts ? data.hosts : [];
      renderHosts();
    }).catch(function (err) {
      showError('读宿主列表失败：' + err.message);
    });
  }

  function runPlan() {
    var body = formBody();
    if (!checkForm(body)) return;
    clearError();
    ui.planResult.hidden = true;
    clear(ui.planResult);
    beginBusy('正在计算安装计划…');
    api('/api/plan', body).then(function (data) {
      renderPlan(data, body);
      record('预览安装', targetLabel(body), data.ok, data.ok ? '' : tail(outputOf(data)));
    }).catch(function (err) {
      showError('预览失败：' + err.message, err.data ? outputOf(err.data) : '');
      record('预览安装', targetLabel(body), false, err.message);
    }).then(function () { endBusy(); });
  }

  function renderPlan(data, body) {
    ui.planResult.hidden = false;
    clear(ui.planResult);
    if (!data || !data.ok) {
      ui.planResult.appendChild(el('h3', 'bad-text', '生成计划失败（exit ' + (data ? data.code : '?') + '）'));
      var bad = el('pre', 'output bad');
      bad.textContent = outputOf(data);
      ui.planResult.appendChild(bad);
      showError('生成计划失败（exit ' + (data ? data.code : '?') + '）', tail(outputOf(data)));
      return;
    }
    ui.planResult.appendChild(el('h3', '', '计划已生成（没有落盘）'));
    if (data.name) ui.planResult.appendChild(el('p', 'plan-name', '最终名字：' + data.name));
    else if (body.target !== 'project') ui.planResult.appendChild(el('p', 'plan-name', '最终名字：由 pal install 决定'));
    var plan = data.plan;
    if (!plan || !Array.isArray(plan.actions)) {
      ui.planResult.appendChild(el('p', 'hint', '没有解析出计划 JSON，原始输出：'));
      var raw = el('pre', 'output');
      raw.textContent = data.stdout || '（空）';
      ui.planResult.appendChild(raw);
      return;
    }
    var writes = 0;
    var deletes = 0;
    for (var i = 0; i < plan.actions.length; i += 1) {
      if (plan.actions[i].op === 'delete') deletes += 1;
      else writes += 1;
    }
    ui.planResult.appendChild(el('p', 'hint', '动作 ' + plan.actions.length + ' 个（写 / 改 ' + writes + '，删除 ' + deletes + '）'));
    var list = el('ul', 'plan-actions');
    var limit = Math.min(plan.actions.length, 200);
    for (var j = 0; j < limit; j += 1) list.appendChild(el('li', '', actionLabel(plan.actions[j])));
    ui.planResult.appendChild(list);
    if (plan.actions.length > limit) ui.planResult.appendChild(el('p', 'hint', '… 还有 ' + (plan.actions.length - limit) + ' 个动作没列出'));
    var issues = planIssues(plan);
    if (issues.length) {
      ui.planResult.appendChild(el('p', 'bad-text', '问题 ' + issues.length + ' 条：'));
      var issueList = el('ul', 'plan-issues');
      for (var k = 0; k < issues.length; k += 1) issueList.appendChild(el('li', 'bad-text', issues[k]));
      ui.planResult.appendChild(issueList);
    }
    var stderr = (data.stderr || '').trim();
    if (stderr) {
      ui.planResult.appendChild(el('p', 'hint', 'pal 的提示（stderr）：'));
      var note = el('pre', 'output');
      note.textContent = stderr;
      ui.planResult.appendChild(note);
    }
  }

  function actionLabel(action) {
    var op = action.op || '?';
    var target = action.to || action.path || action.file || '';
    if (op === 'register.mcp') {
      var paths = '';
      if (action.paths && action.paths.length) {
        var names = [];
        for (var i = 0; i < action.paths.length; i += 1) names.push(action.paths[i].path);
        paths = names.join(', ');
      } else {
        paths = action.path || '';
      }
      return 'MCP ' + (action.entryId || action.resource || '') + ' → ' + paths;
    }
    if (op === 'instruction') return '指令块 ' + (action.blockId || '') + ' → ' + (action.file || '');
    if (op === 'exec') return '执行 ' + (action.command || '') + ' ' + ((action.args || []).join(' '));
    if (op === 'state.dir') return '建目录 ' + target + (action.retain === 'keep' ? '（卸载时保留）' : '');
    return op + ' ' + target;
  }

  function planIssues(plan) {
    var out = [];
    var excluded = plan.excluded || [];
    for (var i = 0; i < excluded.length; i += 1) {
      out.push('未安装 ' + (excluded[i].resource || '') + '：' + (excluded[i].reason || ''));
    }
    return out;
  }

  function runInstall() {
    var body = formBody();
    if (!checkForm(body)) return;
    clearError();
    ui.planResult.hidden = true;
    clear(ui.planResult);
    ui.installResult.hidden = false;
    ui.installResult.className = 'output';
    ui.installResult.textContent = '正在安装（长操作期间暂停自动刷新）…';
    beginBusy('正在安装 ' + body.source + '…');
    api('/api/install', body).then(function (data) {
      var text = outputOf(data);
      ui.installResult.textContent = text;
      if (data.ok) {
        ui.installResult.className = 'output';
        record('安装', targetLabel(body), true);
        toast('安装完成：' + body.source);
        resetInstallForm();
        return load();
      }
      ui.installResult.className = 'output bad';
      record('安装', targetLabel(body), false, tail(text));
      showError('安装失败（exit ' + data.code + '）', tail(text));
    }).catch(function (err) {
      ui.installResult.className = 'output bad';
      ui.installResult.textContent = '安装失败：' + err.message;
      record('安装', targetLabel(body), false, err.message);
      showError('安装失败：' + err.message, err.data ? outputOf(err.data) : '');
    }).then(function () { endBusy(); });
  }

  function resetInstallForm() {
    ui.source.value = '';
    ui.name.value = '';
    ui.root.value = '';
    ui.home.value = '';
    ui.project.value = '';
    ui.profile.value = '';
    ui.fromHome.value = '';
  }

  /* ---------- 自动刷新 ---------- */

  function schedule() {
    if (state.timer) {
      clearInterval(state.timer);
      state.timer = null;
    }
    if (!state.auto) return;
    state.timer = setInterval(function () {
      // 长操作（安装 / 更新 / 卸载…）期间暂停轮询，操作完自己会刷新
      if (state.busy) return;
      if (state.tab !== 'homes') return;
      load();
    }, POLL_MS);
  }

  /* ---------- 绑定 ---------- */

  ui.tabHomes.addEventListener('click', function () { setTab('homes'); });
  ui.tabInstall.addEventListener('click', function () { setTab('install'); });
  ui.tabActivity.addEventListener('click', function () { setTab('activity'); });
  ui.refresh.addEventListener('click', function () { clearError(); load(); });
  ui.errorClose.addEventListener('click', clearError);
  ui.auto.addEventListener('change', function () {
    state.auto = ui.auto.checked;
    schedule();
  });
  ui.target.addEventListener('change', syncForm);
  ui.host.addEventListener('change', syncForm);
  ui.preview.addEventListener('click', runPlan);
  ui.install.addEventListener('click', runInstall);
  ui.form.addEventListener('submit', function (event) { event.preventDefault(); });
  ui.drawerClose.addEventListener('click', closeDrawer);
  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape') closeDrawer();
  });

  renderActivity();
  schedule();
  loadHosts().then(load);
})();
</script>
</body>
</html>
`;
