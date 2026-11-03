import { useMemo, useState } from 'react';
import {
  api,
  type CheckResult,
  type InstallOutcome,
  type PackDetail,
  type PackSummary,
} from './api.ts';
import { Icon } from './Icon.tsx';
import { usePack } from './usePack.ts';

const OP_LABEL: Record<string, string> = {
  fetch: '取回资源',
  unpack: '解压归档',
  write: '写入文件',
  'link.skill': '挂载 skill',
  'register.mcp': '登记 MCP',
  'merge.config': '合并配置',
  exec: '执行命令',
};

const STATUS_LABEL: Record<string, string> = {
  done: '已完成',
  noop: '无需改动',
  skipped: '已跳过',
  failed: '失败',
  'needs-approval': '待批准',
  pass: '通过',
  fail: '未通过',
};

const TYPE_LABEL: Record<string, string> = {
  mcp: 'MCP',
  skill: 'Skill',
  prompt: 'Prompt',
  knowledge: '知识',
  config: '配置',
  tool: '工具',
};

function targetOf(a: { to?: string; dest?: string; path?: string }): string {
  return a.to ?? a.dest ?? a.path ?? '';
}

export function App() {
  const { packs, root, selected, setSelected, detail, lastOutcomes, loading, error, refresh } =
    usePack();
  const [busy, setBusy] = useState<'install' | 'verify' | null>(null);
  const [outcomes, setOutcomes] = useState<InstallOutcome[] | null>(null);
  const [checks, setChecks] = useState<CheckResult[] | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const manifest = detail?.manifest ?? null;
  const plan = detail?.plan ?? null;
  const issues = (detail?.issues ?? []).filter((i) => i.severity === 'error');
  const installedKey = manifest ? `${manifest.metadata.name}@${manifest.metadata.version}` : '';
  const installed = installedKey ? detail?.state?.[installedKey] : undefined;

  const statusOf = useMemo(() => {
    const map = new Map<string, InstallOutcome>();
    for (const o of outcomes ?? lastOutcomes ?? []) map.set(o.actionId, o);
    return map;
  }, [outcomes, lastOutcomes]);

  const runInstall = async () => {
    if (!selected) return;
    setBusy('install');
    setActionError(null);
    try {
      const res = await api.install(selected);
      setOutcomes(res.outcomes);
      await refresh();
    } catch (err) {
      setActionError((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const runVerify = async () => {
    if (!selected) return;
    setBusy('verify');
    setActionError(null);
    try {
      const res = await api.verify(selected);
      setChecks(res.results);
    } catch (err) {
      setActionError((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const copyHash = async () => {
    if (!plan) return;
    try {
      await navigator.clipboard.writeText(plan.planHash);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    } catch {
      setCopied(false);
    }
  };

  const doneCount = (outcomes ?? lastOutcomes ?? []).filter(
    (o) => o.status === 'done' || o.status === 'noop',
  ).length;
  const stepTotal = plan?.actions.length ?? 0;

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">P</span>
          <span className="brand-name">PackHub</span>
          <span className="brand-version">0.0.1</span>
        </div>

        <p className="repo" title={root}>
          <Icon name="folder" size={13} />
          {root || '—'}
        </p>

        <nav className="packs" aria-label="整合包">
          {packs.map((p) => (
            <PackCard
              key={p.dir}
              pack={p}
              active={p.dir === selected}
              onSelect={() => {
                setSelected(p.dir);
                setOutcomes(null);
                setChecks(null);
                setExpanded(null);
              }}
            />
          ))}
          {!loading && packs.length === 0 && (
            <p className="empty">在仓库根、examples/ 或 packs/ 下没找到 packhub.yaml</p>
          )}
        </nav>

        <p className="sidebar-foot">判断都在内核里，这里只是门面</p>
      </aside>

      <main className="main">
        {(error || actionError) && <p className="alert">{actionError ?? error}</p>}

        {!detail && loading && <div className="skeleton" />}

        {detail && manifest && (
          <>
            <header className="hero">
              <div className="hero-copy">
                <h1>{manifest.metadata.title || manifest.metadata.name}</h1>
                <p className="lede">{manifest.metadata.description}</p>
                <div className="tags">
                  <span className="tag tag-mono">{manifest.metadata.name}</span>
                  <span className="tag">v{manifest.metadata.version}</span>
                  {manifest.metadata.targets.map((t) => (
                    <span className="tag tag-quiet" key={t}>
                      → {t}
                    </span>
                  ))}
                </div>
              </div>
              <div className="hero-actions">
                <button className="btn btn-primary" onClick={runInstall} disabled={busy !== null}>
                  <Icon name="download" size={16} />
                  {busy === 'install' ? '安装中…' : '安装到目录'}
                </button>
                <button className="btn btn-soft" onClick={runVerify} disabled={busy !== null}>
                  <Icon name="check" size={16} />
                  {busy === 'verify' ? '校验中…' : '运行校验'}
                </button>
              </div>
            </header>

            <div className="meta-row">
              <button className="hash" onClick={copyHash} title="点击复制 planHash">
                <Icon name="hash" size={13} />
                <span className="hash-value">{plan?.planHash ?? '—'}</span>
                <span className="hash-copy">{copied ? '已复制' : '复制'}</span>
              </button>
              <span className="meta-sep" />
              <span className="meta-item">{stepTotal} 步安装</span>
              <span className="meta-item">{plan?.verify.length ?? 0} 项校验</span>
              {installed && <span className="badge badge-ok">已安装</span>}
            </div>

            {issues.length > 0 && (
              <section className="card card-alert" aria-label="问题">
                <h2 className="card-title">
                  <Icon name="alert" size={16} /> 拦住安装的问题
                </h2>
                <ul className="issue-list">
                  {issues.map((e, i) => (
                    <li key={`${e.code}-${i}`}>
                      <code>{e.code}</code>
                      <span>{e.message}</span>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            <div className="columns">
              <div className="col">
                <section className="card" aria-label="组成">
                  <div className="card-head">
                    <h2 className="card-title">组成</h2>
                    <span className="count">{manifest.resources.length}</span>
                  </div>
                  <ul className="resource-list">
                    {manifest.resources.map((r) => {
                      const [source, pin] = splitSource(r.source);
                      const open = expanded === r.id;
                      return (
                        <li key={r.id} className={open ? 'resource is-open' : 'resource'}>
                          <button
                            className="resource-row"
                            onClick={() => setExpanded(open ? null : r.id)}
                            aria-expanded={open}
                          >
                            <span className={`type-dot type-${r.type}`}>
                              <Icon name={r.type} size={15} />
                            </span>
                            <span className="resource-main">
                              <span className="resource-name">{r.id}</span>
                              <span className="resource-sub">
                                {TYPE_LABEL[r.type] ?? r.type}
                                {pin && <span className="pin">{pin}</span>}
                              </span>
                            </span>
                            <Icon name={open ? 'chevron-up' : 'chevron-down'} size={16} />
                          </button>
                          {open && (
                            <div className="resource-detail">
                              <p className="detail-line" title={r.source}>
                                <span className="detail-key">来源</span>
                                <span className="mono">{source}</span>
                              </p>
                              {r.transport && (
                                <p className="detail-line">
                                  <span className="detail-key">传输</span>
                                  <span className="mono">{r.transport}</span>
                                </p>
                              )}
                              {((r.provides ?? []).length > 0 || (r.needs ?? []).length > 0) && (
                                <div className="detail-line">
                                  <span className="detail-key">能力</span>
                                  <span className="chips">
                                    {(r.provides ?? []).map((c) => (
                                      <span className="chip chip-give" key={c}>
                                        {c}
                                      </span>
                                    ))}
                                    {(r.needs ?? []).map((c) => (
                                      <span className="chip chip-need" key={c}>
                                        需要 {c}
                                      </span>
                                    ))}
                                  </span>
                                </div>
                              )}
                            </div>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                </section>

                <section className="card" aria-label="校验">
                  <div className="card-head">
                    <h2 className="card-title">校验</h2>
                    <span className="count">{checks?.length ?? plan?.verify.length ?? 0}</span>
                  </div>
                  <ul className="check-list">
                    {(checks ?? plan?.verify ?? []).map((c, i) => {
                      const r = checks?.[i];
                      const status = r?.status;
                      return (
                        <li key={i} data-status={status ?? 'pending'}>
                          <span className={`pill pill-${status ?? 'pending'}`}>
                            {status ? STATUS_LABEL[status] : '未运行'}
                          </span>
                          <span className="check-body">
                            <span className="check-type">{c.type}</span>
                            {r?.detail && <span className="check-detail mono">{r.detail}</span>}
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                  {checks === null && <p className="hint">校验只读：不写文件、不联网。</p>}
                </section>
              </div>

              <div className="col">
                <section className="card" aria-label="安装计划">
                  <div className="card-head">
                    <h2 className="card-title">安装计划</h2>
                    <span className="count">
                      {doneCount}/{stepTotal}
                    </span>
                  </div>
                  <ol className="steps">
                    {(plan?.actions ?? []).map((a, i) => {
                      const o = statusOf.get(a.actionId);
                      const status = o?.status ?? 'pending';
                      return (
                        <li key={a.actionId} data-status={status}>
                          <span className="step-dot" aria-hidden="true" />
                          <span className="step-body">
                            <span className="step-op">{OP_LABEL[a.op] ?? a.op}</span>
                            <span className="step-target mono" title={targetOf(a)}>
                              {targetOf(a) || a.resource || ''}
                            </span>
                          </span>
                          <span className={`pill pill-${status}`}>
                            {o ? STATUS_LABEL[status] : '待执行'}
                          </span>
                          <span className="step-index" aria-hidden="true">
                            {i + 1}
                          </span>
                        </li>
                      );
                    })}
                  </ol>
                  {outcomes === null && lastOutcomes === null && (
                    <p className="hint">点「安装到目录」后，这里会逐步显示结果。</p>
                  )}
                </section>

                <section className="card" aria-label="本机状态">
                  <div className="card-head">
                    <h2 className="card-title">本机状态</h2>
                  </div>
                  <p className="state-line">
                    <span className="state-dot" data-on={installed ? 'true' : 'false'} />
                    {installed ? '已装在这台机器上' : '尚未安装'}
                  </p>
                  {installed ? (
                    <>
                      <p className="hint">
                        {localTime(installed.installedAt)}
                        {installed.planHash === plan?.planHash
                          ? ' · 与当前计划一致'
                          : ' · 计划已变化'}
                      </p>
                      <ul className="file-list">
                        {(installed.written ?? []).slice(0, 8).map((w) => (
                          <li key={w} className="mono" title={w}>
                            {w}
                          </li>
                        ))}
                      </ul>
                    </>
                  ) : (
                    <p className="hint">安装后这里会列出实际写入的文件。</p>
                  )}
                </section>
              </div>
            </div>
          </>
        )}
      </main>
    </div>
  );
}

function PackCard({
  pack,
  active,
  onSelect,
}: {
  pack: PackSummary;
  active: boolean;
  onSelect: () => void;
}) {
  const installed = pack.installedHash && pack.installedHash === pack.planHash;
  return (
    <button className={active ? 'pack is-active' : 'pack'} onClick={onSelect} aria-current={active}>
      <span className="pack-title">{pack.title || pack.name}</span>
      <span className="pack-sub">{pack.name}</span>
      <span className="pack-foot">
        <span>v{pack.version}</span>
        <span>{pack.resourceCount} 项</span>
        {installed && <span className="badge badge-ok">已装</span>}
        {pack.errors > 0 && <span className="badge badge-bad">{pack.errors} 错误</span>}
      </span>
    </button>
  );
}

function splitSource(source: string): [string, string | null] {
  const i = source.lastIndexOf('@');
  if (i > 0) return [source.slice(0, i), source.slice(i)];
  return [source, null];
}

function localTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getMonth() + 1} 月 ${d.getDate()} 日 ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export type { PackDetail };
