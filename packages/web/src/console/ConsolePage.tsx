import { useEffect, useMemo, useState } from 'react';
import './console.css';

interface PackEntry {
  name: string;
  latest: string;
  title: string;
  trust: string;
}

interface Issue {
  code: string;
  severity: string;
  message: string;
}

interface Action {
  actionId: string;
  op: string;
  resource?: string;
  to?: string;
  dest?: string;
  path?: string;
  uri?: string;
  from?: string;
}

interface Plan {
  actions: Action[];
  verify: { type: string }[];
  excluded: { resource: string; slot: string }[];
  planHash: string;
  target: string;
}

const TEMPLATE = `apiVersion: packhub.dev/v0
kind: Pack
metadata:
  name: me/my-pack
  version: 0.0.1
  title: 未命名整合包
  description: 一句话说清这个包替使用者完成了哪些整合工作。
  targets: [dir]
requires:
  packhub: ">=0.0.1 <0.1"
resources:
  - id: rules
    type: knowledge
    source: ./rules.md
`;

const STORAGE = 'packhub.draft.v1';

export function ConsolePage() {
  const [manifest, setManifest] = useState(() => localStorage.getItem(STORAGE) ?? TEMPLATE);
  const [target, setTarget] = useState('dir');
  const [packs, setPacks] = useState<PackEntry[]>([]);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [issues, setIssues] = useState<Issue[]>([]);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    fetch('/api/registry')
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { packs?: PackEntry[] } | null) => setPacks(d?.packs ?? []))
      .catch(() => setPacks([]));
  }, []);

  useEffect(() => {
    localStorage.setItem(STORAGE, manifest);
  }, [manifest]);

  const preview = async () => {
    setBusy(true);
    try {
      const res = await fetch('/api/plan', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ manifest, target }),
      });
      const data = (await res.json()) as { plan: Plan | null; issues: Issue[]; error?: string };
      setPlan(data.plan);
      setIssues(data.error ? [{ code: 'request', severity: 'error', message: data.error }] : data.issues);
    } catch (err) {
      setIssues([{ code: 'network', severity: 'error', message: (err as Error).message }]);
    } finally {
      setBusy(false);
    }
  };

  const loadBase = async (name: string) => {
    const res = await fetch(`/api/registry/pack?name=${encodeURIComponent(name)}`);
    if (!res.ok) return;
    const data = (await res.json()) as { manifest: string };
    setManifest(data.manifest);
    setPlan(null);
    setIssues([]);
  };

  const download = () => {
    const blob = new Blob([manifest], { type: 'text/yaml' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'packhub.yaml';
    a.click();
    URL.revokeObjectURL(url);
  };

  const errors = useMemo(() => issues.filter((i) => i.severity === 'error'), [issues]);

  return (
    <div className="cs">
      <header className="cs-nav">
        <a className="pk-brand" href="/">
          <span className="brand-mark">P</span> PackHub
        </a>
        <a className="pk-link" href="/packs">
          全部整合包
        </a>
        <span className="cs-tag">创作台 · 草稿</span>
        <span className="cs-spacer" />
        <button className="cs-btn ghost" onClick={download}>
          下载 .yaml
        </button>
        <button
          className="cs-btn ghost"
          onClick={() => {
            localStorage.setItem(STORAGE, manifest);
            setSaved(true);
            window.setTimeout(() => setSaved(false), 1200);
          }}
        >
          {saved ? '已保存' : '保存草稿'}
        </button>
        <button className="cs-btn" onClick={preview} disabled={busy}>
          {busy ? '计算中…' : '预览计划'}
        </button>
      </header>

      <div className="cs-body">
        <aside className="cs-side">
          <h2>从现有包起步</h2>
          {packs.length === 0 && <p className="cs-hint">registry 里还没有包。</p>}
          {packs.map((p) => (
            <button key={p.name} className="cs-base" onClick={() => loadBase(p.name)}>
              <span className="cs-base-name">{p.name}</span>
              <span className="cs-base-meta">
                v{p.latest}
                {p.trust === 'verified' ? ' · verified' : ''}
              </span>
            </button>
          ))}
          <p className="cs-hint">
            以某个包为底稿：把它的清单载入编辑器，改完在这里预览计划，再下载成 packhub.yaml。
          </p>
        </aside>

        <section className="cs-editor">
          <div className="cs-editor-head">
            <span>packhub.yaml</span>
            <label>
              target
              <select value={target} onChange={(e) => setTarget(e.target.value)}>
                <option value="dir">dir</option>
                <option value="claude-code">claude-code</option>
                <option value="dsh">dsh</option>
              </select>
            </label>
          </div>
          <textarea
            value={manifest}
            spellCheck={false}
            onChange={(e) => {
              setManifest(e.target.value);
              setPlan(null);
            }}
          />
        </section>

        <aside className="cs-preview">
          <h2>预览</h2>
          {issues.length > 0 && (
            <ul className="cs-issues">
              {issues.map((i, idx) => (
                <li key={idx} className={i.severity === 'error' ? 'bad' : 'warn'}>
                  <code>{i.code}</code>
                  {i.message}
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

          {!plan && issues.length === 0 && (
            <p className="cs-hint">
              点「预览计划」看会发生什么。预览只读：不改磁盘、不联网，校验在服务端用内核跑。
            </p>
          )}
          {errors.length > 0 && <p className="cs-hint">有 {errors.length} 个错误，修完再预览。</p>}
        </aside>
      </div>
    </div>
  );
}
