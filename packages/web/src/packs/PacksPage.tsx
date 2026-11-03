import { useEffect, useState } from 'react';
import './packs.css';

interface IndexEntry {
  name: string;
  title: string;
  description: string;
  latest: string;
  versions: string[];
  targets: string[];
  trust: 'verified' | 'community';
  verifiedAt: string | null;
  keywords: string[];
  resourceCount: number;
  install: string;
}

interface Index {
  apiVersion: string;
  generatedAt: string;
  packs: IndexEntry[];
}

interface PackDetail {
  name: string;
  version: string;
  manifest: string;
  verify: {
    ok: boolean;
    planHash: string;
    verifiedAt: string;
    checks: { index: number; type: string; status: string; detail: string }[];
    outcomes: { actionId: string; op: string; status: string }[];
  } | null;
}

const date = (iso: string | null): string =>
  iso ? new Date(iso).toLocaleDateString('zh-CN') : '—';

export function PacksPage({ name }: { name?: string }) {
  if (name) return <PackDetailPage name={name} />;
  return <PackListPage />;
}

function PackListPage() {
  const [index, setIndex] = useState<Index | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/registry')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error('还没有 registry/index.json'))))
      .then(setIndex)
      .catch((e: Error) => setError(e.message));
  }, []);

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
    <div className="pk">
      <header className="pk-nav">
        <a className="pk-brand" href="/">
          <span className="brand-mark">P</span> PackHub
        </a>
        <a className="pk-link is-active" href="/packs">
          发现
        </a>
        <a className="pk-link" href="/docs/authoring.md">
          怎么写一个 Pack
        </a>
        <span className="pk-spacer" />
        <span className="pk-meta">
          {index ? `${index.packs.length} 个包 · 索引 ${date(index.generatedAt)}` : '读取索引…'}
        </span>
      </header>

      {error && <p className="pk-error">{error}</p>}

      <section className="pk-hero">
        <h1>别人做好的整合，一行命令装进你的项目</h1>
        <p>
          每个包都写明它解决了什么、由哪些资源组成、在什么环境里验证过。装之前能看到完整的安装计划，装之后能自己复核。
        </p>
      </section>

      <div className="pk-list">
        {(index?.packs ?? []).map((p) => (
          <article className="pk-card" key={p.name}>
            <div className="pk-card-main">
              <div className="pk-card-head">
                <a className="pk-name" href={`/packs/${p.name}`}>
                  {p.name}
                </a>
                <span className="pk-version">v{p.latest}</span>
                {p.trust === 'verified' ? (
                  <span className="pk-badge ok">✓ verified · {date(p.verifiedAt)}</span>
                ) : (
                  <span className="pk-badge">community</span>
                )}
              </div>
              <p className="pk-desc">{p.description}</p>
              <div className="pk-stats">
                <span>{p.resourceCount} 个资源</span>
                <span>{p.targets.join(' · ')}</span>
                {p.keywords.slice(0, 3).map((k) => (
                  <span key={k}>#{k}</span>
                ))}
              </div>
            </div>
            <button className="pk-copy" onClick={() => copy(p.install)}>
              <code>{p.install}</code>
              <span>{copied === p.install ? '已复制' : '复制'}</span>
            </button>
          </article>
        ))}
        {index && index.packs.length === 0 && <p className="pk-empty">索引是空的。</p>}
      </div>

      <footer className="pk-foot">
        <span>verified = CI 在干净容器里跑通 schema · pin · integrity · verify</span>
        <span>安装永远发生在你的机器上，网页只给命令</span>
      </footer>
    </div>
  );
}

function PackDetailPage({ name }: { name: string }) {
  const [detail, setDetail] = useState<PackDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    fetch(`/api/registry/pack?name=${encodeURIComponent(name)}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error('没有这个包'))))
      .then(setDetail)
      .catch((e: Error) => setError(e.message));
  }, [name]);

  const install = `npx packhub add ${name}`;
  const copy = async () => {
    await navigator.clipboard.writeText(install).catch(() => {});
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1200);
  };

  return (
    <div className="pk">
      <header className="pk-nav">
        <a className="pk-brand" href="/">
          <span className="brand-mark">P</span> PackHub
        </a>
        <a className="pk-link" href="/packs">
          ← 全部整合包
        </a>
      </header>

      {error && <p className="pk-error">{error}</p>}

      {detail && (
        <>
          <section className="pk-hero">
            <h1>{name}</h1>
            <p>
              v{detail.version}
              {detail.verify?.ok ? ` · verified ${date(detail.verify.verifiedAt)}` : ' · community'}
            </p>
            <button className="pk-install" onClick={copy}>
              <code>{install}</code>
              <span>{copied ? '已复制' : '复制命令'}</span>
            </button>
          </section>

          <div className="pk-panels">
            <section className="pk-panel">
              <h2>清单</h2>
              <pre>{detail.manifest}</pre>
            </section>

            <section className="pk-panel">
              <h2>验证报告</h2>
              {detail.verify ? (
                <>
                  <p className={detail.verify.ok ? 'pk-ok' : 'pk-bad'}>
                    {detail.verify.ok ? '通过' : '未通过'} · planHash {detail.verify.planHash.slice(0, 18)}…
                  </p>
                  <ul className="pk-checks">
                    {detail.verify.checks.map((c) => (
                      <li key={c.index}>
                        <span className={`pk-dot ${c.status}`} />
                        {c.type}
                        <em>{c.detail}</em>
                      </li>
                    ))}
                  </ul>
                  <p className="pk-hint">
                    装完后跑 <code>packhub verify</code>，应得到同一份 planHash。
                  </p>
                </>
              ) : (
                <p className="pk-hint">这个版本没有验证报告，只能按 community 对待。</p>
              )}
            </section>
          </div>
        </>
      )}
    </div>
  );
}


