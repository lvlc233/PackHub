import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import {
  api,
  type CheckResult,
  type InstallOutcome,
  type PackDetail,
  type PackSummary,
} from './api.ts';

const OP_LABEL: Record<string, string> = {
  fetch: '取回',
  unpack: '解包',
  write: '写入',
  'link.skill': '挂载 skill',
  'register.mcp': '登记 MCP',
  'merge.config': '合并配置',
  exec: '执行命令',
};

const STATUS_LABEL: Record<string, string> = {
  done: '完成',
  noop: '无需改动',
  skipped: '跳过',
  failed: '失败',
  'needs-approval': '待批准',
  pass: '通过',
  fail: '未通过',
};

function targetOf(a: { to?: string; dest?: string; path?: string }): string {
  return a.to ?? a.dest ?? a.path ?? '';
}

function splitSource(source: string): [string, string | null] {
  const i = source.lastIndexOf('@');
  if (i > 0) return [source.slice(0, i), source.slice(i)];
  return [source, null];
}

/** 面板只做展示用的 ${vars.x} 替换；真正的求值在内核里。 */
function resolveVars(text: string, vars: Record<string, unknown> = {}): string {
  return text.replace(/\$\{vars\.([^}]+)\}/g, (whole, key: string) =>
    key in vars ? String(vars[key]) : whole,
  );
}

function localTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function App() {
  const [packs, setPacks] = useState<PackSummary[]>([]);
  const [root, setRoot] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<PackDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<'install' | 'verify' | null>(null);
  const [outcomes, setOutcomes] = useState<InstallOutcome[] | null>(null);
  const [checks, setChecks] = useState<CheckResult[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [stamped, setStamped] = useState(false);

  const refreshPacks = useCallback(async () => {
    const res = await api.packs();
    setRoot(res.root);
    setPacks(res.packs);
    setSelected((cur) => cur ?? res.packs[0]?.dir ?? null);
  }, []);

  useEffect(() => {
    refreshPacks()
      .catch((err: Error) => setError(err.message))
      .finally(() => setLoading(false));
  }, [refreshPacks]);

  useEffect(() => {
    if (!selected) return;
    setOutcomes(null);
    setChecks(null);
    setDetail(null);
    api
      .pack(selected)
      .then((d) => {
        setDetail(d);
        // 上次安装的结果从 state 回填：面板打开时运行单就该反映磁盘上的事实
        const key = d.manifest
          ? `${d.manifest.metadata.name}@${d.manifest.metadata.version}`
          : '';
        const prev = key ? d.state?.[key] : undefined;
        if (prev && Array.isArray(prev.actions)) setOutcomes(prev.actions);
      })
      .catch((err: Error) => setError(err.message));
  }, [selected]);

  const runInstall = async () => {
    if (!selected) return;
    setBusy('install');
    setError(null);
    try {
      const res = await api.install(selected);
      setOutcomes(res.outcomes);
      setStamped(true);
      window.setTimeout(() => setStamped(false), 1700);
      await refreshPacks();
      setDetail(await api.pack(selected));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const runVerify = async () => {
    if (!selected) return;
    setBusy('verify');
    setError(null);
    try {
      const res = await api.verify(selected);
      setChecks(res.results);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const manifest = detail?.manifest ?? null;
  const plan = detail?.plan ?? null;
  const errors = useMemo(
    () => (detail?.issues ?? []).filter((i) => i.severity === 'error'),
    [detail],
  );
  const statusOf = useMemo(() => {
    const map = new Map<string, InstallOutcome>();
    for (const o of outcomes ?? []) map.set(o.actionId, o);
    return map;
  }, [outcomes]);

  const vars = Object.entries(manifest?.vars ?? {});
  const env = Object.entries(manifest?.composition?.env ?? {});
  const order = manifest?.composition?.order ?? [];
  const installedKey = manifest ? `${manifest.metadata.name}@${manifest.metadata.version}` : '';
  const installed = installedKey ? detail?.state?.[installedKey] : undefined;
  const installedFresh = installed?.planHash === plan?.planHash;

  return (
    <div className="shell">
      <aside className="rail">
        <div className="mark">
          PackHub<span className="mark-tag">0.0.1</span>
        </div>
        <p className="rail-root" title={root}>
          仓库 · {root || '—'}
        </p>

        <nav className="pack-list" aria-label="整合包">
          {packs.map((p, i) => {
            const active = p.dir === selected;
            const isInstalled = p.installedHash && p.installedHash === p.planHash;
            return (
              <button
                key={p.dir}
                className={active ? 'pack-row is-active' : 'pack-row'}
                aria-current={active ? 'true' : undefined}
                onClick={() => setSelected(p.dir)}
              >
                <span className="pack-index">{String(i + 1).padStart(2, '0')}</span>
                <span className="pack-body">
                  <span className="pack-name">{p.title || p.name}</span>
                  <span className="pack-meta">{p.name}</span>
                  <span className="pack-stats">
                    v{p.version} · {p.resourceCount} 资源
                    {isInstalled ? ' · 已装' : ''}
                    {p.errors > 0 ? ` · ${p.errors} 错误` : ''}
                  </span>
                </span>
              </button>
            );
          })}
          {!loading && packs.length === 0 && <p className="rail-empty">没有找到 packhub.yaml</p>}
        </nav>

        <div className="rail-foot">
          plan → install → verify
          <span>判断都在内核里，这个面板只负责呈现</span>
        </div>
      </aside>

      <main className="board">
        {error && (
          <p className="banner" role="alert">
            {error}
          </p>
        )}

        {!detail && loading && <p className="loading">读取仓库…</p>}

        {detail && manifest && (
          <>
            <header className={stamped ? 'ticket is-stamped' : 'ticket'}>
              <div className="ticket-main">
                <h1>{manifest.metadata.title || manifest.metadata.name}</h1>
                <p className="ticket-sub">{manifest.metadata.description}</p>
                <div className="chips">
                  <span className="chip chip-strong">{manifest.metadata.name}</span>
                  <span className="chip chip-accent">v{manifest.metadata.version}</span>
                  {manifest.metadata.targets.map((t) => (
                    <span className="chip" key={t}>
                      {t}
                    </span>
                  ))}
                </div>
              </div>

              <div className="ticket-act">
                <button className="btn btn-accent" onClick={runInstall} disabled={busy !== null}>
                  {busy === 'install' ? '安装中…' : '安装到目录'}
                </button>
                <button className="btn btn-ghost" onClick={runVerify} disabled={busy !== null}>
                  {busy === 'verify' ? '校验中…' : '运行校验'}
                </button>
              </div>

              <p className="ticket-serial">
                <span className="serial-label">planHash</span>
                <code>{plan?.planHash ?? '—'}</code>
                <span className="serial-count">
                  {plan?.actions.length ?? 0} 个动作 · {plan?.verify.length ?? 0} 项校验
                </span>
              </p>
            </header>

            {errors.length > 0 && (
              <section className="issues" aria-label="问题">
                <h2>拦住安装的问题</h2>
                <ul>
                  {errors.map((e, i) => (
                    <li key={`${e.code}-${i}`}>
                      <code>{e.code}</code>
                      <span>{e.message}</span>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            <div className="bench">
              <section className="bom" aria-label="物料清单">
                <h2>
                  物料清单 <span className="count">{manifest.resources.length} 项</span>
                </h2>
                <table>
                  <thead>
                    <tr>
                      <th scope="col" className="col-type">
                        类型
                      </th>
                      <th scope="col" className="col-id">
                        id
                      </th>
                      <th scope="col">来源 · 能力</th>
                    </tr>
                  </thead>
                  <tbody>
                    {manifest.resources.map((r) => {
                      const [head, pin] = splitSource(r.source);
                      return (
                        <tr key={r.id}>
                          <td className="col-type">
                            <span className="type">{r.type}</span>
                          </td>
                          <td className="col-id mono">{r.id}</td>
                          <td>
                            <span className="src" title={`${head}${pin ?? ''}`}>
                              {head}
                            </span>
                            {pin && <span className="pin">{pin}</span>}
                            {((r.provides ?? []).length > 0 || (r.needs ?? []).length > 0) && (
                              <span className="caps">
                                {(r.provides ?? []).map((c) => (
                                  <span className="cap" key={c}>
                                    {c}
                                  </span>
                                ))}
                                {(r.needs ?? []).map((c) => (
                                  <span className="cap cap-need" key={c}>
                                    ⇠ {c}
                                  </span>
                                ))}
                              </span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </section>

              <section className="checks" aria-label="校验">
                <h2>
                  校验 <span className="count">{checks?.length ?? plan?.verify.length ?? 0} 项</span>
                </h2>
                <ul>
                  {(checks ?? plan?.verify ?? []).map((c, i) => {
                    const r = checks?.[i];
                    const status = r?.status;
                    return (
                      <li key={i} className={status ? `is-${status}` : undefined}>
                        <span className="idx">{String(i + 1).padStart(2, '0')}</span>
                        <span className="body">
                          <span className="op">{c.type}</span>
                          {r?.detail && <span className="tgt mono">{r.detail}</span>}
                        </span>
                        <span className="st">{status ? STATUS_LABEL[status] : '未运行'}</span>
                      </li>
                    );
                  })}
                </ul>
                {checks === null && <p className="note">校验只读：不写文件、不联网。</p>}
              </section>

              <aside className="execute" aria-label="运行单">
                <h2>
                  运行单 <span className="count">{plan?.actions.length ?? 0} 步</span>
                </h2>
                <ol>
                  {(plan?.actions ?? []).map((a, i) => {
                    const o = statusOf.get(a.actionId);
                    return (
                      <li key={a.actionId} className={o ? `is-${o.status}` : undefined}>
                        <span className="idx">{String(i + 1).padStart(2, '0')}</span>
                        <span className="body">
                          <span className="op">{OP_LABEL[a.op] ?? a.op}</span>
                          <span className="tgt mono" title={targetOf(a)}>
                            {targetOf(a) || a.resource || ''}
                          </span>
                          <span className="act mono">{a.actionId}</span>
                        </span>
                        <span className="st">{o ? STATUS_LABEL[o.status] : '待执行'}</span>
                      </li>
                    );
                  })}
                </ol>
                {outcomes === null && (
                  <p className="exec-note">点「安装到目录」后，这里逐条落下执行结果。</p>
                )}
              </aside>
            </div>

            <footer className="status">
              <div className="footer-block wiring" aria-label="接线与环境">
                <h3>接线与环境</h3>
                <dl>
                  <dt>target</dt>
                  <dd>{plan?.target ?? '—'}</dd>
                  {vars.map(([k, v]) => (
                    <Fragment key={`v-${k}`}>
                      <dt>var · {k}</dt>
                      <dd>{String(v)}</dd>
                    </Fragment>
                  ))}
                  {env.map(([k, v]) => (
                    <Fragment key={`e-${k}`}>
                      <dt>env · {k}</dt>
                      <dd title={String(v)}>{resolveVars(String(v), manifest.vars)}</dd>
                    </Fragment>
                  ))}
                  {order.length > 0 && (
                    <>
                      <dt>顺序</dt>
                      <dd>{order.join(' → ')}</dd>
                    </>
                  )}
                </dl>
              </div>

              <div className="footer-block" aria-label="本机状态">
                <h3>本机状态</h3>
                <p className="state-line">
                  {installed
                    ? installedFresh
                      ? '已装，且与当前计划一致'
                      : '已装，但计划已变化'
                    : '尚未安装'}
                  {installed && (
                    <span className="state-time mono">{localTime(installed.installedAt)}</span>
                  )}
                </p>
                {installed?.written && installed.written.length > 0 ? (
                  <ul className="written">
                    {installed.written.slice(0, 8).map((w) => (
                      <li key={w} className="mono" title={w}>
                        {w}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="note">安装后这里会列出实际落盘的文件。</p>
                )}
              </div>
            </footer>
          </>
        )}
      </main>
    </div>
  );
}
