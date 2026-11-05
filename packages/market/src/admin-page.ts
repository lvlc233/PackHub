/** 市场管理前端：一个自包含页面，直接由市场进程提供；API 仍要 x-market-admin。 */
export const ADMIN_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>PackHub 市场管理</title>
<style>
  :root { color-scheme: light; --ink:#1d1d1f; --muted:#6b6b70; --line:#e6e6ea; --bg:#f7f7f8; --ok:#116b3a; --bad:#a32121; }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--ink); font:15px/1.55 -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif; }
  main { max-width: 980px; margin: 0 auto; padding: 28px 20px 60px; }
  h1 { font-size: 22px; margin: 0 0 4px; }
  .sub { color: var(--muted); margin: 0 0 18px; }
  .card { background:#fff; border:1px solid var(--line); border-radius:12px; padding:18px; margin-bottom:16px; }
  .row { display:flex; gap:10px; align-items:center; flex-wrap:wrap; }
  input { font:inherit; padding:9px 11px; border:1px solid #ccc; border-radius:8px; min-width:260px; flex:1; }
  button { font:inherit; padding:8px 14px; border-radius:8px; border:1px solid #bbb; background:#fff; cursor:pointer; }
  button.primary { background:var(--ink); color:#fff; border-color:var(--ink); }
  button.ok { color:var(--ok); border-color:#9bc7ac; }
  button.bad { color:var(--bad); border-color:#e0a9a9; }
  table { width:100%; border-collapse: collapse; }
  th, td { text-align:left; padding:8px 6px; border-bottom:1px solid var(--line); vertical-align: top; }
  th { color:var(--muted); font-weight:600; font-size:13px; }
  .muted { color:var(--muted); }
  .stats { display:grid; grid-template-columns: repeat(auto-fit,minmax(150px,1fr)); gap:12px; }
  .stat { background:var(--bg); border-radius:10px; padding:12px; }
  .stat b { display:block; font-size:22px; }
  #status { min-height:1.4em; }
  #status.err { color:var(--bad); }
  code { background:var(--bg); padding:1px 5px; border-radius:5px; }
  @media (max-width:640px){ input{min-width:0;width:100%} }
</style>
</head>
<body>
<main>
  <h1>PackHub 市场管理</h1>
  <p class="sub">审核队列、下载与评分概览。管理 token 只存在这个浏览器里，每次请求走 <code>x-market-admin</code>。</p>

  <section class="card">
    <div class="row">
      <input id="token" type="password" placeholder="管理 token" aria-label="管理 token" autocomplete="off">
      <button class="primary" id="save">保存并使用</button>
      <button id="clear">清除</button>
      <button id="rotate">轮换 token</button>
    </div>
    <p id="status" role="status" aria-live="polite" class="muted"></p>
  </section>

  <section class="card">
    <h2>概览</h2>
    <div id="stats" class="stats"></div>
  </section>

  <section class="card">
    <h2>待审队列</h2>
    <div id="queue" class="muted">先保存 token。</div>
  </section>

  <section class="card">
    <h2>最近审核</h2>
    <div id="recent" class="muted">—</div>
  </section>

  <section class="card">
    <h2>下载排行</h2>
    <div id="downloads" class="muted">—</div>
  </section>
</main>
<script>
const $ = (id) => document.getElementById(id);
let token = localStorage.getItem('packhub.market.admin') || '';
const status = (text, bad) => { const el = $('status'); el.textContent = text || ''; el.className = bad ? 'err' : 'muted'; };

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: { 'x-market-admin': token, ...(opts.body ? { 'content-type': 'application/json' } : {}), ...(opts.headers || {}) },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || ('HTTP ' + res.status));
  return body;
}

async function load() {
  if (!token) { status('还没有保存管理 token。'); return; }
  try {
    const [stats, queue] = await Promise.all([api('/api/admin/stats'), api('/api/admin/queue')]);
    renderStats(stats);
    renderQueue(queue.pending || []);
    renderRecent(stats.recent || []);
    renderDownloads(stats.downloads || []);
    status('已刷新 ' + new Date().toLocaleTimeString());
  } catch (err) { status(err.message, true); }
}

function renderStats(s) {
  $('stats').innerHTML = [
    ['账号', s.accounts], ['已索引包', s.packs], ['待审', s.pending], ['已发布版本', s.versions]
  ].map(([k, v]) => '<div class="stat"><b>' + (v ?? 0) + '</b><span class="muted">' + k + '</span></div>').join('');
}

function renderQueue(list) {
  const host = $('queue');
  if (!list.length) { host.innerHTML = '<p class="muted">队列是空的。</p>'; return; }
  host.innerHTML = '<table><thead><tr><th>包</th><th>版本</th><th>提交时间</th><th>操作</th></tr></thead><tbody>' +
    list.map((r) => '<tr><td><code>' + esc(r.name) + '</code></td><td>' + esc(r.version) + '</td><td class="muted">' + new Date(r.at).toLocaleString() + '</td><td>' +
      '<button class="ok" data-approve="' + esc(r.name) + '@' + esc(r.version) + '">批准</button> ' +
      '<button class="bad" data-reject="' + esc(r.name) + '@' + esc(r.version) + '">拒绝</button></td></tr>').join('') +
    '</tbody></table>';
}

function renderRecent(list) {
  const host = $('recent');
  if (!list.length) { host.textContent = '—'; return; }
  host.innerHTML = '<table><thead><tr><th>包</th><th>结果</th><th>时间</th><th>备注</th></tr></thead><tbody>' +
    list.map((r) => '<tr><td><code>' + esc(r.name) + '@' + esc(r.version) + '</code></td><td>' + (r.status === 'approved' ? '✓ 通过' : r.status === 'rejected' ? 'x 拒绝' : '待审') + '</td><td class="muted">' + new Date(r.at).toLocaleString() + '</td><td class="muted">' + esc(r.note || '') + '</td></tr>').join('') +
    '</tbody></table>';
}

function renderDownloads(list) {
  const host = $('downloads');
  if (!list.length) { host.textContent = '—'; return; }
  host.innerHTML = '<table><thead><tr><th>版本</th><th>下载</th></tr></thead><tbody>' +
    list.map((d) => '<tr><td><code>' + esc(d.name) + '@' + esc(d.version) + '</code></td><td>' + d.downloads + '</td></tr>').join('') +
    '</tbody></table>';
}

function esc(s) { return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c])); }

async function review(nameVersion, action) {
  const at = nameVersion.lastIndexOf('@');
  const name = nameVersion.slice(0, at);
  const version = nameVersion.slice(at + 1);
  let note;
  if (action === 'reject') { note = prompt('拒绝原因（可留空）') || undefined; }
  try {
    await api('/api/admin/review', { method: 'POST', body: JSON.stringify({ name, version, action, note }) });
    status((action === 'approve' ? '已批准 ' : '已拒绝 ') + nameVersion);
    await load();
  } catch (err) { status(err.message, true); }
}

$('save').addEventListener('click', () => {
  token = $('token').value.trim();
  if (!token) { status('token 不能为空', true); return; }
  localStorage.setItem('packhub.market.admin', token);
  load();
});
$('clear').addEventListener('click', () => { token = ''; localStorage.removeItem('packhub.market.admin'); $('token').value = ''; status('已清除本地 token。'); });
$('rotate').addEventListener('click', async () => {
  if (!token) { status('先保存现有 token。', true); return; }
  const next = prompt('新 token（至少 12 位；留空由服务端生成）');
  if (next === null) return;
  try {
    const body = await api('/api/admin/rotate', { method: 'POST', body: JSON.stringify(next ? { token: next } : {}) });
    token = body.token;
    localStorage.setItem('packhub.market.admin', token);
    $('token').value = token;
    status('token 已轮换；旧 token 已失效，记得更新部署配置。');
  } catch (err) { status(err.message, true); }
});
$('queue').addEventListener('click', (event) => {
  const el = event.target.closest('button');
  if (!el) return;
  if (el.dataset.approve) review(el.dataset.approve, 'approve');
  if (el.dataset.reject) review(el.dataset.reject, 'reject');
});
$('token').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('save').click(); });
if (token) { $('token').value = token; load(); }
</script>
</body>
</html>`;
