import { useMemo, useState } from 'react';
import { FORMS, type FormMeta } from './meta.ts';
import './forms.css';

const currentPath = (): FormMeta['id'] => {
  const m = /\/forms\/([abcd])/.exec(window.location.pathname);
  return (m?.[1] as FormMeta['id']) ?? 'b';
};

export function FormsDemo() {
  const [active, setActive] = useState<FormMeta['id']>(currentPath);

  const go = (id: FormMeta['id']) => {
    setActive(id);
    window.history.replaceState(null, '', `/forms/${id}`);
  };

  const meta = FORMS.find((f) => f.id === active)!;

  return (
    <div className="fd">
      <header className="fd-bar">
        <a className="fd-brand" href="/">
          <span className="brand-mark">P</span> PackHub
        </a>
        <nav className="fd-switch" aria-label="产品形态">
          {FORMS.map((f) => (
            <button
              key={f.id}
              className={f.id === active ? 'fd-tab is-active' : 'fd-tab'}
              onClick={() => go(f.id)}
            >
              {f.label}
            </button>
          ))}
        </nav>
        <span className="fd-note">形态对比 demo · 数据来自 examples/</span>
      </header>

      <p className="fd-caption">
        <strong>{meta.title}</strong> — {meta.blurb}
      </p>

      <div className="fd-stage">
        {active === 'a' && <FormCli />}
        {active === 'b' && <FormSite />}
        {active === 'c' && <FormApp />}
        {active === 'd' && <FormEditor />}
      </div>
    </div>
  );
}

/* ---------------- A. 命令行 ---------------- */

const CLI_SCRIPT: { cmd?: string; out?: string[]; dim?: boolean }[] = [
  {
    cmd: 'packhub search 代码审查',
    out: [
      'NAME                   VERSION  TARGETS      VERIFIED',
      'lvlc233/code-review    0.2.0    dsh, cli     ✓ 2026-11-02',
      'lvlc233/base-review    0.3.1    dsh          2026-10-18',
      'community/ts-review    0.0.9    cli          —',
    ],
  },
  { cmd: 'packhub add lvlc233/code-review', out: [] },
  {
    out: [
      '· 解析 manifest           4 个资源，全部已 pin',
      '· 能力图                  skill:code_review ← tool:repo_search',
      '计划  fetch ×2  link.skill ×1  register.mcp ×1  merge.config ×1',
      '→    .packhub/config.json, .packhub/skills/review-rules/',
    ],
  },
  { cmd: 'packhub add lvlc233/code-review --yes', out: [] },
  {
    out: [
      '✓ fetch#1        done   12 KB  sha256-CtMPyOd…',
      '✓ fetch#2        done   18 KB  sha256-3QPgfio…',
      '✓ unpack#1       done   .packhub/cache/skills/review-rules',
      '✓ link.skill#1   done   .packhub/skills/review-rules',
      '✓ register.mcp#1 done   repo-search → .packhub/config.json',
      '✓ merge.config#1 done   review.strict=true',
      '',
      'planHash sha256-2DJ8vk+izxXi/ijT3CnmDr084VXWQHxe3BeyEzUrFzY=',
      '4 步完成，0 步跳过。',
    ],
  },
];

function FormCli() {
  return (
    <div className="fd-cli">
      <div className="fd-cli-chrome">
        <span className="fd-dot" />
        <span className="fd-dot" />
        <span className="fd-dot" />
        <span className="fd-cli-title">~/work/app — packhub</span>
      </div>
      <div className="fd-cli-body">
        {CLI_SCRIPT.map((line, i) => (
          <div key={i} className="fd-cli-block">
            {line.cmd && (
              <p className="fd-cmd">
                <span className="fd-prompt">$</span> {line.cmd}
              </p>
            )}
            {line.out?.map((o, j) => (
              <p
                key={j}
                className={
                  o.startsWith('✓')
                    ? 'fd-out fd-ok'
                    : o.startsWith('→') || o.startsWith('计划')
                      ? 'fd-out fd-accent'
                      : 'fd-out'
                }
              >
                {o}
              </p>
            ))}
          </div>
        ))}
        <p className="fd-cmd">
          <span className="fd-prompt">$</span> <span className="fd-caret">▌</span>
        </p>
      </div>
    </div>
  );
}

/* ---------------- B. 目录站 ---------------- */

