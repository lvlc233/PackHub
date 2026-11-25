// `pal ui` 的单页 HTML：内联 CSS/JS，不引 CDN、不用框架，动态内容一律 textContent / 属性赋值。
//
// 结构是 harness-first：左侧选 harness（dsh / opencode / claude-code / codex / workbody / hermes），
// 右侧是这个 harness 的工作台——当前 home、启动按钮、正在运行、已装整合包。安装是当前 harness 的
// 「添加整合包」弹层，不是一级页面。所有安装/管理动作由服务端 spawn 同一条 pal 命令完成。
export const PAGE_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>PAL 启动器</title>
<style>
:root{
  --bg:#f4f5f7;--panel:#ffffff;--panel-2:#f8f9fa;--line:#e2e4e8;--line-strong:#cfd3d9;
  --text:#1b1f24;--muted:#626b76;--dim:#98a0aa;--accent:#0f6fde;--accent-soft:#eef5ff;
  --green:#15803d;--red:#c2413b;--amber:#b45309;--radius:10px;
  --font:"Segoe UI","Microsoft YaHei UI","PingFang SC",system-ui,-apple-system,sans-serif;
  --mono:"Cascadia Code",Consolas,"SFMono-Regular",monospace;
}
@media (prefers-color-scheme: dark){
  :root{--bg:#131518;--panel:#1b1e22;--panel-2:#20242a;--line:#2a2f36;--line-strong:#3b424b;
    --text:#e5e7ea;--muted:#a0a7b1;--dim:#707884;--accent:#6aa6ff;--accent-soft:#1b2a42;
    --green:#4ade80;--red:#f07167;--amber:#fbbf24;}
}
*{box-sizing:border-box}
html,body{height:100%}
body{margin:0;font-family:var(--font);color:var(--text);background:var(--bg);font-size:13px;line-height:1.5;-webkit-font-smoothing:antialiased}
button,input,select{font:inherit;color:inherit}
button{cursor:pointer}
::selection{background:rgba(15,111,222,.16)}
::-webkit-scrollbar{width:10px;height:10px}
::-webkit-scrollbar-thumb{background:var(--line-strong);border-radius:8px;border:2px solid transparent;background-clip:content-box}

.shell{display:grid;grid-template-columns:210px minmax(0,1fr);min-height:100vh}
.sidebar{position:sticky;top:0;height:100vh;display:flex;flex-direction:column;padding:12px 10px;background:var(--panel-2);border-right:1px solid var(--line)}
.brand{display:flex;align-items:center;gap:9px;padding:4px 8px 12px}
.brand .mark{width:30px;height:30px;border-radius:7px;display:grid;place-items:center;font-weight:700;font-size:13px;background:#171a1f;color:#fff;flex:none}
@media (prefers-color-scheme: dark){.brand .mark{background:#e5e7ea;color:#131518}}
.brand b{display:block;font-size:13px;font-weight:600}
.brand span{display:block;font-size:10.5px;color:var(--dim)}
.side-label{font-size:10px;letter-spacing:.09em;color:var(--dim);padding:8px 9px 5px;text-transform:uppercase}
.harness-list{display:flex;flex-direction:column;gap:1px}
.harness{display:flex;align-items:center;gap:9px;width:100%;padding:7px 9px;border:0;border-radius:7px;background:transparent;color:var(--muted);text-align:left;transition:.12s}
.harness:hover{background:rgba(0,0,0,.05);color:var(--text)}
@media (prefers-color-scheme: dark){.harness:hover{background:rgba(255,255,255,.06)}}
.harness.active{background:rgba(0,0,0,.08);color:var(--text)}
@media (prefers-color-scheme: dark){.harness.active{background:rgba(255,255,255,.1)}}
.harness .mark{width:24px;height:24px;border-radius:6px;display:grid;place-items:center;font-weight:600;font-size:11px;background:var(--panel);border:1px solid var(--line);color:var(--text);flex:none}
.harness .name{flex:1;font-size:12.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.harness .dot{width:6px;height:6px;border-radius:50%;background:var(--line-strong)}
.harness .dot.running{background:var(--green)}
.side-foot{margin-top:auto;display:flex;flex-direction:column;gap:6px;padding:10px 8px 2px;border-top:1px solid var(--line)}
.side-foot .core{display:flex;align-items:center;gap:7px;font-size:11.5px;color:var(--dim)}
.dot{width:6px;height:6px;border-radius:50%;background:var(--green)}
.side-foot label{display:flex;align-items:center;gap:7px;font-size:11.5px;color:var(--muted);cursor:pointer}
.side-foot input{accent-color:var(--accent);margin:0}
.link-btn{border:0;border-radius:6px;background:transparent;color:var(--muted);font-size:11.5px;padding:4px 6px;text-align:left}
.link-btn:hover{background:rgba(0,0,0,.05);color:var(--text)}

main{min-width:0;padding:26px 34px 60px;max-width:1120px}
.topbar{display:flex;justify-content:space-between;align-items:flex-start;gap:20px;margin-bottom:18px}
.topbar h1{margin:0;font-size:22px;font-weight:650;letter-spacing:-.015em}
.topbar p{margin:4px 0 0;color:var(--muted);font-size:12px}
.top-actions{display:flex;gap:6px}
.icon-btn{width:30px;height:30px;border-radius:7px;border:1px solid var(--line);background:var(--panel);display:grid;place-items:center;color:var(--muted);transition:.12s}
.icon-btn:hover{color:var(--text);border-color:var(--line-strong)}

.hero{position:relative;border:1px solid var(--line);border-radius:12px;background:var(--panel);padding:24px;display:flex;align-items:center;justify-content:space-between;gap:24px;min-height:164px}
.hero-main{display:flex;align-items:center;gap:17px;min-width:0}
.hero-mark{width:58px;height:58px;border-radius:12px;display:grid;place-items:center;font-size:23px;font-weight:650;background:var(--panel-2);border:1px solid var(--line);color:var(--text);flex:none}
.eyebrow{font-size:11px;color:var(--dim);margin-bottom:3px}
.hero h2{margin:0;font-size:25px;font-weight:650;letter-spacing:-.02em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.hero .sub{margin:4px 0 0;color:var(--muted);font-size:12px}
.chips{display:flex;gap:6px;flex-wrap:wrap;margin-top:9px}
.chip{font-size:11px;padding:1px 7px;border-radius:4px;border:1px solid var(--line);background:var(--panel-2);color:var(--muted)}
.chip.ok{color:var(--green);border-color:color-mix(in srgb,var(--green) 30%,var(--line))}
.chip.bad{color:var(--red);border-color:color-mix(in srgb,var(--red) 30%,var(--line))}
.hero-actions{display:flex;flex-direction:column;align-items:flex-end;gap:9px;flex:none}
.hero-secondary{display:flex;gap:6px}

.btn{border:1px solid var(--line-strong);background:var(--panel);color:var(--text);padding:7px 13px;border-radius:7px;font-size:12px;transition:.12s;display:inline-flex;align-items:center;gap:6px;white-space:nowrap}
.btn:hover:not(:disabled){background:var(--panel-2);border-color:var(--dim)}
.btn:disabled{opacity:.45;cursor:not-allowed}
.btn.primary{background:var(--accent);border-color:var(--accent);color:#fff;font-weight:550}
.btn.primary:hover:not(:disabled){filter:brightness(.94)}
.btn.xl{font-size:15px;padding:13px 36px;min-width:168px;justify-content:center;border-radius:9px}
.btn.danger{color:var(--red);border-color:color-mix(in srgb,var(--red) 35%,var(--line));background:transparent}
.hero-stop{color:var(--red);border-color:color-mix(in srgb,var(--red) 35%,var(--line));background:transparent;font-weight:550}

.section-head{display:flex;align-items:center;gap:10px;margin:26px 2px 10px}
.section-head h2{margin:0;font-size:12px;font-weight:600;color:var(--muted);letter-spacing:.02em}
.section-head span{color:var(--dim);font-size:11px}
.section-head .spacer{flex:1}
.pack-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}
.pack{position:relative;border:1px solid var(--line);border-radius:10px;background:var(--panel);padding:14px;display:flex;align-items:center;gap:12px;cursor:pointer;transition:.12s;min-height:82px}
.pack:hover{border-color:var(--line-strong);background:var(--panel-2)}
.pack.selected{border-color:var(--accent);background:var(--accent-soft)}
.pack .mark{width:36px;height:36px;border-radius:8px;display:grid;place-items:center;font-weight:600;font-size:14px;background:var(--panel-2);border:1px solid var(--line);flex:none}
.pack-main{min-width:0;flex:1}
.pack-name{font-size:13px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.pack-meta{font-size:11.5px;color:var(--dim);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:1px}
.pack-state{font-size:11px;color:var(--muted);margin-top:5px;display:flex;align-items:center;gap:6px}
.pack .status{width:6px;height:6px;border-radius:50%;background:var(--dim)}
.pack .status.running{background:var(--green)}
.pack .status.broken{background:var(--red)}
.pack-actions{display:flex;flex-direction:column;gap:5px;align-items:flex-end}
.pack-actions .btn{padding:4px 9px;font-size:11px}
.add-pack{border:1px dashed var(--line-strong);border-radius:10px;background:transparent;color:var(--muted);display:flex;align-items:center;justify-content:center;gap:7px;min-height:82px;font-size:12px;transition:.12s}
.add-pack:hover{border-color:var(--accent);color:var(--accent);background:var(--accent-soft)}

.running-strip{margin-top:12px;border:1px solid var(--line);border-radius:9px;background:var(--panel);padding:10px 13px;display:flex;align-items:center;gap:8px;font-size:12px;flex-wrap:wrap}
.running-strip .label{color:var(--muted);flex:none;margin-right:2px}
.running-strip .item{display:flex;align-items:center;gap:6px;padding:2px 8px;border-radius:5px;background:var(--panel-2);border:1px solid var(--line);font-size:11.5px}
.running-strip .item b{font-weight:600}
.running-strip a{color:var(--accent);text-decoration:none;font-size:11px;margin-left:2px}

.empty{border:1px solid var(--line);border-radius:12px;padding:48px 24px;text-align:center;background:var(--panel)}
.empty .big{font-size:22px;margin-bottom:8px;color:var(--dim)}
.empty h3{margin:0 0 6px;font-size:15px;font-weight:600}
.empty p{margin:0 auto 16px;color:var(--muted);font-size:12px;max-width:460px;line-height:1.6}

/* 安装弹层 */
.modal{position:fixed;inset:0;z-index:60;display:flex;align-items:center;justify-content:center;padding:24px}
.modal-scrim{position:absolute;inset:0;background:rgba(15,18,22,.42)}
.modal-card{position:relative;width:min(820px,94vw);max-height:88vh;overflow:auto;background:var(--panel);border:1px solid var(--line);border-radius:12px;box-shadow:0 24px 80px rgba(0,0,0,.25)}
.modal-head{display:flex;justify-content:space-between;align-items:flex-start;padding:18px 20px 12px;border-bottom:1px solid var(--line)}
.modal-head h2{margin:0;font-size:15px;font-weight:600}
.modal-head p{margin:3px 0 0;color:var(--muted);font-size:11.5px}
.modal-body{display:grid;grid-template-columns:minmax(0,1.25fr) minmax(260px,.75fr);gap:16px;padding:18px 20px 20px}
.field{display:flex;flex-direction:column;gap:5px;margin-bottom:12px}
.field label{font-size:11.5px;color:var(--muted)}
.field input,.field select{width:100%;background:var(--panel);border:1px solid var(--line-strong);border-radius:7px;padding:8px 10px;font-size:12px;outline:none;transition:.12s}
.field input:focus,.field select:focus{border-color:var(--accent);box-shadow:0 0 0 2px color-mix(in srgb,var(--accent) 14%,transparent)}
.field input::placeholder{color:var(--dim)}
.row{display:grid;grid-template-columns:1fr 1fr;gap:10px}
.seg{display:flex;gap:2px;background:var(--panel-2);padding:2px;border-radius:7px;border:1px solid var(--line)}
.seg button{flex:1;border:0;background:transparent;color:var(--muted);padding:6px;border-radius:5px;font-size:11.5px;transition:.12s}
.seg button.active{background:var(--panel);color:var(--text);box-shadow:0 1px 2px rgba(0,0,0,.06);border:1px solid var(--line)}
.form-actions{display:flex;gap:8px;justify-content:flex-end;margin-top:14px}
.plan-panel{border-left:1px solid var(--line);padding-left:16px}
.plan-panel h3{margin:0 0 3px;font-size:12px;font-weight:600}
.plan-panel .hint{margin:0 0 10px;color:var(--muted);font-size:11px}
.plan-name{font-size:13px;font-weight:600;margin:0 0 2px}
.plan-sub{color:var(--muted);font-size:11px;margin-bottom:10px}
.plan-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:2px;max-height:300px;overflow:auto}
.plan-list li{display:flex;gap:8px;font-size:11px;border-bottom:1px solid var(--line);padding:4px 0}
.plan-list .op{color:var(--muted);min-width:52px;flex:none}
.issue{margin-top:8px;border-radius:5px;padding:6px 8px;font-size:11px;background:color-mix(in srgb,var(--red) 6%,var(--panel));border:1px solid color-mix(in srgb,var(--red) 25%,var(--line));color:var(--red)}
.out{margin-top:10px;background:var(--panel-2);border:1px solid var(--line);border-radius:7px;padding:9px;font-family:var(--mono);font-size:10.5px;line-height:1.55;white-space:pre-wrap;word-break:break-word;max-height:220px;overflow:auto}

/* 抽屉 */
.scrim{position:fixed;inset:0;background:rgba(15,18,22,.3);opacity:0;pointer-events:none;transition:.18s;z-index:40}
.scrim.open{opacity:1;pointer-events:auto}
.drawer{position:fixed;top:0;right:0;height:100vh;width:min(480px,94vw);z-index:50;background:var(--panel);border-left:1px solid var(--line);transform:translateX(102%);transition:transform .2s ease;display:flex;flex-direction:column}
.drawer.open{transform:none}
.drawer-head{display:flex;justify-content:space-between;align-items:flex-start;padding:16px 18px 12px;border-bottom:1px solid var(--line)}
.drawer-head h2{margin:0;font-size:14px;font-weight:600}
.drawer-head p{margin:3px 0 0;color:var(--muted);font-size:11.5px}
.drawer-body{padding:16px 18px 36px;overflow:auto;display:flex;flex-direction:column;gap:18px}
.kv{display:grid;grid-template-columns:80px 1fr;gap:6px 10px;font-size:11.5px}
.kv dt{color:var(--dim)}
.kv dd{margin:0;word-break:break-all;font-family:var(--mono);font-size:11px}
.block h3{margin:0 0 7px;font-size:11px;font-weight:600;letter-spacing:.03em;text-transform:uppercase;color:var(--dim)}
.actions{display:flex;flex-wrap:wrap;gap:6px}
.health{display:flex;flex-wrap:wrap;gap:6px;align-items:center;font-size:11.5px}
.health .badge{padding:2px 7px;border-radius:4px;border:1px solid var(--line);background:var(--panel-2)}
.health .badge.ok{color:var(--green);border-color:color-mix(in srgb,var(--green) 30%,var(--line))}
.health .badge.bad{color:var(--red);border-color:color-mix(in srgb,var(--red) 30%,var(--line))}
.findings{margin:7px 0 0;padding-left:16px;font-size:11px;color:var(--muted);line-height:1.6}

.toasts{position:fixed;right:18px;bottom:18px;display:flex;flex-direction:column;gap:6px;z-index:80}
.toast{padding:8px 12px;border-radius:7px;font-size:12px;background:var(--panel);border:1px solid var(--line-strong);box-shadow:0 8px 24px rgba(0,0,0,.12);max-width:380px;animation:rise .16s ease}
.toast.bad{border-color:color-mix(in srgb,var(--red) 40%,var(--line));color:var(--red)}
@keyframes rise{from{opacity:0;transform:translateY(5px)}to{opacity:1;transform:none}}
.busy{position:fixed;left:0;right:0;top:0;height:2px;z-index:90;overflow:hidden;opacity:0;transition:.15s}
.busy.on{opacity:1}
.busy::after{content:"";position:absolute;inset:0;width:30%;background:var(--accent);animation:slide 1s infinite}
@keyframes slide{from{transform:translateX(-120%)}to{transform:translateX(380%)}}
.hidden{display:none!important}
.errbar{margin:0 0 14px;border:1px solid color-mix(in srgb,var(--red) 30%,var(--line));background:color-mix(in srgb,var(--red) 6%,var(--panel));color:var(--red);border-radius:7px;padding:8px 10px;font-size:11.5px;white-space:pre-wrap}
@media(max-width:900px){.modal-body{grid-template-columns:1fr}.plan-panel{border-left:0;padding-left:0;border-top:1px solid var(--line);padding-top:12px}}
@media(max-width:760px){
  .shell{grid-template-columns:1fr}
  .sidebar{position:static;height:auto;flex-direction:row;align-items:center;padding:8px 10px;overflow:auto}
  .brand{padding:0 10px 0 0}.brand span{display:none}
  .side-label{display:none}
  .harness-list{flex-direction:row}
  .side-foot{margin:0 0 0 auto;border:0;padding:0;flex-direction:row}
  main{padding:18px 14px 50px}
  .hero{flex-direction:column;align-items:flex-start;padding:18px}
  .hero-actions{align-items:stretch;width:100%}.btn.xl{width:100%}
  .pack-grid{grid-template-columns:1fr}.row{grid-template-columns:1fr}
}
</style>
</head>
<body>
<div class="busy" id="busy"></div>
<div class="shell">
  <aside class="sidebar">
    <div class="brand"><div class="mark">P</div><div><b>PAL</b><span>启动器 · v0.0.1</span></div></div>
    <div class="side-label">Harness</div>
    <div class="harness-list" id="harness-list"></div>
    <div class="side-foot">
      <div class="core"><span class="dot"></span><span id="core-text">本机 · 127.0.0.1</span></div>
      <label><input type="checkbox" id="auto" checked> 自动刷新</label>
      <button class="link-btn" id="refresh" type="button">立即刷新</button>
    </div>
  </aside>
  <main>
    <div class="topbar">
      <div><h1 id="page-title">PAL</h1><p id="page-sub">选一个 harness，然后启动。</p></div>
      <div class="top-actions"><button class="icon-btn" id="top-refresh" type="button" title="刷新">↻</button></div>
    </div>
    <div id="errbar" class="errbar hidden"></div>
    <div id="main-empty" class="empty hidden">
      <div class="big">⌁</div>
      <h3>还没有可用的 harness</h3>
      <p>先装一个宿主 CLI（dsh / opencode / claude / codex），再回来。</p>
    </div>
    <div id="main-body">
      <div id="hero"></div>
      <div id="running-strip"></div>
      <div class="section-head">
        <h2>整合包</h2><span id="pack-count"></span><span class="spacer"></span>
        <button class="btn" id="add-pack" type="button">+ 添加整合包</button>
      </div>
      <div class="pack-grid" id="pack-grid"></div>
      <div id="pack-empty" class="empty hidden" style="margin-top:2px">
        <div class="big">+</div>
        <h3>这个 harness 还没有整合包</h3>
        <p>添加一个包，PAL 会把它装进这个 harness 的一个 home；之后这里会出现可启动的卡片。</p>
        <button class="btn primary" id="empty-add" type="button">添加整合包</button>
      </div>
    </div>
  </main>
</div>

<div class="modal hidden" id="install-modal">
  <div class="modal-scrim" id="modal-scrim"></div>
  <div class="modal-card">
    <div class="modal-head">
      <div><h2 id="modal-title">添加整合包</h2><p>安装到当前 harness；先预览，再落盘。</p></div>
      <button class="icon-btn" id="modal-close" type="button" title="关闭">✕</button>
    </div>
    <div class="modal-body">
      <div>
        <div class="field"><label for="source">来源</label><input id="source" placeholder="Pack 目录 / .phub / registry 名（owner/name）" autocomplete="off"></div>
        <div class="field"><label>装到哪</label>
          <div class="seg" id="target-seg">
            <button type="button" data-target="managed" class="active">命名 home</button>
            <button type="button" data-target="attached">接进已有目录</button>
            <button type="button" data-target="project">项目</button>
          </div>
        </div>
        <div class="row">
          <div class="field" data-target-field="managed"><label for="name">名字（可选）</label><input id="name" placeholder="<host>-<pack>"></div>
          <div class="field" data-target-field="managed"><label for="root">根目录（可选）</label><input id="root" placeholder="默认 PAL 数据目录；可放到别的盘"></div>
        </div>
        <div class="field hidden" data-target-field="attached"><label for="home">已有目录</label><input id="home" placeholder="例如 ~/.config/opencode"></div>
        <div class="field hidden" data-target-field="project"><label for="project">项目目录</label><input id="project" placeholder="宿主会打开这个目录"></div>
        <div class="row">
          <div class="field hidden" data-target-field="attached"><label for="profile">dsh profile（可选）</label><input id="profile" placeholder="web / desktop；不写 = 所有已有 profile"></div>
          <div class="field" data-target-field="managed"><label for="from-home">沿用全局凭据（可选）</label><input id="from-home" placeholder="例如 ~/.dsh"></div>
        </div>
        <div class="form-actions">
          <button class="btn" id="preview" type="button">预览</button>
          <button class="btn primary" id="install" type="button">安装</button>
        </div>
      </div>
      <div class="plan-panel">
        <h3>预览</h3>
        <p class="hint">还没装。选好来源后点「预览」。</p>
        <div id="plan"></div>
      </div>
    </div>
  </div>
</div>

<div class="scrim" id="scrim"></div>
<aside class="drawer" id="drawer" aria-hidden="true">
  <div class="drawer-head"><div><h2 id="drawer-title">详情</h2><p id="drawer-sub"></p></div><button class="icon-btn" id="drawer-close" type="button" title="关闭">✕</button></div>
  <div class="drawer-body" id="drawer-body"></div>
</aside>
<div class="toasts" id="toasts"></div>

<script>
(function(){
  'use strict';
  var state = { instances: [], hosts: [], harness: null, homeByHarness: {}, busy: false, auto: true, detail: null };
  var HOST_NAMES = { dsh:'DSH', 'claude-code':'Claude', codex:'Codex', opencode:'opencode', workbody:'WorkBuddy', hermes:'Hermes' };
  var HOST_DESC = { dsh:'DeepSeek Harness', 'claude-code':'Claude Code', codex:'OpenAI Codex', opencode:'opencode', workbody:'WorkBuddy', hermes:'Hermes' };

  function $(id){ return document.getElementById(id); }
  function el(tag, cls, text){ var n=document.createElement(tag); if(cls)n.className=cls; if(text!==undefined)n.textContent=text; return n; }
  function clear(n){ while(n.firstChild)n.removeChild(n.firstChild); }
  function hostName(id){ return HOST_NAMES[id]||id||'未知'; }
  function packText(inst){ return inst&&inst.pack ? inst.pack.name+(inst.pack.version?'@'+inst.pack.version:'') : ''; }
  function statusText(inst){ if(inst.status==='running')return '运行中'; if(inst.status==='broken'||inst.status==='failed')return '异常'; return '已安装'; }
  function defaultMode(inst){ if(!inst.modes||!inst.modes.length)return null; for(var i=0;i<inst.modes.length;i++)if(inst.modes[i].default)return inst.modes[i]; return inst.modes[0]; }
  function homesOf(harness){ return state.instances.filter(function(i){ return i.harness===harness; }); }
  function currentHome(harness){ var list=homesOf(harness); var id=state.homeByHarness[harness]; for(var i=0;i<list.length;i++)if(list[i].id===id)return list[i]; for(var j=0;j<list.length;j++)if(list[j].status==='running')return list[j]; return list[0]||null; }
  function findInstance(id){ for(var i=0;i<state.instances.length;i++)if(state.instances[i].id===id)return state.instances[i]; return null; }
  function toast(text,bad){ var t=el('div','toast'+(bad?' bad':''),text); $('toasts').appendChild(t); setTimeout(function(){if(t.parentNode)t.parentNode.removeChild(t);},bad?5000:2600); }
  function showError(t){ var b=$('errbar'); b.textContent=t; b.classList.remove('hidden'); }
  function clearError(){ $('errbar').classList.add('hidden'); }
  function beginBusy(msg){ state.busy=true; $('busy').classList.add('on'); var bs=document.querySelectorAll('button'); for(var i=0;i<bs.length;i++){bs[i].dataset.was=bs[i].disabled?'1':'';bs[i].disabled=true;} if(msg)toast(msg); }
  function endBusy(){ state.busy=false; $('busy').classList.remove('on'); var bs=document.querySelectorAll('button'); for(var i=0;i<bs.length;i++){if(bs[i].dataset.was!=='1')bs[i].disabled=false;} }
  function api(path,body){ var o={method:body?'POST':'GET',headers:{'content-type':'application/json','x-pal-ui':'1'}}; if(body)o.body=JSON.stringify(body); return fetch(path,o).then(function(r){return r.json().catch(function(){return {};}).then(function(d){if(!r.ok)throw{status:r.status,data:d,message:d&&d.error?d.error:('HTTP '+r.status)};return d;});}); }

  function load(){
    return api('/api/instances').then(function(d){
      state.instances=d.instances||[];
      if(!state.harness){
        var run=state.instances.filter(function(i){return i.status==='running';})[0];
        state.harness=run?run.harness:(state.hosts[0]?state.hosts[0].id:(state.instances[0]?state.instances[0].harness:null));
      }
      clearError(); render();
    }).catch(function(e){ showError('读取 home 失败：'+(e.message||e)); });
  }
  function loadHosts(){
    return api('/api/hosts').then(function(d){
      state.hosts=d.hosts||[];
      if(!state.harness && state.hosts[0])state.harness=state.hosts[0].id;
      renderHarnessList();
      if(state.harness) render();
    }).catch(function(e){ showError('读取宿主失败：'+(e.message||e)); });
  }

  function renderHarnessList(){
    var box=$('harness-list'); clear(box);
    for(var i=0;i<state.hosts.length;i++){
      var h=state.hosts[i];
      var list=homesOf(h.id);
      var running=list.some(function(x){return x.status==='running';});
      var b=el('button','harness'+(state.harness===h.id?' active':''));
      b.type='button'; b.dataset.harness=h.id;
      b.appendChild(el('span','mark',(HOST_NAMES[h.id]||h.id).slice(0,1).toUpperCase()));
      b.appendChild(el('span','name',hostName(h.id)));
      b.appendChild(el('span','dot'+(running?' running':'')));
      b.title=HOST_DESC[h.id]||h.id;
      b.addEventListener('click',function(){ state.harness=this.dataset.harness; render(); });
      box.appendChild(b);
    }
  }

  function render(){
    renderHarnessList();
    var host=state.harness;
    if(!host){ $('main-body').classList.add('hidden'); $('main-empty').classList.remove('hidden'); return; }
    $('main-body').classList.remove('hidden'); $('main-empty').classList.add('hidden');
    $('page-title').textContent=hostName(host);
    var h=state.hosts.filter(function(x){return x.id===host;})[0];
    var modes=h&&h.modes?h.modes.map(function(m){return m.label;}).join(' / '):'';
    $('page-sub').textContent=(HOST_DESC[host]||host)+(modes?' · '+modes:'');
    var homes=homesOf(host), cur=currentHome(host);
    var hero=$('hero'); clear(hero);
    if(!homes.length){ hero.appendChild(el('div','empty', '')); }
    else hero.appendChild(heroCard(cur));
    renderRunning();
    renderPacks(homes,cur);
  }

  function heroCard(inst){
    var host=inst.harness, mode=defaultMode(inst), running=inst.status==='running';
    var box=el('div','hero');
    var main=el('div','hero-main');
    main.appendChild(el('div','hero-mark',(HOST_NAMES[host]||host).slice(0,1).toUpperCase()));
    var copy=el('div');
    copy.appendChild(el('div','eyebrow',(HOST_DESC[host]||host)+' · '+(inst.attached?'attached home':'managed home')));
    copy.appendChild(el('h2',null,inst.name));
    copy.appendChild(el('p','sub',packText(inst)||'未记录 Pack'));
    var chips=el('div','chips');
    chips.appendChild(el('span','chip '+(running?'ok':''),statusText(inst)));
    if(mode)chips.appendChild(el('span','chip',mode.label));
    if(inst.port)chips.appendChild(el('span','chip','端口 '+inst.port));
    if(inst.profile)chips.appendChild(el('span','chip','profile '+inst.profile));
    chips.appendChild(el('span','chip',homesOf(host).length+' 个整合包'));
    copy.appendChild(chips);
    main.appendChild(copy);
    var actions=el('div','hero-actions');
    if(running){
      var stop=el('button','btn xl hero-stop','停止'); stop.type='button';
      stop.addEventListener('click',function(){ stopInstance(inst); });
      actions.appendChild(stop);
    }else if(mode&&mode.available!==false){
      var start=el('button','btn primary xl',mode.kind==='app'?'启动 App':mode.kind==='foreground'?'打开终端':'启动'); start.type='button';
      start.addEventListener('click',function(){ launch(inst,mode); });
      actions.appendChild(start);
    }else{
      var no=el('button','btn xl','不可启动'); no.type='button'; no.disabled=true; actions.appendChild(no);
    }
    var second=el('div','hero-secondary');
    if(inst.url){ var open=el('button','btn','打开页面'); open.type='button'; open.addEventListener('click',function(){window.open(inst.url,'_blank','noopener');}); second.appendChild(open); }
    var term=el('button','btn','终端'); term.type='button'; term.addEventListener('click',function(){openTerminal(inst);}); second.appendChild(term);
    var detail=el('button','btn','详情'); detail.type='button'; detail.addEventListener('click',function(){openDetail(inst,false);}); second.appendChild(detail);
    actions.appendChild(second); box.appendChild(main); box.appendChild(actions); return box;
  }

  function renderRunning(){
    var strip=$('running-strip'); clear(strip);
    var running=state.instances.filter(function(i){return i.status==='running';});
    if(!running.length)return;
    strip.appendChild(el('span','label','正在运行'));
    for(var i=0;i<running.length;i++){ (function(inst){
      var item=el('span','item'); item.appendChild(el('b',null,inst.name));
      if(inst.url){ var a=el('a',null,'打开'); a.href=inst.url; a.target='_blank'; a.rel='noopener'; item.appendChild(a); }
      strip.appendChild(item);
    })(running[i]); }
  }

  function renderPacks(homes,cur){
    var grid=$('pack-grid'); clear(grid);
    $('pack-count').textContent=homes.length?homes.length+' 个':'';
    $('pack-empty').classList.toggle('hidden',homes.length>0);
    for(var i=0;i<homes.length;i++) grid.appendChild(packCard(homes[i],cur));
    var add=el('button','add-pack','+ 添加整合包'); add.type='button'; add.addEventListener('click',openInstall); grid.appendChild(add);
  }
  function packCard(inst,cur){
    var running=inst.status==='running', mode=defaultMode(inst);
    var c=el('div','pack'+(cur&&cur.id===inst.id?' selected':''));
    c.appendChild(el('div','mark',(HOST_NAMES[inst.harness]||inst.harness).slice(0,1).toUpperCase()));
    var main=el('div','pack-main');
    main.appendChild(el('div','pack-name',inst.name));
    main.appendChild(el('div','pack-meta',packText(inst)||'—'));
    var st=el('div','pack-state'); st.appendChild(el('span','status '+(running?'running':inst.status==='broken'||inst.status==='failed'?'broken':''))); st.appendChild(document.createTextNode(statusText(inst))); main.appendChild(st);
    c.appendChild(main);
    var acts=el('div','pack-actions');
    if(running){ var stop=el('button','btn','停止'); stop.type='button'; stop.addEventListener('click',function(e){e.stopPropagation();stopInstance(inst);}); acts.appendChild(stop); }
    else if(mode&&mode.available!==false){ var go=el('button','btn primary',mode.kind==='foreground'?'终端':'启动'); go.type='button'; go.addEventListener('click',function(e){e.stopPropagation();launch(inst,mode);}); acts.appendChild(go); }
    var d=el('button','btn','详情'); d.type='button'; d.addEventListener('click',function(e){e.stopPropagation();openDetail(inst,false);}); acts.appendChild(d);
    c.appendChild(acts);
    c.addEventListener('click',function(){ state.homeByHarness[state.harness]=inst.id; render(); });
    return c;
  }

  function launch(inst,mode){
    if(!mode){toast('这个 home 没有启动模式',true);return;}
    if(mode.kind==='foreground'){openTerminal(inst);return;}
    beginBusy('正在启动 '+inst.name+' …');
    api('/api/start',{id:inst.id,mode:mode.id}).then(function(){ toast('已启动 '+inst.name); return load(); }).catch(function(e){
      var m=e.message||'启动失败'; if(e.data&&e.data.command)m+='；命令：'+e.data.command; showError('启动失败：'+m);
    }).then(endBusy);
  }
  function stopInstance(inst){
    beginBusy('正在停止 '+inst.name+' …');
    api('/api/stop',{id:inst.id}).then(function(){toast('已停止 '+inst.name);return load();}).catch(function(e){showError('停止失败：'+(e.message||e));}).then(endBusy);
  }
  function openTerminal(inst){
    api('/api/terminal',{id:inst.id}).then(function(d){toast('已打开终端：'+d.command);}).catch(function(e){showError('打开终端失败：'+(e.message||e));});
  }

  function openDetail(inst,withLogs){
    state.detail=inst.id; renderDetail(inst,withLogs);
    $('drawer').classList.add('open'); $('drawer').setAttribute('aria-hidden','false'); $('scrim').classList.add('open');
  }
  function closeDetail(){ $('drawer').classList.remove('open'); $('drawer').setAttribute('aria-hidden','true'); $('scrim').classList.remove('open'); state.detail=null; }
  function kv(rows){ var dl=el('dl','kv'); for(var i=0;i<rows.length;i++){ if(!rows[i][1])continue; dl.appendChild(el('dt',null,rows[i][0])); dl.appendChild(el('dd',null,String(rows[i][1]))); } return dl; }
  function renderDetail(inst,withLogs){
    $('drawer-title').textContent=inst.name; $('drawer-sub').textContent=hostName(inst.harness)+' · '+(inst.attached?'attached':'managed');
    var body=$('drawer-body'); clear(body);
    var info=el('div','block'); info.appendChild(el('h3',null,'信息'));
    info.appendChild(kv([['root',inst.root],['home',inst.home],['pack',packText(inst)],['状态',statusText(inst)],['launchMode',inst.launchMode],['profile',inst.profile],['port',inst.port],['pid',inst.pid],['url',inst.url]]));
    body.appendChild(info);
    var h=el('div','block'); h.appendChild(el('h3',null,'健康')); var hb=el('div','health'); hb.id='health-box'; hb.appendChild(el('span','badge','检查中…')); h.appendChild(hb); body.appendChild(h); loadHealth(inst);
    var a=el('div','block'); a.appendChild(el('h3',null,'操作')); var row=el('div','actions');
    var acts=[['update','更新'],['rollback','回滚'],['verify','验证'],['uninstall','卸载'],['remove','删除']];
    for(var i=0;i<acts.length;i++)(function(action,label){ var b=el('button','btn'+(action==='remove'?' danger':''),label); b.type='button'; b.addEventListener('click',function(){homeAction(inst,action,body);}); row.appendChild(b); })(acts[i][0],acts[i][1]);
    var lg=el('button','btn','日志'); lg.type='button'; lg.addEventListener('click',function(){loadLogs(inst,body);}); row.appendChild(lg); a.appendChild(row); body.appendChild(a);
    var out=el('pre','out hidden'); out.id='detail-out'; body.appendChild(out);
    if(withLogs)loadLogs(inst,body);
  }
  function setOut(body,text){ var o=body.querySelector('#detail-out'); if(!o)return; o.textContent=text||''; o.classList.toggle('hidden',!text); }
  function loadHealth(inst){
    api('/api/health?id='+encodeURIComponent(inst.id)).then(function(d){
      var box=$('health-box'); if(!box)return; clear(box);
      var j=d.json||null, ok=j?(j.ok!==false):(d.code===0&&d.ok!==false);
      box.appendChild(el('span','badge '+(ok?'ok':'bad'),ok?'正常':'有异常'));
      var fs=j&&j.findings?j.findings:[];
      if(fs.length){ var ul=el('ul','findings'); for(var i=0;i<fs.length&&i<12;i++){var f=fs[i];ul.appendChild(el('li',null,(f.level?'['+f.level+'] ':'')+(f.message||f.code||String(f))));} box.appendChild(ul); }
      else if(!ok)box.appendChild(el('span',null,d.raw?String(d.raw).slice(0,240):'体检没有通过'));
    }).catch(function(e){var box=$('health-box');if(!box)return;clear(box);box.appendChild(el('span','badge bad','检查失败'));box.appendChild(el('span',null,e.message||''));});
  }
  function homeAction(inst,action,body){
    if(action==='remove'&&!window.confirm('删除 home「'+inst.name+'」？managed 会删整根；attached 只摘记录。'))return;
    if(action==='uninstall'&&!window.confirm('卸载「'+inst.name+'」里的包？目录会保留。'))return;
    beginBusy('正在'+action+' '+inst.name+' …');
    api('/api/home-action',{action:action,id:inst.id}).then(function(d){ setOut(body,d.stdout||d.stderr||'完成'); toast('完成：'+action); return load(); }).catch(function(e){ var t=(e.data&&(e.data.stdout||e.data.stderr))||e.message||''; setOut(body,t); showError(action+' 失败：'+(e.message||e)); }).then(endBusy);
  }
  function loadLogs(inst,body){
    api('/api/logs?id='+encodeURIComponent(inst.id)+'&tail=200').then(function(d){
      var old=body.querySelector('.logs-pre'); if(old)old.parentNode.removeChild(old);
      var pre=el('pre','out logs-pre'); var lines=d.lines||[]; pre.textContent=lines.length?lines.join('\\n'):'（没有日志）'; body.appendChild(pre);
    }).catch(function(e){setOut(body,'读取日志失败：'+(e.message||e));});
  }

  function openInstall(){
    if(!state.harness){toast('先选一个 harness',true);return;}
    $('modal-title').textContent='给 '+hostName(state.harness)+' 添加整合包';
    $('install-modal').classList.remove('hidden');
    syncTargetFields();
  }
  function closeInstall(){ $('install-modal').classList.add('hidden'); }
  function currentTarget(){ var a=document.querySelector('#target-seg button.active'); return a?a.dataset.target:'managed'; }
  function syncTargetFields(){
    var t=currentTarget(), fields=document.querySelectorAll('[data-target-field]');
    for(var i=0;i<fields.length;i++)fields[i].classList.toggle('hidden',fields[i].dataset.targetField!==t);
    var pf=document.querySelector('[data-target-field="attached"]'); if(pf){var input=pf.querySelector('#profile');if(input)input.parentNode.classList.toggle('hidden',!(state.harness==='dsh'&&t==='attached'));}
  }
  function formBody(){
    var b={source:$('source').value.trim(),host:state.harness,target:currentTarget()};
    if(!b.source)throw new Error('先填包来源');
    if(!b.host)throw new Error('先选 harness');
    if(b.target==='managed'){ if($('name').value.trim())b.name=$('name').value.trim(); if($('root').value.trim())b.root=$('root').value.trim(); if($('from-home').value.trim())b.fromHome=$('from-home').value.trim(); }
    else if(b.target==='attached'){ if(!$('home').value.trim())throw new Error('attached 要填已有目录'); b.home=$('home').value.trim(); if(b.host==='dsh'&&$('profile').value.trim())b.profile=$('profile').value.trim(); }
    else { if(!$('project').value.trim())throw new Error('项目 target 要填项目目录'); b.project=$('project').value.trim(); }
    return b;
  }
  function runPlan(){
    var body; try{body=formBody();}catch(e){showError(e.message);return;}
    beginBusy('正在算计划 …');
    api('/api/plan',body).then(function(d){renderPlan(d);}).catch(function(e){var t=(e.data&&(e.data.stderr||e.data.stdout))||e.message||'';var box=$('plan');clear(box);var pre=el('pre','out');pre.textContent=t||'预览失败';box.appendChild(pre);showError('预览失败：'+(e.message||e));}).then(endBusy);
  }
  function renderPlan(d){
    var box=$('plan'); clear(box);
    if(d.name)box.appendChild(el('div','plan-name',d.name));
    var plan=d.plan||{}, acts=plan.actions||[];
    box.appendChild(el('div','plan-sub',acts.length+' 个动作 · 还没写盘'));
    if(acts.length){var ul=el('ul','plan-list');for(var i=0;i<acts.length&&i<80;i++){var a=acts[i],li=el('li');li.appendChild(el('span','op',a.op||'?'));li.appendChild(el('span',null,a.path||a.to||a.resource||a.file||''));ul.appendChild(li);}box.appendChild(ul);}
    var issues=plan.excluded||d.issues||[];
    for(var j=0;j<issues.length&&j<8;j++){var it=issues[j];box.appendChild(el('div','issue',typeof it==='string'?it:(it.message||it.code||JSON.stringify(it))));}
  }
  function runInstall(){
    var body; try{body=formBody();}catch(e){showError(e.message);return;}
    beginBusy('正在安装 …');
    api('/api/install',body).then(function(d){
      var box=$('plan');clear(box);var pre=el('pre','out');pre.textContent=d.stdout||d.stderr||'完成';box.appendChild(pre);
      toast('安装完成'); closeInstall(); resetForm();
      state.homeByHarness[state.harness]=null; return load();
    }).catch(function(e){var t=(e.data&&(e.data.stdout||e.data.stderr))||e.message||'';var box=$('plan');clear(box);var pre=el('pre','out');pre.textContent=t||'安装失败';box.appendChild(pre);showError('安装失败：'+(e.message||e));}).then(endBusy);
  }
  function resetForm(){ ['source','name','root','home','project','profile','from-home'].forEach(function(id){var n=$(id);if(n)n.value='';}); clear($('plan')); }

  var seg=document.querySelectorAll('#target-seg button');
  for(var s=0;s<seg.length;s++)seg[s].addEventListener('click',function(){for(var j=0;j<seg.length;j++)seg[j].classList.remove('active');this.classList.add('active');syncTargetFields();});
  $('refresh').addEventListener('click',function(){loadHosts();load();});
  $('top-refresh').addEventListener('click',function(){loadHosts();load();});
  $('auto').addEventListener('change',function(){state.auto=this.checked;});
  $('add-pack').addEventListener('click',openInstall);
  $('empty-add').addEventListener('click',openInstall);
  $('modal-close').addEventListener('click',closeInstall);
  $('modal-scrim').addEventListener('click',closeInstall);
  $('preview').addEventListener('click',runPlan);
  $('install').addEventListener('click',runInstall);
  $('scrim').addEventListener('click',closeDetail);
  $('drawer-close').addEventListener('click',closeDetail);
  document.addEventListener('keydown',function(e){if(e.key==='Escape'){closeDetail();closeInstall();}});
  setInterval(function(){if(state.auto&&!state.busy)load();},2500);
  loadHosts(); load();
})();
</script>
</body>
</html>`;
