import { useEffect, useMemo, useState } from 'react';
import './console.css';

interface PackEntry {
  name: string;
  latest: string;
  title: string;
  description: string;
  trust: string;
  targets: string[];
}

interface ResourceInfo {
  id: string;
  type: string;
  source: string;
  slot?: string;
  provides?: string[];
}

interface PackResources {
  name: string;
  version: string;
  meta: { title?: string; description?: string; targets: string[]; keywords?: string[] };
  resources: ResourceInfo[];
}

interface Favorite extends ResourceInfo {
  pack: string;
  version: string;
}

interface Draft extends ResourceInfo {
  key: string;
}

interface Issue {
  code: string;
  severity: string;
  message: string;
}

interface Plan {
  actions: { actionId: string; op: string; to?: string; dest?: string; path?: string; uri?: string; resource?: string }[];
  verify: { type: string }[];
  excluded: { resource: string; slot: string }[];
  planHash: string;
  target: string;
}

const FAV_KEY = 'packhub.favorites.v1';
const DRAFT_KEY = 'packhub.draft.v2';

const EMPTY_FORM = {
  name: 'me/my-pack',
  version: '0.1.0',
  title: '未命名整合包',
  description: '一句话说清这个包替使用者完成了哪些整合工作。',
  targets: ['dir'] as string[],
};

const RES_TYPES = ['knowledge', 'prompt', 'skill', 'tool', 'mcp', 'config'];

const uid = (): string => Math.random().toString(36).slice(2, 8);

/** 只支持我们生成的这批字段：结构化表单 → YAML（不引第三方 YAML 库）。 */
function toYaml(form: typeof EMPTY_FORM, resources: Draft[]): string {
  const q = (s: string): string => JSON.stringify(s);
  const lines: string[] = [
    'apiVersion: packhub.dev/v0',
    'kind: Pack',
    'metadata:',
    `  name: ${form.name}`,
    `  version: ${form.version}`,
    `  title: ${q(form.title)}`,
    `  description: ${q(form.description)}`,
    `  targets: [${form.targets.join(', ')}]`,
    'requires:',
    '  packhub: ">=0.0.1 <0.1"',
  ];
  if (resources.length === 0) {
    lines.push('resources: []');
  } else {
    lines.push('resources:');
    for (const r of resources) {
      lines.push(`  - id: ${r.id}`);
      lines.push(`    type: ${r.type}`);
      lines.push(`    source: ${q(r.source)}`);
      if (r.slot) lines.push(`    slot: ${r.slot}`);
    }
  }
  return lines.join('\n') + '\n';
}