const SITE_PACKS = [
  {
    name: 'lvlc233/code-review',
    version: '0.2.0',
    solves: '让 Agent 按团队规范审查代码：检索 + 规范 + 报告模板，接线已做好。',
    stats: ['4 个资源', 'dsh · cli', 'verified 2026-11-02'],
    install: 'npx packhub add lvlc233/code-review',
    verified: true,
  },
  {
    name: 'lvlc233/team-conventions',
    version: '0.1.0',
    solves: '一份规范、一套提交信息模板、一个 EditorConfig 片段，装完即可引用。',
    stats: ['3 个资源', 'dsh', 'verified 2026-10-30'],
    install: 'npx packhub add lvlc233/team-conventions',
    verified: true,
  },
  {
    name: 'community/browser-ops',
    version: '0.0.9',
    solves: '浏览器自动化：Playwright MCP + 页面结构知识 + 截图规范。',
    stats: ['5 个资源', 'cli', 'community'],
    install: 'npx packhub add community/browser-ops',
    verified: false,
  },
];

function FormSite() {
  const [copied, setCopied] = useState<string | null>(null);
  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(text);
      window.setTimeout(() => setCopied(null), 1200);
    } catch {
      setCopied(null);
    }
  };

  return (
    <div className="fd-site">
      <div className="fd-site-nav">
        <span className="fd-site-logo">
          <span className="brand-mark">P</span> PackHub
        </span>
        <span className="fd-site-link is-active">发现</span>
        <span className="fd-site-link">怎么写一个 Pack</span>
        <span className="fd-site-link">验证标准</span>
        <span className="fd-site-search">搜索整合包…</span>
      </div>

      <div className="fd-site-hero">
        <h2>别人做好的整合，一行命令装进你的项目</h2>
        <p>
          每个包都写明它解决了什么、由哪些资源组成、在什么环境里验证过。
          装之前你能看到完整的安装计划，装之后能自己复核。
        </p>
      </div>

      <div className="fd-site-list">
        {SITE_PACKS.map((p) => (
          <article className="fd-pack" key={p.name}>
            <div className="fd-pack-main">
              <div className="fd-pack-head">
                <h3>{p.name}</h3>
                <span className="fd-version">v{p.version}</span>
                {p.verified ? (
                  <span className="fd-badge fd-badge-ok">✓ verified</span>
                ) : (
                  <span className="fd-badge">community</span>
                )}
              </div>
              <p className="fd-pack-solves">{p.solves}</p>
              <div className="fd-pack-stats">
                {p.stats.map((s) => (
                  <span key={s}>{s}</span>
                ))}
              </div>
            </div>
            <button className="fd-copy" onClick={() => copy(p.install)}>
              <code>{p.install}</code>
              <span>{copied === p.install ? '已复制' : '复制'}</span>
            </button>
          </article>
        ))}
      </div>

      <div className="fd-site-foot">
        <span>verified = CI 在干净容器里跑通 schema · pin · integrity · verify</span>
        <span>安装永远发生在你的机器上，网页只给命令</span>
      </div>
    </div>
  );
}

/* ---------------- C. 桌面启动器 ---------------- */

