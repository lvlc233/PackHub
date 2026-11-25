// `pal ui` 的单页 HTML：内联 CSS/JS，不引 CDN、不用框架，动态内容一律 textContent / 属性赋值。
//
// 页面结构：左侧导航（主页 / 安装 / 活动），主页是「当前 home 大卡 + 全部 home 网格」，
// 安装是分步表单（预览 → 安装），活动是最近操作。所有安装/管理动作都由服务端 spawn 同一条
// pal 命令完成；这里只发请求、展示结果，不重写安装逻辑。
export const PAGE_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>PAL 启动器</title>
<style>
:root{
  --bg:#090b0f;
  --bg2:#0d1016;
  --panel:rgba(22,27,36,.72);
  --panel-solid:#12161d;
  --line:rgba(255,255,255,.08);
  --line-strong:rgba(255,255,255,.14);
  --text:#e9eef7;
  --muted:#8b96a8;
  --dim:#5d6879;
  --accent:#8b9cff;
  --accent2:#6f7dff;
  --green:#4ade9f;
  --red:#ff6b7a;
  --amber:#fbbf24;
  --radius:20px;
  --shadow:0 24px 70px rgba(0,0,0,.45);
  --font:"Segoe UI Variable Display","Segoe UI","Microsoft YaHei UI","PingFang SC",system-ui,sans-serif;
  --mono:"Cascadia Code","JetBrains Mono",Consolas,monospace;
}
*{box-sizing:border-box}
html,body{height:100%}
body{
  margin:0;font-family:var(--font);color:var(--text);
  background:
    radial-gradient(1100px 620px at 78% -10%, rgba(111,125,255,.16), transparent 60%),
    radial-gradient(900px 520px at 4% 110%, rgba(74,222,159,.07), transparent 60%),
    linear-gradient(160deg,#0a0c11 0%,#080a0e 55%,#0a0d13 100%);
  background-attachment:fixed;
  -webkit-font-smoothing:antialiased;
}
button,input,select{font:inherit;color:inherit}
button{cursor:pointer}
::selection{background:rgba(139,156,255,.35)}
::-webkit-scrollbar{width:10px;height:10px}
::-webkit-scrollbar-thumb{background:#242b37;border-radius:8px;border:2px solid transparent;background-clip:content-box}

.shell{display:grid;grid-template-columns:236px minmax(0,1fr);min-height:100vh}
.sidebar{
  position:sticky;top:0;height:100vh;display:flex;flex-direction:column;gap:10px;
  padding:26px 18px 20px;border-right:1px solid var(--line);
  background:linear-gradient(180deg,rgba(18,22,30,.72),rgba(10,13,18,.55));
  backdrop-filter:blur(18px);
}
.brand{display:flex;align-items:center;gap:11px;padding:0 8px 18px}
.brand .mark{
  width:38px;height:38px;border-radius:12px;display:grid;place-items:center;font-weight:800;font-size:18px;
  background:linear-gradient(140deg,#8b9cff,#5f6cff);color:#0a0c11;
  box-shadow:0 8px 24px rgba(111,125,255,.35);
}
.brand b{font-size:16px;letter-spacing:.2px}
.brand span{display:block;font-size:11px;color:var(--muted);margin-top:1px}
.nav{display:flex;flex-direction:column;gap:4px}
.nav button{
  display:flex;align-items:center;gap:11px;width:100%;padding:11px 12px;border:0;border-radius:12px;
  background:transparent;color:var(--muted);font-size:14px;text-align:left;transition:.16s;
}
.nav button svg{width:18px;height:18px;flex:none;opacity:.85}
.nav button:hover{background:rgba(255,255,255,.05);color:var(--text)}
.nav button.active{
  background:linear-gradient(90deg,rgba(139,156,255,.20),rgba(139,156,255,.06));
  color:var(--text);box-shadow:inset 0 0 0 1px rgba(139,156,255,.22);
}
.nav button.active svg{color:var(--accent);opacity:1}
.side-foot{margin-top:auto;display:flex;flex-direction:column;gap:10px;padding:14px 10px 0;border-top:1px solid var(--line)}
.side-foot .core{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--muted)}
.dot{width:7px;height:7px;border-radius:50%;background:var(--green);box-shadow:0 0 0 3px rgba(74,222,159,.14)}
.side-foot label{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--muted);cursor:pointer}
.side-foot input{accent-color:var(--accent)}
.link-btn{border:0;background:transparent;color:var(--muted);font-size:12px;padding:6px 0;text-align:left}
.link-btn:hover{color:var(--text)}

main{min-width:0;padding:34px 40px 70px;max-width:1320px}
.topbar{display:flex;justify-content:space-between;align-items:flex-end;gap:20px;margin-bottom:24px}
.topbar h1{margin:0;font-size:28px;font-weight:700;letter-spacing:.2px}
.topbar p{margin:7px 0 0;color:var(--muted);font-size:13px}
.top-actions{display:flex;gap:8px}
.icon-btn{
  width:38px;height:38px;border-radius:12px;border:1px solid var(--line);background:rgba(255,255,255,.03);
  display:grid;place-items:center;color:var(--muted);transition:.16s;
}
.icon-btn:hover{color:var(--text);background:rgba(255,255,255,.07);border-color:var(--line-strong)}

.hero{
  position:relative;overflow:hidden;border-radius:26px;border:1px solid var(--line);
  background:linear-gradient(120deg,rgba(255,255,255,.055),rgba(255,255,255,.015));
  padding:30px 32px;display:flex;align-items:center;justify-content:space-between;gap:24px;
  min-height:196px;box-shadow:var(--shadow);
}
.hero::before{
  content:"";position:absolute;inset:-40% -10% auto auto;width:520px;height:420px;border-radius:50%;
  background:radial-gradient(circle,var(--host-soft,rgba(139,156,255,.20)),transparent 65%);filter:blur(6px);
}
.hero-main{display:flex;align-items:center;gap:20px;position:relative;min-width:0}
.hero-mark{
  width:72px;height:72px;border-radius:20px;display:grid;place-items:center;font-size:30px;font-weight:800;
  background:linear-gradient(145deg,var(--host,#8b9cff),color-mix(in srgb,var(--host,#8b9cff) 55%,#000));
  color:#0a0c11;box-shadow:0 14px 40px var(--host-glow,rgba(139,156,255,.28));flex:none;
}
.eyebrow{font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:var(--muted);margin-bottom:6px}
.hero h2{margin:0;font-size:30px;font-weight:750;letter-spacing:.2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.hero .sub{margin:7px 0 0;color:var(--muted);font-size:13px}
.chips{display:flex;gap:7px;flex-wrap:wrap;margin-top:12px}
.chip{
  font-size:11px;padding:4px 9px;border-radius:999px;border:1px solid var(--line);
  background:rgba(255,255,255,.04);color:var(--muted);
}
.chip.host{color:var(--host,#8b9cff);border-color:var(--host-border,rgba(139,156,255,.3))}
.chip.ok{color:var(--green);border-color:rgba(74,222,159,.3)}
.chip.bad{color:var(--red);border-color:rgba(255,107,122,.3)}
.chip.run{color:var(--green);border-color:rgba(74,222,159,.3)}
.hero-actions{position:relative;display:flex;flex-direction:column;align-items:flex-end;gap:12px;flex:none}
.btn{
  border:1px solid var(--line);background:rgba(255,255,255,.04);color:var(--text);
  padding:10px 16px;border-radius:12px;font-size:13px;transition:.16s;display:inline-flex;align-items:center;gap:8px;
}
.btn:hover:not(:disabled){background:rgba(255,255,255,.08);border-color:var(--line-strong);transform:translateY(-1px)}
.btn:disabled{opacity:.45;cursor:not-allowed;transform:none}
.btn.primary{
  background:linear-gradient(135deg,#9aa8ff,#6f7dff);border-color:transparent;color:#0a0c11;font-weight:700;
  box-shadow:0 14px 34px rgba(111,125,255,.32);
}
.btn.primary:hover:not(:disabled){box-shadow:0 18px 44px rgba(111,125,255,.42)}
.btn.xl{font-size:16px;padding:16px 34px;border-radius:16px;min-width:172px;justify-content:center}
.btn.danger{color:#ffc3ca;border-color:rgba(255,107,122,.3);background:rgba(255,107,122,.08)}
.btn.danger:hover:not(:disabled){background:rgba(255,107,122,.16)}
.btn.ghost{background:transparent}
.hero-secondary{display:flex;gap:8px}
.hero-stop{
  background:rgba(255,107,122,.12);border-color:rgba(255,107,122,.35);color:#ffc3ca;font-weight:700;
}

.section-head{display:flex;align-items:baseline;justify-content:space-between;margin:34px 2px 14px}
.section-head h2{margin:0;font-size:15px;font-weight:650}
.section-head span{color:var(--dim);font-size:12px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(238px,1fr));gap:14px}
.card{
  position:relative;text-align:left;border:1px solid var(--line);border-radius:var(--radius);
  background:linear-gradient(160deg,rgba(255,255,255,.045),rgba(255,255,255,.012));
  padding:17px;transition:.18s;overflow:hidden;min-height:148px;display:flex;flex-direction:column;gap:12px;
}
.card:hover{transform:translateY(-2px);border-color:var(--line-strong);background:rgba(255,255,255,.055)}
.card.selected{border-color:var(--host,#8b9cff);box-shadow:0 0 0 1px var(--host,#8b9cff),0 18px 46px rgba(0,0,0,.35)}
.card::after{content:"";position:absolute;inset:auto -20% -60% auto;width:180px;height:180px;border-radius:50%;background:radial-gradient(circle,var(--host-soft,rgba(139,156,255,.16)),transparent 68%)}
.card-top{display:flex;align-items:center;justify-content:space-between;position:relative}
.card .mark{
  width:38px;height:38px;border-radius:12px;display:grid;place-items:center;font-weight:800;font-size:16px;
  background:linear-gradient(145deg,var(--host,#8b9cff),color-mix(in srgb,var(--host,#8b9cff) 50%,#000));color:#0a0c11;
}
.card .status{width:8px;height:8px;border-radius:50%;background:var(--dim)}
.card .status.running{background:var(--green);box-shadow:0 0 0 4px rgba(74,222,159,.12);animation:pulse 2s infinite}
.card .status.broken{background:var(--red)}
@keyframes pulse{0%,100%{box-shadow:0 0 0 3px rgba(74,222,159,.14)}50%{box-shadow:0 0 0 7px rgba(74,222,159,.04)}}
.card-name{font-size:15px;font-weight:650;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;position:relative}
.card-meta{color:var(--muted);font-size:12px;margin-top:-6px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;position:relative}
.card-foot{margin-top:auto;display:flex;align-items:center;justify-content:space-between;position:relative}
.card-foot .state{font-size:11px;color:var(--dim);letter-spacing:.04em}
.card-foot .go{color:var(--host,#8b9cff);font-size:13px;opacity:.8}

.empty{
  border:1px dashed var(--line-strong);border-radius:26px;padding:56px 30px;text-align:center;
  background:radial-gradient(600px 240px at 50% 0%,rgba(139,156,255,.10),transparent 70%);
}
.empty .big{font-size:44px;margin-bottom:12px;opacity:.9}
.empty h3{margin:0 0 8px;font-size:19px}
.empty p{margin:0 auto 20px;color:var(--muted);font-size:13px;max-width:480px;line-height:1.7}

/* 安装 */
.wizard{display:grid;grid-template-columns:minmax(0,1.25fr) minmax(300px,.75fr);gap:18px;align-items:start}
.panel{
  border:1px solid var(--line);border-radius:22px;background:var(--panel);backdrop-filter:blur(16px);
  padding:24px;box-shadow:var(--shadow);
}
.panel h2{margin:0 0 4px;font-size:17px}
.panel .hint{margin:0 0 20px;color:var(--muted);font-size:12px;line-height:1.6}
.field{display:flex;flex-direction:column;gap:7px;margin-bottom:15px}
.field label{font-size:12px;color:var(--muted)}
.field input,.field select{
  width:100%;background:rgba(0,0,0,.26);border:1px solid var(--line);border-radius:12px;
  padding:11px 13px;font-size:13px;outline:none;transition:.15s;
}
.field input:focus,.field select:focus{border-color:rgba(139,156,255,.55);box-shadow:0 0 0 3px rgba(139,156,255,.12)}
.field input::placeholder{color:#4d5767}
.row{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.seg{display:flex;gap:6px;background:rgba(0,0,0,.24);padding:5px;border-radius:13px;border:1px solid var(--line)}
.seg button{flex:1;border:0;background:transparent;color:var(--muted);padding:8px;border-radius:9px;font-size:12px;transition:.15s}
.seg button.active{background:rgba(139,156,255,.18);color:var(--text);box-shadow:inset 0 0 0 1px rgba(139,156,255,.24)}
.host-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:9px}
.host-tile{
  border:1px solid var(--line);background:rgba(255,255,255,.025);border-radius:13px;padding:12px 10px;
  display:flex;flex-direction:column;align-items:center;gap:7px;transition:.15s;font-size:12px;
}
.host-tile:hover{background:rgba(255,255,255,.06)}
.host-tile.active{border-color:var(--host,#8b9cff);background:rgba(139,156,255,.10);box-shadow:0 0 0 1px var(--host,#8b9cff)}
.host-tile .mark{width:30px;height:30px;border-radius:9px;display:grid;place-items:center;font-weight:800;font-size:13px;background:linear-gradient(145deg,var(--host,#8b9cff),color-mix(in srgb,var(--host,#8b9cff) 50%,#000));color:#0a0c11}
.form-actions{display:flex;gap:10px;justify-content:flex-end;margin-top:18px}
.plan{position:sticky;top:24px}
.plan-name{font-size:20px;font-weight:750;margin:2px 0 4px}
.plan-sub{color:var(--muted);font-size:12px;margin-bottom:16px}
.plan-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:6px;max-height:360px;overflow:auto}
.plan-list li{display:flex;gap:9px;font-size:12px;color:#c6d0df;background:rgba(0,0,0,.18);border:1px solid var(--line);border-radius:9px;padding:8px 10px}
.plan-list .op{color:var(--accent);font-weight:650;flex:none}
.issue{margin-top:12px;border-radius:10px;padding:9px 11px;font-size:12px;background:rgba(255,107,122,.08);border:1px solid rgba(255,107,122,.25);color:#ffc3ca}
.out{
  margin-top:14px;background:#07090d;border:1px solid var(--line);border-radius:12px;padding:12px;
  font-family:var(--mono);font-size:11.5px;line-height:1.65;white-space:pre-wrap;word-break:break-word;
  max-height:260px;overflow:auto;color:#b9c4d4;
}

/* 活动 */
.activity{display:flex;flex-direction:column;gap:8px}
.act{
  display:grid;grid-template-columns:76px 1fr auto;gap:14px;align-items:center;
  border:1px solid var(--line);border-radius:13px;padding:11px 14px;background:rgba(255,255,255,.025);font-size:12px;
}
.act time{color:var(--dim);font-variant-numeric:tabular-nums}
.act .what{color:var(--text)}
.act .res{font-size:11px;color:var(--green)}
.act .res.bad{color:var(--red)}

/* 抽屉 */
.scrim{position:fixed;inset:0;background:rgba(4,6,9,.6);backdrop-filter:blur(3px);opacity:0;pointer-events:none;transition:.2s;z-index:40}
.scrim.open{opacity:1;pointer-events:auto}
.drawer{
  position:fixed;top:0;right:0;height:100vh;width:min(520px,94vw);z-index:50;
  background:linear-gradient(180deg,#10141b,#0b0e13);border-left:1px solid var(--line-strong);
  transform:translateX(102%);transition:transform .24s cubic-bezier(.2,.8,.2,1);
  display:flex;flex-direction:column;box-shadow:-30px 0 80px rgba(0,0,0,.5);
}
.drawer.open{transform:none}
.drawer-head{display:flex;justify-content:space-between;align-items:flex-start;padding:22px 24px 16px;border-bottom:1px solid var(--line)}
.drawer-head h2{margin:0;font-size:18px}
.drawer-head p{margin:5px 0 0;color:var(--muted);font-size:12px}
.drawer-body{padding:20px 24px 40px;overflow:auto;display:flex;flex-direction:column;gap:20px}
.kv{display:grid;grid-template-columns:88px 1fr;gap:9px 12px;font-size:12px}
.kv dt{color:var(--dim)}
.kv dd{margin:0;color:#c8d2e2;word-break:break-all;font-family:var(--mono);font-size:11.5px}
.block h3{margin:0 0 9px;font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:var(--muted)}
.actions{display:flex;flex-wrap:wrap;gap:8px}
.health{display:flex;gap:8px;align-items:center;font-size:12px}
.health .badge{padding:4px 9px;border-radius:999px;border:1px solid var(--line);background:rgba(255,255,255,.03)}
.health .badge.ok{color:var(--green);border-color:rgba(74,222,159,.3)}
.health .badge.bad{color:var(--red);border-color:rgba(255,107,122,.3)}
.health .badge.warn{color:var(--amber);border-color:rgba(251,191,36,.3)}
.findings{margin:9px 0 0;padding-left:17px;font-size:11.5px;color:var(--muted);line-height:1.7}

/* 浮层 */
.toasts{position:fixed;right:24px;bottom:24px;display:flex;flex-direction:column;gap:8px;z-index:80}
.toast{
  padding:11px 15px;border-radius:12px;font-size:12.5px;background:#1a2029;border:1px solid var(--line-strong);
  box-shadow:0 16px 40px rgba(0,0,0,.4);animation:rise .2s ease;max-width:420px;
}
.toast.bad{border-color:rgba(255,107,122,.4);background:#241318;color:#ffd3d8}
@keyframes rise{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
.busy{
  position:fixed;left:0;right:0;top:0;height:2px;background:transparent;z-index:90;overflow:hidden;opacity:0;transition:.2s;
}
.busy.on{opacity:1}
.busy::after{
  content:"";position:absolute;inset:0;width:38%;background:linear-gradient(90deg,transparent,#8b9cff,transparent);
  animation:slide 1.1s infinite;
}
@keyframes slide{from{transform:translateX(-120%)}to{transform:translateX(320%)}}
.hidden{display:none!important}
.errbar{
  margin:0 0 18px;border:1px solid rgba(255,107,122,.3);background:rgba(255,107,122,.08);
  color:#ffc3ca;border-radius:12px;padding:10px 13px;font-size:12px;white-space:pre-wrap;
}
@media(max-width:1080px){
  .wizard{grid-template-columns:1fr}
  .plan{position:static}
}
@media(max-width:760px){
  .shell{grid-template-columns:1fr}
  .sidebar{position:static;height:auto;flex-direction:row;align-items:center;padding:14px}
  .brand{padding:0 12px 0 0}
  .brand span{display:none}
  .nav{flex-direction:row}
  .nav button span{display:none}
  .side-foot{margin:0 0 0 auto;border:0;padding:0;flex-direction:row}
  main{padding:22px 18px 60px}
  .hero{flex-direction:column;align-items:flex-start;padding:24px}
  .hero-actions{align-items:stretch;width:100%}
  .btn.xl{width:100%}
  .row{grid-template-columns:1fr}
}
</style>
</head>
<body>
<div class="busy" id="busy"></div>
<div class="shell">
  <aside class="sidebar">
    <div class="brand"><div class="mark">P</div><div><b>PAL</b><span>启动器 · v0.0.1</span></div></div>
    <nav class="nav">
      <button data-tab="homes" class="active" type="button">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M4 10.5 12 4l8 6.5V20a1 1 0 0 1-1 1h-5v-6H10v6H5a1 1 0 0 1-1-1z"/></svg>
        <span>主页</span>
      </button>
      <button data-tab="install" type="button">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M12 4v10m0 0 4-4m-4 4-4-4"/><path d="M4 17v2a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-2"/></svg>
        <span>安装</span>
      </button>
      <button data-tab="activity" type="button">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M4 6h16M4 12h16M4 18h10"/></svg>
        <span>活动</span>
      </button>
    </nav>
    <div class="side-foot">
      <div class="core"><span class="dot"></span><span id="core-text">本机 · 127.0.0.1</span></div>
      <label><input type="checkbox" id="auto" checked> 自动刷新</label>
      <button class="link-btn" id="refresh" type="button">立即刷新</button>
    </div>
  </aside>

  <main>
    <div class="topbar">
      <div>
        <h1 id="page-title">主页</h1>
        <p id="page-sub">选一个 home，然后启动它。</p>
      </div>
      <div class="top-actions">
        <button class="icon-btn" id="top-refresh" type="button" title="刷新">
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 5v6h-6"/></svg>
        </button>
      </div>
    </div>

    <div id="errbar" class="errbar hidden"></div>

    <section id="view-homes">
      <div id="hero"></div>
      <div class="section-head"><h2>全部 home</h2><span id="count"></span></div>
      <div class="grid" id="grid"></div>
    </section>

    <section id="view-install" class="hidden">
      <div class="wizard">
        <div class="panel">
          <h2>安装一个整合包</h2>
          <p class="hint">先预览会写什么，再真正落盘。安装动作走和命令行同一条路径，UI 不另存一份状态。</p>
          <div class="field">
            <label for="source">来源</label>
            <input id="source" placeholder="Pack 目录 / .phub / registry 名（owner/name）" autocomplete="off">
          </div>
          <div class="field">
            <label>宿主</label>
            <div class="host-grid" id="host-tiles"></div>
          </div>
          <div class="field">
            <label>装到哪</label>
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
        <div class="panel plan" id="plan-panel">
          <h2>预览</h2>
          <p class="hint">还没装。选好来源和宿主后点「预览」。</p>
          <div id="plan"></div>
        </div>
      </div>
    </section>

    <section id="view-activity" class="hidden">
      <div class="panel">
        <h2>最近操作</h2>
        <p class="hint">只存在这个页面内存里，刷新就没了。</p>
        <div class="activity" id="activity-list"></div>
      </div>
    </section>
  </main>
</div>

<div class="scrim" id="scrim"></div>
<aside class="drawer" id="drawer" aria-hidden="true">
  <div class="drawer-head">
    <div><h2 id="drawer-title">详情</h2><p id="drawer-sub"></p></div>
    <button class="icon-btn" id="drawer-close" type="button" title="关闭">✕</button>
  </div>
  <div class="drawer-body" id="drawer-body"></div>
</aside>
<div class="toasts" id="toasts"></div>

<script>
(function(){
  'use strict';
  var state = {
    instances: [], hosts: [], selected: null, tab: 'homes', busy: false,
    auto: true, activity: [], plan: null, detail: null, health: {}, logs: null
  };
  var HOST_COLORS = { dsh:'#8b7cff', 'claude-code':'#e08263', codex:'#3ecf9a', opencode:'#f0b35b', workbody:'#58a6ff', hermes:'#c084fc' };
  var HOST_NAMES = { dsh:'DSH', 'claude-code':'Claude', codex:'Codex', opencode:'opencode', workbody:'WorkBuddy', hermes:'Hermes' };

  function $(id){ return document.getElementById(id); }
  function el(tag, cls, text){
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  function clear(node){ while (node.firstChild) node.removeChild(node.firstChild); }
  function hostOf(inst){ return inst && inst.harness ? inst.harness : ''; }
  function hostName(id){ return HOST_NAMES[id] || id || '未知'; }
  function hostColor(id){ return HOST_COLORS[id] || '#8b9cff'; }
  function packText(inst){
    if (!inst || !inst.pack) return '';
    return inst.pack.name + (inst.pack.version ? '@' + inst.pack.version : '');
  }
  function statusText(inst){
    if (inst.status === 'running') return '运行中';
    if (inst.status === 'broken' || inst.status === 'failed') return '异常';
    return '已安装';
  }
  function defaultMode(inst){
    if (!inst.modes || !inst.modes.length) return null;
    for (var i=0;i<inst.modes.length;i++) if (inst.modes[i].default) return inst.modes[i];
    return inst.modes[0];
  }
  function findInstance(id){
    for (var i=0;i<state.instances.length;i++) if (state.instances[i].id === id || state.instances[i].name === id) return state.instances[i];
    return null;
  }
  function toast(text, bad){
    var t = el('div', 'toast' + (bad ? ' bad' : ''), text);
    $('toasts').appendChild(t);
    setTimeout(function(){ if (t.parentNode) t.parentNode.removeChild(t); }, bad ? 5200 : 2800);
  }
  function showError(text){ var b=$('errbar'); b.textContent=text; b.classList.remove('hidden'); }
  function clearError(){ $('errbar').classList.add('hidden'); }
  function busyText(){ return state.busy ? '处理中…' : ''; }
  function beginBusy(label){
    state.busy = true; $('busy').classList.add('on');
    var buttons = document.querySelectorAll('button');
    for (var i=0;i<buttons.length;i++){ buttons[i].dataset.wasDisabled = buttons[i].disabled ? '1' : ''; buttons[i].disabled = true; }
    if (label) toast(label);
  }
  function endBusy(){
    state.busy = false; $('busy').classList.remove('on');
    var buttons = document.querySelectorAll('button');
    for (var i=0;i<buttons.length;i++){ if (buttons[i].dataset.wasDisabled !== '1') buttons[i].disabled = false; }
  }
  function record(action, target, ok, detail){
    state.activity.unshift({ at: new Date(), action: action, target: target, ok: ok, detail: detail || '' });
    if (state.activity.length > 50) state.activity.length = 50;
    if (state.tab === 'activity') renderActivity();
  }
  function api(path, body){
    var opts = { method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json', 'x-pal-ui': '1' } };
    if (body) opts.body = JSON.stringify(body);
    return fetch(path, opts).then(function(res){
      return res.json().catch(function(){ return {}; }).then(function(data){
        if (!res.ok) throw { status: res.status, data: data, message: data && data.error ? data.error : ('HTTP ' + res.status) };
        return data;
      });
    });
  }

  function setTab(tab){
    state.tab = tab;
    if (location.hash !== '#' + tab) history.replaceState(null, '', '#' + tab);
    var tabs = document.querySelectorAll('[data-tab]');
    for (var i=0;i<tabs.length;i++) tabs[i].classList.toggle('active', tabs[i].dataset.tab === tab);
    $('view-homes').classList.toggle('hidden', tab !== 'homes');
    $('view-install').classList.toggle('hidden', tab !== 'install');
    $('view-activity').classList.toggle('hidden', tab !== 'activity');
    var titles = { homes:['主页','选一个 home，然后启动它。'], install:['安装','预览会写什么，再真正落盘。'], activity:['活动','这次会话里做过的操作。'] };
    $('page-title').textContent = titles[tab][0];
    $('page-sub').textContent = titles[tab][1];
    if (tab === 'activity') renderActivity();
  }

  function load(){
    return api('/api/instances').then(function(data){
      var list = data.instances || [];
      state.instances = list;
      if (!state.selected || !findInstance(state.selected)) {
        var running = null;
        for (var i=0;i<list.length;i++) if (list[i].status === 'running') { running = list[i]; break; }
        state.selected = running ? running.id : (list[0] ? list[0].id : null);
      }
      clearError();
      renderHomes();
    }).catch(function(err){
      showError('读取 home 失败：' + (err.message || err));
    });
  }

  function renderHomes(){
    var hero = $('hero'); clear(hero); clear($('grid')); $('count').textContent = state.instances.length + ' 个';
    if (!state.instances.length) {
      var empty = el('div','empty');
      empty.appendChild(el('div','big','⌁'));
      empty.appendChild(el('h3', null, '还没有 home'));
      empty.appendChild(el('p', null, '装第一个整合包：选一个宿主，预览会写哪些文件，然后安装。'));
      var go = el('button','btn primary','去安装'); go.type='button';
      go.addEventListener('click', function(){ setTab('install'); });
      empty.appendChild(go); hero.appendChild(empty); return;
    }
    var selected = findInstance(state.selected) || state.instances[0];
    hero.appendChild(heroCard(selected));
    for (var i=0;i<state.instances.length;i++) $('grid').appendChild(card(state.instances[i], selected.id));
  }

  function heroCard(inst){
    var host = hostOf(inst), mode = defaultMode(inst), running = inst.status === 'running';
    var box = el('div','hero');
    box.dataset.host = host;
    box.style.setProperty('--host', hostColor(host));
    box.style.setProperty('--host-soft', hexA(hostColor(host), .22));
    box.style.setProperty('--host-glow', hexA(hostColor(host), .30));
    var main = el('div','hero-main');
    var mark = el('div','hero-mark', (HOST_NAMES[host] || host || '?').slice(0,1).toUpperCase());
    var copy = el('div');
    copy.appendChild(el('div','eyebrow', (inst.attached ? 'attached home' : 'managed home') + ' · ' + hostName(host)));
    copy.appendChild(el('h2', null, inst.name));
    copy.appendChild(el('p','sub', packText(inst) || '未记录 Pack'));
    var chips = el('div','chips');
    chips.appendChild(el('span','chip host', hostName(host)));
    if (inst.attached) chips.appendChild(el('span','chip','attached'));
    chips.appendChild(el('span','chip ' + (running ? 'ok' : ''), statusText(inst)));
    if (inst.url) chips.appendChild(el('span','chip','端口 ' + inst.port));
    if (inst.profile) chips.appendChild(el('span','chip','profile ' + inst.profile));
    copy.appendChild(chips);
    main.appendChild(mark); main.appendChild(copy);

    var actions = el('div','hero-actions');
    if (running) {
      var stop = el('button','btn xl hero-stop','停止');
      stop.type='button';
      stop.addEventListener('click', function(){ stopInstance(inst); });
      actions.appendChild(stop);
    } else if (mode && mode.available !== false) {
      var start = el('button','btn primary xl', (mode.kind === 'app' ? '启动 App' : mode.kind === 'foreground' ? '打开终端' : '启动'));
      start.type='button';
      start.addEventListener('click', function(){ launch(inst, mode); });
      actions.appendChild(start);
    } else {
      var blocked = el('button','btn xl','不可启动'); blocked.type='button'; blocked.disabled=true; actions.appendChild(blocked);
    }
    var second = el('div','hero-secondary');
    if (inst.url) {
      var open = el('button','btn','打开页面');
      open.type='button'; open.addEventListener('click', function(){ window.open(inst.url, '_blank', 'noopener'); });
      second.appendChild(open);
    }
    var term = el('button','btn','终端'); term.type='button';
    term.addEventListener('click', function(){ openTerminal(inst); }); second.appendChild(term);
    var detail = el('button','btn','详情'); detail.type='button';
    detail.addEventListener('click', function(){ openDetail(inst, false); }); second.appendChild(detail);
    actions.appendChild(second);
    box.appendChild(main); box.appendChild(actions);
    return box;
  }

  function card(inst, selectedId){
    var host = hostOf(inst), mode = defaultMode(inst), running = inst.status === 'running';
    var c = el('div','card' + (inst.id === selectedId ? ' selected' : ''));
    c.dataset.host = host;
    c.style.setProperty('--host', hostColor(host));
    c.style.setProperty('--host-soft', hexA(hostColor(host), .16));
    c.tabIndex = 0;
    var top = el('div','card-top');
    top.appendChild(el('div','mark', (HOST_NAMES[host] || host || '?').slice(0,1).toUpperCase()));
    top.appendChild(el('span','status ' + (running ? 'running' : inst.status === 'broken' || inst.status === 'failed' ? 'broken' : '')));
    c.appendChild(top);
    c.appendChild(el('div','card-name', inst.name));
    c.appendChild(el('div','card-meta', hostName(host) + ' · ' + (packText(inst) || '—')));
    var foot = el('div','card-foot');
    foot.appendChild(el('span','state', statusText(inst)));
    var go = el('span','go', running ? '停止 ↩' : (mode && mode.kind === 'foreground' ? '终端 →' : '启动 →'));
    foot.appendChild(go); c.appendChild(foot);
    function act(e){
      if (e) e.stopPropagation();
      if (state.busy) return;
      state.selected = inst.id; renderHomes();
      if (running) stopInstance(inst);
      else if (mode && mode.available !== false) launch(inst, mode);
      else toast('这个 home 在当前环境不能启动', true);
    }
    c.addEventListener('click', function(){ state.selected = inst.id; renderHomes(); });
    c.addEventListener('keydown', function(e){ if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); act(e); } });
    go.addEventListener('click', act);
    return c;
  }

  function hexA(hex, alpha){
    var h = String(hex || '#8b9cff').replace('#','');
    if (h.length === 3) h = h[0]+h[0]+h[1]+h[1]+h[2]+h[2];
    var r = parseInt(h.slice(0,2),16), g = parseInt(h.slice(2,4),16), b = parseInt(h.slice(4,6),16);
    return 'rgba(' + r + ',' + g + ',' + b + ',' + alpha + ')';
  }

  function launch(inst, mode){
    if (!mode) { toast('这个 home 没有启动模式', true); return; }
    if (mode.kind === 'foreground') { openTerminal(inst); return; }
    beginBusy('正在启动 ' + inst.name + ' …');
    api('/api/start', { id: inst.id, mode: mode.id }).then(function(){
      record('启动', inst.name, true, mode.id); toast('已启动 ' + inst.name);
      return load();
    }).catch(function(err){
      var msg = err.message || '启动失败';
      if (err.data && err.data.command) msg += '；命令：' + err.data.command;
      showError('启动失败：' + msg); record('启动', inst.name, false, msg);
    }).then(endBusy);
  }
  function stopInstance(inst){
    beginBusy('正在停止 ' + inst.name + ' …');
    api('/api/stop', { id: inst.id }).then(function(){
      record('停止', inst.name, true); toast('已停止 ' + inst.name);
      return load();
    }).catch(function(err){
      showError('停止失败：' + (err.message || err)); record('停止', inst.name, false, err.message);
    }).then(endBusy);
  }
  function openTerminal(inst){
    api('/api/terminal', { id: inst.id }).then(function(data){
      record('终端', inst.name, true, data.command); toast('已打开终端：' + data.command);
    }).catch(function(err){
      showError('打开终端失败：' + (err.message || err)); record('终端', inst.name, false, err.message);
    });
  }

  function openDetail(inst, withLogs){
    state.detail = inst.id; state.logs = null;
    renderDetail(inst, withLogs);
    $('drawer').classList.add('open'); $('drawer').setAttribute('aria-hidden','false'); $('scrim').classList.add('open');
  }
  function closeDrawer(){
    $('drawer').classList.remove('open'); $('drawer').setAttribute('aria-hidden','true'); $('scrim').classList.remove('open');
    state.detail = null;
  }
  function kv(rows){
    var dl = el('dl','kv');
    for (var i=0;i<rows.length;i++){
      if (!rows[i][1]) continue;
      dl.appendChild(el('dt', null, rows[i][0]));
      dl.appendChild(el('dd', null, String(rows[i][1])));
    }
    return dl;
  }
  function renderDetail(inst, withLogs){
    $('drawer-title').textContent = inst.name;
    $('drawer-sub').textContent = hostName(hostOf(inst)) + ' · ' + (inst.attached ? 'attached' : 'managed');
    var body = $('drawer-body'); clear(body);
    var info = el('div','block');
    info.appendChild(el('h3', null, '信息'));
    info.appendChild(kv([
      ['root', inst.root],
      ['home', inst.home],
      ['pack', packText(inst)],
      ['状态', statusText(inst)],
      ['launchMode', inst.launchMode],
      ['profile', inst.profile],
      ['port', inst.port],
      ['pid', inst.pid],
      ['url', inst.url]
    ]));
    body.appendChild(info);

    var health = el('div','block');
    health.appendChild(el('h3', null, '健康'));
    var healthBox = el('div','health');
    healthBox.id = 'health-box'; healthBox.appendChild(el('span','badge','检查中…'));
    health.appendChild(healthBox); body.appendChild(health);
    loadHealth(inst);

    var actions = el('div','block');
    actions.appendChild(el('h3', null, '操作'));
    var row = el('div','actions');
    var acts = [
      ['update','更新'], ['rollback','回滚'], ['verify','验证'], ['uninstall','卸载'], ['remove','删除']
    ];
    for (var i=0;i<acts.length;i++) (function(action,label){
      var b = el('button','btn' + (action === 'remove' ? ' danger' : ''), label);
      b.type='button';
      b.addEventListener('click', function(){ homeAction(inst, action, body); });
      row.appendChild(b);
    })(acts[i][0], acts[i][1]);
    var logBtn = el('button','btn','日志'); logBtn.type='button';
    logBtn.addEventListener('click', function(){ loadLogs(inst, body); });
    row.appendChild(logBtn);
    actions.appendChild(row);
    body.appendChild(actions);

    var out = el('pre','out hidden'); out.id = 'detail-out';
    body.appendChild(out);
    if (withLogs) loadLogs(inst, body);
  }
  function setOut(body, text){
    var out = body.querySelector('#detail-out');
    if (!out) return;
    out.textContent = text || '';
    out.classList.toggle('hidden', !text);
  }
  function loadHealth(inst){
    api('/api/health?id=' + encodeURIComponent(inst.id)).then(function(data){
      var box = $('health-box'); if (!box) return;
      clear(box);
      var json = data.json || null;
      var ok = json ? (json.ok !== false) : (data.code === 0 && data.ok !== false);
      var badge = el('span','badge ' + (ok ? 'ok' : 'bad'), ok ? '正常' : '有异常');
      box.appendChild(badge);
      var findings = json && json.findings ? json.findings : [];
      if (findings.length) {
        var ul = el('ul','findings');
        for (var i=0;i<findings.length && i<12;i++){
          var f = findings[i];
          ul.appendChild(el('li', null, (f.level ? '[' + f.level + '] ' : '') + (f.message || f.code || String(f))));
        }
        box.appendChild(ul);
      } else if (!ok) {
        box.appendChild(el('span', null, data.raw ? String(data.raw).slice(0, 240) : '体检没有通过'));
      }
    }).catch(function(err){
      var box = $('health-box'); if (!box) return;
      clear(box); box.appendChild(el('span','badge bad','检查失败'));
      box.appendChild(el('span', null, err.message || ''));
    });
  }
  function homeAction(inst, action, body){
    if (action === 'remove' && !window.confirm('删除 home「' + inst.name + '」？managed 会删整根目录；attached 只摘记录。')) return;
    if (action === 'uninstall' && !window.confirm('卸载「' + inst.name + '」里装的包？目录会保留。')) return;
    var payload = { action: action, id: inst.id };
    beginBusy('正在' + action + ' ' + inst.name + ' …');
    api('/api/home-action', payload).then(function(data){
      record(action, inst.name, true, data.stdout ? String(data.stdout).slice(-300) : '');
      setOut(body, data.stdout || data.stderr || '完成');
      toast('完成：' + action + ' ' + inst.name);
      return load();
    }).catch(function(err){
      var text = (err.data && (err.data.stdout || err.data.stderr)) || err.message || '';
      setOut(body, text); showError(action + ' 失败：' + (err.message || err));
      record(action, inst.name, false, text);
    }).then(endBusy);
  }
  function loadLogs(inst, body){
    api('/api/logs?id=' + encodeURIComponent(inst.id) + '&tail=200').then(function(data){
      var old = body.querySelector('.logs-pre');
      if (old) old.parentNode.removeChild(old);
      var pre = el('pre','out logs-pre');
      var lines = data.lines || [];
      pre.textContent = lines.length ? lines.join('\\n') : '（没有日志）';
      body.appendChild(pre);
    }).catch(function(err){ setOut(body, '读取日志失败：' + (err.message || err)); });
  }

  function renderActivity(){
    var list = $('activity-list'); clear(list);
    if (!state.activity.length) { list.appendChild(el('div','hint','还没有操作。')); return; }
    for (var i=0;i<state.activity.length;i++){
      var a = state.activity[i];
      var row = el('div','act');
      row.appendChild(el('time', null, a.at.toLocaleTimeString('zh-CN', { hour12:false })));
      row.appendChild(el('span','what', a.action + ' · ' + a.target));
      row.appendChild(el('span','res' + (a.ok ? '' : ' bad'), a.ok ? '成功' : '失败'));
      list.appendChild(row);
    }
  }

  function loadHosts(){
    return api('/api/hosts').then(function(data){
      state.hosts = data.hosts || [];
      renderHostTiles();
    });
  }
  function currentHost(){
    var active = document.querySelector('.host-tile.active');
    return active ? active.dataset.id : (state.hosts[0] ? state.hosts[0].id : '');
  }
  function currentTarget(){
    var active = document.querySelector('#target-seg button.active');
    return active ? active.dataset.target : 'managed';
  }
  function renderHostTiles(){
    var box = $('host-tiles'); clear(box);
    for (var i=0;i<state.hosts.length;i++){
      var h = state.hosts[i];
      var tile = el('button','host-tile' + (i === 0 ? ' active' : ''));
      tile.type='button'; tile.dataset.id = h.id;
      tile.style.setProperty('--host', hostColor(h.id));
      tile.appendChild(el('span','mark', (HOST_NAMES[h.id] || h.id).slice(0,1).toUpperCase()));
      tile.appendChild(el('span', null, hostName(h.id)));
      tile.addEventListener('click', function(){
        var tiles = document.querySelectorAll('.host-tile');
        for (var j=0;j<tiles.length;j++) tiles[j].classList.remove('active');
        this.classList.add('active');
        syncTargetFields();
      });
      box.appendChild(tile);
    }
  }
  function syncTargetFields(){
    var target = currentTarget();
    var fields = document.querySelectorAll('[data-target-field]');
    for (var i=0;i<fields.length;i++) fields[i].classList.toggle('hidden', fields[i].dataset.targetField !== target);
    var host = currentHost();
    var profileField = document.querySelector('[data-target-field="attached"]');
    if (profileField) {
      var input = profileField.querySelector('#profile');
      if (input) input.parentNode.classList.toggle('hidden', !(host === 'dsh' && target === 'attached'));
    }
  }
  function formBody(){
    var body = { source: $('source').value.trim(), host: currentHost(), target: currentTarget() };
    if (!body.source) throw new Error('先填包来源');
    if (!body.host) throw new Error('先选宿主');
    if (body.target === 'managed') {
      if ($('name').value.trim()) body.name = $('name').value.trim();
      if ($('root').value.trim()) body.root = $('root').value.trim();
      if ($('from-home').value.trim()) body.fromHome = $('from-home').value.trim();
    } else if (body.target === 'attached') {
      if (!$('home').value.trim()) throw new Error('attached 要填已有目录');
      body.home = $('home').value.trim();
      if (body.host === 'dsh' && $('profile').value.trim()) body.profile = $('profile').value.trim();
    } else {
      if (!$('project').value.trim()) throw new Error('项目 target 要填项目目录');
      body.project = $('project').value.trim();
    }
    return body;
  }
  function runPlan(){
    var body;
    try { body = formBody(); } catch (e) { showError(e.message); return; }
    beginBusy('正在算计划 …');
    api('/api/plan', body).then(function(data){
      state.plan = data;
      renderPlan(data);
    }).catch(function(err){
      var text = (err.data && (err.data.stderr || err.data.stdout)) || err.message || '';
      $('plan').textContent = ''; var pre = el('pre','out'); pre.textContent = text || '预览失败'; $('plan').appendChild(pre);
      showError('预览失败：' + (err.message || err));
    }).then(endBusy);
  }
  function renderPlan(data){
    var box = $('plan'); clear(box);
    if (data.name) box.appendChild(el('div','plan-name', data.name));
    var plan = data.plan || {};
    var actions = plan.actions || [];
    box.appendChild(el('div','plan-sub', actions.length + ' 个动作 · 还没写盘'));
    if (actions.length) {
      var ul = el('ul','plan-list');
      for (var i=0;i<actions.length && i<80;i++){
        var a = actions[i];
        var li = el('li');
        li.appendChild(el('span','op', a.op || '?'));
        li.appendChild(el('span', null, a.path || a.to || a.resource || a.file || ''));
        ul.appendChild(li);
      }
      box.appendChild(ul);
    }
    var issues = plan.excluded || data.issues || [];
    if (issues && issues.length) {
      for (var j=0;j<issues.length && j<8;j++) {
        var it = issues[j];
        box.appendChild(el('div','issue', typeof it === 'string' ? it : (it.message || it.code || JSON.stringify(it))));
      }
    }
  }
  function runInstall(){
    var body;
    try { body = formBody(); } catch (e) { showError(e.message); return; }
    beginBusy('正在安装 …');
    api('/api/install', body).then(function(data){
      record('安装', body.source, true, data.stdout ? String(data.stdout).slice(-300) : '');
      var box = $('plan'); clear(box);
      var pre = el('pre','out'); pre.textContent = data.stdout || data.stderr || '完成'; box.appendChild(pre);
      toast('安装完成'); resetInstallForm(); return load();
    }).catch(function(err){
      var text = (err.data && (err.data.stdout || err.data.stderr)) || err.message || '';
      var box = $('plan'); clear(box); var pre = el('pre','out'); pre.textContent = text || '安装失败'; box.appendChild(pre);
      showError('安装失败：' + (err.message || err));
      record('安装', body.source, false, text);
    }).then(endBusy);
  }
  function resetInstallForm(){
    $('source').value=''; $('name').value=''; $('root').value=''; $('home').value=''; $('project').value=''; $('profile').value=''; $('from-home').value='';
    state.plan = null; clear($('plan'));
  }

  // 事件
  var tabs = document.querySelectorAll('[data-tab]');
  for (var i=0;i<tabs.length;i++) tabs[i].addEventListener('click', function(){ setTab(this.dataset.tab); });
  $('refresh').addEventListener('click', function(){ loadHosts(); load(); });
  $('top-refresh').addEventListener('click', function(){ loadHosts(); load(); });
  $('auto').addEventListener('change', function(){ state.auto = this.checked; });
  $('scrim').addEventListener('click', closeDrawer);
  $('drawer-close').addEventListener('click', closeDrawer);
  document.addEventListener('keydown', function(e){ if (e.key === 'Escape') closeDrawer(); });
  var seg = document.querySelectorAll('#target-seg button');
  for (var s=0;s<seg.length;s++) seg[s].addEventListener('click', function(){
    for (var j=0;j<seg.length;j++) seg[j].classList.remove('active');
    this.classList.add('active'); syncTargetFields();
  });
  $('preview').addEventListener('click', runPlan);
  $('install').addEventListener('click', runInstall);

  setInterval(function(){ if (state.auto && !state.busy && state.tab === 'homes') load(); }, 2000);
  var initial = location.hash.replace('#', '');
  setTab(initial === 'install' || initial === 'activity' ? initial : 'homes');
  loadHosts();
  load();
  syncTargetFields();
})();
</script>
</body>
</html>`;