export function ConsolePage() {
  const [packs, setPacks] = useState<PackEntry[]>([]);
  const [activePack, setActivePack] = useState<string | null>(null);
  const [browser, setBrowser] = useState<PackResources | null>(null);
  const [favorites, setFavorites] = useState<Favorite[]>(() => {
    try {
      return JSON.parse(localStorage.getItem(FAV_KEY) ?? '[]') as Favorite[];
    } catch {
      return [];
    }
  });
  const [form, setForm] = useState<typeof EMPTY_FORM>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(DRAFT_KEY) ?? 'null') as {
        form?: typeof EMPTY_FORM;
        resources?: Draft[];
      } | null;
      return saved?.form ?? EMPTY_FORM;
    } catch {
      return EMPTY_FORM;
    }
  });
  const [resources, setResources] = useState<Draft[]>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(DRAFT_KEY) ?? 'null') as {
        resources?: Draft[];
      } | null;
      return saved?.resources ?? [];
    } catch {
      return [];
    }
  });
  const [plan, setPlan] = useState<Plan | null>(null);
  const [issues, setIssues] = useState<Issue[]>([]);
  const [busy, setBusy] = useState(false);
  const [target, setTarget] = useState('dir');

  const yaml = useMemo(() => toYaml(form, resources), [form, resources]);

  useEffect(() => {
    fetch('/api/registry')
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { packs?: PackEntry[] } | null) => setPacks(d?.packs ?? []))
      .catch(() => setPacks([]));
  }, []);

  useEffect(() => {
    localStorage.setItem(FAV_KEY, JSON.stringify(favorites));
  }, [favorites]);

  useEffect(() => {
    localStorage.setItem(DRAFT_KEY, JSON.stringify({ form, resources }));
  }, [form, resources]);

  // 结构化表单改动 → 自动预览（不写盘）
  useEffect(() => {
    const t = window.setTimeout(() => void preview(), 400);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [yaml, target]);

  const preview = async (): Promise<void> => {
    if (resources.length === 0) {
      setPlan(null);
      setIssues([{ code: 'empty', severity: 'warn', message: '还没有资源：从左边点 + 加一个，再预览。' }]);
      return;
    }
    setBusy(true);
    try {
      const res = await fetch('/api/plan', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ manifest: yaml, target }),
      });
      const data = (await res.json()) as { plan: Plan | null; issues: Issue[] };
      setPlan(data.plan);
      setIssues(data.issues ?? []);
    } catch (err) {
      setIssues([{ code: 'network', severity: 'error', message: (err as Error).message }]);
    } finally {
      setBusy(false);
    }
  };

  const openPack = async (name: string): Promise<void> => {
    setActivePack(name);
    const res = await fetch(`/api/registry/resources?name=${encodeURIComponent(name)}`);
    if (!res.ok) return;
    setBrowser((await res.json()) as PackResources);
  };

  const useAsBase = (): void => {
    if (!browser) return;
    setForm({
      name: `${browser.name.split('/')[0]}/my-${uid()}`,
      version: '0.1.0',
      title: browser.meta.title ?? '未命名整合包',
      description: browser.meta.description ?? '',
      targets: browser.meta.targets.length > 0 ? browser.meta.targets : ['dir'],
    });
    setResources(browser.resources.map((r) => ({ ...r, key: uid() })));
  };

  const addResource = (r: ResourceInfo): void => {
    setResources((prev) => [...prev, { ...r, key: uid() }]);
  };

  const favorite = (r: ResourceInfo): void => {
    if (!browser) return;
    const exists = favorites.some((f) => f.pack === browser.name && f.id === r.id);
    if (exists) return;
    setFavorites((prev) => [...prev, { ...r, pack: browser.name, version: browser.version }]);
  };

  const download = (): void => {
    const blob = new Blob([yaml], { type: 'text/yaml' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'packhub.yaml';
    a.click();
    URL.revokeObjectURL(url);
  };

  const errors = issues.filter((i) => i.severity === 'error');
  const favByKey = new Set(favorites.map((f) => `${f.pack}#${f.id}`));

  return (
    <div className="cs">
      <header className="cs-nav">
        <a className="pk-brand" href="/">
          <span className="brand-mark">P</span> PackHub
        </a>
        <a className="pk-link" href="/packs">
          全部整合包
        </a>
        <span className="cs-tag">创作台</span>
        <span className="cs-spacer" />
        <label className="cs-target">
          target
          <select value={target} onChange={(e) => setTarget(e.target.value)}>
            <option value="dir">dir</option>
            <option value="claude-code">claude-code</option>
            <option value="dsh">dsh</option>
          </select>
        </label>
        <button className="cs-btn ghost" onClick={download}>
          下载 yaml
        </button>
        <button className="cs-btn" onClick={() => void preview()} disabled={busy}>
          {busy ? '计算中…' : '预览计划'}
        </button>
      </header>

      <div className="cs-body">
        <aside className="cs-side">
          <section>
            <h2>收藏的资源</h2>
            {favorites.length === 0 && <p className="cs-hint">在右边浏览 registry 的包，点 ☆ 收藏资源。</p>}
            {favorites.map((f) => (
              <div className="cs-fav" key={`${f.pack}#${f.id}`}>
                <div>
                  <code>{f.id}</code>
                  <span>
                    {f.type} · {f.pack}
                  </span>
                </div>
                <button onClick={() => addResource(f)} title="加入当前草稿">
                  +
                </button>
              </div>
            ))}
          </section>

          <section>
            <h2>registry 的包</h2>
            {packs.map((p) => (
              <button
                key={p.name}
                className={`cs-base ${activePack === p.name ? 'is-active' : ''}`}
                onClick={() => void openPack(p.name)}
              >
                <span className="cs-base-name">{p.name}</span>
                <span className="cs-base-meta">v{p.latest}</span>
              </button>
            ))}
          </section>

          {browser && (
            <section>
              <h2 className="cs-res-head">
                <span>{browser.name}</span>
                <button className="cs-link" onClick={useAsBase}>
                  用作底稿
                </button>
              </h2>
              {browser.resources.map((r) => (
                <div className="cs-res" key={r.id}>
                  <div>
                    <code>{r.id}</code>
                    <span>{r.type}</span>
                  </div>
                  <div className="cs-res-actions">
                    <button
                      className={favByKey.has(`${browser.name}#${r.id}`) ? 'is-on' : ''}
                      onClick={() => favorite(r)}
                      title="收藏"
                    >
                      ☆
                    </button>
                    <button onClick={() => addResource(r)} title="加入草稿">
                      +
                    </button>
                  </div>
                </div>
              ))}
            </section>
          )}
        </aside>

        <section className="cs-editor">
          <div className="cs-form">
            <div className="cs-row two">
              <label>
                包名
                <input
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  spellCheck={false}
                />
              </label>
              <label>
                版本
                <input
                  value={form.version}
                  onChange={(e) => setForm({ ...form, version: e.target.value })}
                  spellCheck={false}
                />
              </label>
            </div>
            <label>
              标题
              <input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
            </label>
            <label>
              一句话说明
              <textarea
                rows={2}
                value={form.description}
                onChange={(e) => setForm({ ...form, description: e.target.value })}
              />
            </label>
            <div className="cs-row">
              <span className="cs-label">targets</span>
              {['dir', 'claude-code', 'dsh'].map((t) => (
                <label key={t} className="cs-check">
                  <input
                    type="checkbox"
                    checked={form.targets.includes(t)}
                    onChange={(e) =>
                      setForm({
                        ...form,
                        targets: e.target.checked
                          ? [...form.targets, t]
                          : form.targets.filter((x) => x !== t),
                      })
                    }
                  />
                  {t}
                </label>
              ))}
            </div>
          </div>

          <div className="cs-reslist">
            <div className="cs-reslist-head">
              <span>资源 {resources.length} 个</span>
            </div>
            {resources.length === 0 && <p className="cs-hint">从左边收藏或包资源里点 + 添加。</p>}
            {resources.map((r, i) => (
              <div className="cs-restable-row" key={r.key}>
                <input
                  value={r.id}
                  onChange={(e) =>
                    setResources(resources.map((x, j) => (j === i ? { ...x, id: e.target.value } : x)))
                  }
                />
                <select
                  value={r.type}
                  onChange={(e) =>
                    setResources(resources.map((x, j) => (j === i ? { ...x, type: e.target.value } : x)))
                  }
                >
                  {RES_TYPES.map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </select>
                <input
                  value={r.source}
                  onChange={(e) =>
                    setResources(resources.map((x, j) => (j === i ? { ...x, source: e.target.value } : x)))
                  }
                />
                <input
                  className="cs-slot"
                  placeholder="slot"
                  value={r.slot ?? ''}
                  onChange={(e) =>
                    setResources(
                      resources.map((x, j) => (j === i ? { ...x, slot: e.target.value || undefined } : x)),
                    )
                  }
                />
                <button
                  className="cs-del"
                  onClick={() => setResources(resources.filter((_, j) => j !== i))}
                  title="移除"
                >
                  ×
                </button>
              </div>
            ))}
          </div>

          <details className="cs-yaml">
            <summary>看生成的 yaml</summary>
            <pre>{yaml}</pre>
          </details>
        </section>

        <aside className="cs-preview">
          <h2>预览</h2>
          {issues.length > 0 && (
            <ul className="cs-issues">
              {issues.map((i2, idx) => (
                <li key={idx} className={i2.severity === 'error' ? 'bad' : 'warn'}>
                  <code>{i2.code}</code>
                  {i2.message}
                </li>
              ))}
            </ul>
          )}
          {plan && (
            <>
              <p className="cs-hash">
                {plan.target} · {plan.actions.length} 个动作 · {plan.verify.length} 项校验
                <br />
                <code>{plan.planHash}</code>
              </p>
              <ol className="cs-actions">
                {plan.actions.map((a) => (
                  <li key={a.actionId}>
                    <span className="cs-op">{a.op}</span>
                    <span className="cs-target">
                      {a.to ?? a.dest ?? a.path ?? a.uri ?? a.resource ?? ''}
                    </span>
                  </li>
                ))}
              </ol>
              {plan.excluded.length > 0 && (
                <p className="cs-hint">
                  跳过：{plan.excluded.map((e) => `${e.resource}（槽位 ${e.slot} 未绑定）`).join('、')}
                </p>
              )}
            </>
          )}
          {!plan && issues.length === 0 && <p className="cs-hint">改动会自动预览；点「预览计划」强制重算。</p>}
          {errors.length > 0 && <p className="cs-hint">有 {errors.length} 个错误，修完再看计划。</p>}
        </aside>
      </div>
    </div>
  );
}