function FormApp() {
  return (
    <div className="fd-app">
      <div className="fd-window">
        <div className="fd-window-bar">
          <span className="fd-dot fd-dot-r" />
          <span className="fd-dot fd-dot-y" />
          <span className="fd-dot fd-dot-g" />
          <span className="fd-window-title">PackHub</span>
        </div>
        <div className="fd-window-body">
          <aside className="fd-app-side">
            <p className="fd-app-side-title">我的项目</p>
            <div className="fd-project is-active">
              <span className="fd-project-name">work/app</span>
              <span className="fd-project-meta">3 个包 · 已同步</span>
            </div>
            <div className="fd-project">
              <span className="fd-project-name">work/docs-site</span>
              <span className="fd-project-meta">1 个包</span>
            </div>
            <p className="fd-app-side-title">可用整合包</p>
            <div className="fd-app-entry">
              <span>代码审查</span>
              <span className="fd-badge fd-badge-ok">已装</span>
            </div>
            <div className="fd-app-entry">
              <span>团队约定</span>
              <span className="fd-badge fd-badge-ok">已装</span>
            </div>
            <div className="fd-app-entry">
              <span>浏览器操作</span>
              <span className="fd-badge">可安装</span>
            </div>
          </aside>

          <div className="fd-app-main">
            <div className="fd-app-head">
              <div>
                <h3>代码审查整合包</h3>
                <p>lvlc233/code-review · 4 个资源 · verified</p>
              </div>
              <button className="fd-app-btn">安装到 work/app</button>
            </div>

            <div className="fd-app-card">
              <p className="fd-app-card-title">安装进度</p>
              <div className="fd-progress">
                <span style={{ width: '72%' }} />
              </div>
              <p className="fd-app-step">正在挂载 skill：.packhub/skills/review-rules</p>
            </div>

            <div className="fd-app-card">
              <p className="fd-app-card-title">这个包会写这些文件</p>
              <ul className="fd-app-files">
                <li>.packhub/skills/review-rules/</li>
                <li>.packhub/knowledge/style-guide.md</li>
                <li>.packhub/config.json（合并 review.strict）</li>
              </ul>
            </div>

            <div className="fd-app-actions">
              <button className="fd-app-btn fd-app-btn-ghost">看安装计划</button>
              <button className="fd-app-btn fd-app-btn-ghost">卸载</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ---------------- D. 可视化编辑器 ---------------- */

const NODES = [
  { id: 'repo-search', x: 40, y: 70, type: 'mcp', label: 'repo-search', sub: 'MCP · npm' },
  { id: 'review-rules', x: 330, y: 50, type: 'skill', label: 'review-rules', sub: 'Skill · github' },
  { id: 'house-style', x: 330, y: 240, type: 'knowledge', label: 'house-style', sub: '知识 · https' },
  { id: 'agent-config', x: 40, y: 300, type: 'config', label: 'agent-config', sub: '配置 · merge' },
];

function FormEditor() {
  const [selected, setSelected] = useState('review-rules');
  const active = useMemo(() => NODES.find((n) => n.id === selected)!, [selected]);

  return (
    <div className="fd-editor">
      <div className="fd-editor-bar">
        <span className="fd-editor-name">lvlc233/code-review</span>
        <span className="fd-editor-hint">未保存</span>
        <button className="fd-app-btn fd-app-btn-ghost">校验图</button>
        <button className="fd-app-btn">生成 Pack</button>
      </div>

      <div className="fd-editor-body">
        <aside className="fd-palette">
          <p className="fd-app-card-title">资源</p>
          {['mcp', 'skill', 'prompt', 'knowledge', 'config', 'tool'].map((t) => (
            <div className="fd-palette-item" key={t}>
              <span className={`fd-type fd-type-${t}`}>{t}</span>
              <span>拖到画布</span>
            </div>
          ))}
        </aside>

        <div className="fd-canvas"><div className="fd-board">
          <svg className="fd-wires" viewBox="0 0 900 500">
            <path d="M184 90 L330 70" />
            <path d="M184 90 L330 260" />
            <path d="M184 320 L330 70" strokeDasharray="3 3" />
          </svg>

          {NODES.map((n) => (
            <button
              key={n.id}
              className={n.id === selected ? 'fd-node is-active' : 'fd-node'}
              style={{ left: n.x, top: n.y }}
              onClick={() => setSelected(n.id)}
            >
              <span className={`fd-type fd-type-${n.type}`}>{n.type}</span>
              <span className="fd-node-main">
                <strong>{n.label}</strong>
                <small>{n.sub}</small>
              </span>
            </button>
          ))}

          <span className="fd-canvas-hint">拖拽资源到画布 · 连线的两端是 provides / needs</span>
          </div>
        </div>

        <aside className="fd-inspector">
          <p className="fd-app-card-title">属性</p>
          <label className="fd-field">
            <span>id</span>
            <input readOnly value={active.label} />
          </label>
          <label className="fd-field">
            <span>来源</span>
            <input readOnly value={active.sub} />
          </label>
          <label className="fd-field">
            <span>provides</span>
            <input readOnly value={active.id === 'review-rules' ? 'skill:code_review' : '—'} />
          </label>
          <label className="fd-field">
            <span>needs</span>
            <input readOnly value={active.id === 'review-rules' ? 'tool:repo_search' : '—'} />
          </label>
          <p className="fd-inspector-note">
            连线 = 能力依赖。生成 Pack 时，这条线会变成 manifest 里的 needs / provides 与安装顺序。
          </p>
        </aside>
      </div>
    </div>
  );
}
