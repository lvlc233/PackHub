import { useEffect, useMemo, useState } from 'react';
import {
  api,
  type CheckResult,
  type HarnessStatus,
  type InstallOutcome,
  type PackDetail,
  type PackSummary,
  type SyncResult,
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
  const [harness, setHarness] = useState<HarnessStatus[]>([]);
  const [syncTargets, setSyncTargets] = useState<string[]>([]);
  const [syncBusy, setSyncBusy] = useState(false);
  const [syncLog, setSyncLog] = useState<SyncResult | null>(null);
  const [syncError, setSyncError] = useState<string | null>(null);

  const loadHarness = async (): Promise<void> => {
    try {
      const data = await api.harness();
      setHarness(data.targets);
      // 默认勾选服务端注册表里的全部目标；用户取消过的不在他重新加载时被强行勾回
      setSyncTargets((prev) => (prev.length > 0 ? prev : data.targets.map((t) => t.target)));
    } catch {
      setHarness([]);
    }
  };

  useEffect(() => {
    void loadHarness();
  }, []);

  const runSync = async (dryRun: boolean): Promise<void> => {
    if (!selected) return;
    if (syncTargets.length === 0) {
      setSyncError('至少选一个 harness');
      return;
    }
    setSyncBusy(true);
    setSyncError(null);
    setSyncLog(null);
    try {
      const res = await api.sync(selected, syncTargets, dryRun);
      setSyncLog(res);
      await loadHarness();
    } catch (err) {
      setSyncError((err as Error).message);
    } finally {
      setSyncBusy(false);
    }
  };

  const runRemove = async (): Promise<void> => {
    if (!selected || syncTargets.length === 0) return;
    setSyncBusy(true);
    setSyncError(null);
    setSyncLog(null);
    try {
      await api.syncRemove(selected, syncTargets);
      await loadHarness();
    } catch (err) {
      setSyncError((err as Error).message);
    } finally {
      setSyncBusy(false);
    }
  };

  const manifest = detail?.manifest ?? null;
  const plan = detail?.plan ?? null;
  const issues = (detail?.issues ?? []).filter((i) => i.severity === 'error');
  const installedKey = manifest ? `${manifest.metadata.name}@${manifest.metadata.version}` : '';
  const installed = installedKey ? detail?.state?.[installedKey] : undefined;
  const hasMcp = !!manifest && manifest.resources.some((r) => r.type === 'mcp');
  const canSync =
    !!manifest &&
    manifest.resources.length > 0 &&
    manifest.resources.every((r) => r.type === 'skill' || r.type === 'mcp');

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
      <a className="sr-only" href="#main">
        跳到主内容
      </a>
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

      <main className="main" id="main">
        {(error || actionError) && (
          <p className="alert" role="alert" aria-live="assertive">
            {actionError ?? error}
          </p>
        )}

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
                <button className="btn btn-primary" onClick={runInstall} disabled={busy !== null} aria-busy={busy === 'install'}>
                  <Icon name="download" size={16} />
                  {busy === 'install' ? '安装中…' : '安装到目录'}
                </button>
                <button className="btn btn-soft" onClick={runVerify} disabled={busy !== null} aria-busy={busy === 'verify'}>
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
              <section className="card card-alert" aria-label="问题" aria-live="polite">
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

                <section className="card" aria-label="Harness 同步">
                  <div className="card-head">
                    <h2 className="card-title">Harness 同步</h2>
                    <span className="count">全局 skills</span>
                  </div>
                  {!canSync ? (
                    <p className="hint">
                      这个包包含不能全局同步的资源。支持 skill（全部 harness）与 mcp（声明了全局 MCP 落点的 harness）；配置 /
                      知识 / 工具请用 target 安装。
                    </p>
                  ) : (
                    <>
                      <p className="hint">
                        写 skills/ 与各 home 的指令托管块；mcp 交给有 MCP 落点的 harness（TOML 托管块或宿主 CLI）。
                      </p>
                      <div className="harness-targets">
                        {harness.length === 0 && <p className="hint">读取 harness 状态…</p>}
                        {harness.map((h) => (
                          <label className="harness-target" key={h.target}>
                            <input
                              type="checkbox"
                              checked={syncTargets.includes(h.target)}
                              disabled={!h.ok || syncBusy || (hasMcp && !h.supportsMcp)}
                              onChange={(e) =>
                                setSyncTargets((prev) =>
                                  e.target.checked
                                    ? [...prev, h.target]
                                    : prev.filter((t) => t !== h.target),
                                )
                              }
                            />
                            <span className="harness-name">{h.target}</span>
                            <span className="harness-root mono" title={h.root}>
                              {h.root}
                            </span>
                            <span className={`badge ${h.ok ? 'badge-ok' : 'badge-bad'}`}>
                              {h.ok ? (h.packs.length > 0 ? `${h.packs.length} 个包` : '就绪') : '不可用'}
                            </span>
                          </label>
                        ))}
                      </div>
                      {harness.some((h) => !h.ok) && (
                        <p className="hint">
                          不可用的 harness 目录不存在；装好宿主，或用
                          {harness.filter((h) => h.homeEnv).map((h) => ` ${h.homeEnv}`).join(' /')} 指定 home。
                        </p>
                      )}
                      <div className="harness-actions">
                        <button className="btn btn-soft" onClick={() => void runSync(true)} disabled={syncBusy}>
                          预演
                        </button>
                        <button className="btn btn-primary" onClick={() => void runSync(false)} disabled={syncBusy}>
                          {syncBusy ? '同步中…' : '同步'}
                        </button>
                        <button className="btn btn-soft" onClick={() => void runRemove()} disabled={syncBusy}>
                          移除
                        </button>
                      </div>
                      {syncError && (
              <p className="alert" role="alert" aria-live="assertive">
                {syncError}
              </p>
            )}
                      {syncLog && (
                        <div className="harness-result">
                          <p className="hint mono">{syncLog.pack}</p>
                          {syncLog.results.map((r) => (
                            <div className="harness-result-row" key={r.target}>
                              <span className="harness-name">{r.target}</span>
                              <span className="mono">
                                {r.planHash ? `${r.planHash.slice(0, 18)}…` : '—'}
                              </span>
                              <span className="harness-outcomes">
                                {(r.outcomes ?? []).map((o) => (
                                  <span className={`pill pill-${o.status}`} key={o.actionId}>
                                    {STATUS_LABEL[o.status] ?? o.status}
                                  </span>
                                ))}
                                {(r.mcp ?? []).map((m) => (
                                  <span className="pill" key={`mcp-${m.id}`}>
                                    mcp {m.id} · {m.status === 'added' ? '已登记' : m.status === 'kept' ? '已在' : m.status === 'planned' ? '预演' : '已移除'}
                                  </span>
                                ))}
                                {!r.outcomes && <span className="hint">预演</span>}
                              </span>
                            </div>
                          ))}
                        </div>
                      )}
                    </>
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
