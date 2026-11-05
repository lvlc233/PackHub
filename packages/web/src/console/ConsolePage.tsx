import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
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
  needs?: string[];
  dependsOn?: string[];
  transport?: string;
  /** 原样写进 YAML 的 JSON 对象，例如 {"ROOT":"."} */
  config?: string;
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
  path?: string;
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
  keywords: '',
  license: '',
  homepage: '',
  targets: ['dir'] as string[],
  visibility: 'public',
};

const RES_TYPES = ['knowledge', 'prompt', 'skill', 'tool', 'mcp', 'config'];

const uid = (): string => Math.random().toString(36).slice(2, 8);

/** 粗判 source 类型；只用于面板提示，最终判定仍在 kernel。 */
function sourceKind(source: string): { kind: string; pinned: boolean } {
  if (source.startsWith('npm:')) {
    const body = source.slice(4);
    const at = body.lastIndexOf('@');
    return { kind: 'npm', pinned: at > 0 && !/^(latest|next)$/i.test(body.slice(at + 1)) };
  }
  if (source.startsWith('github:')) {
    const body = source.slice(7);
    const at = body.lastIndexOf('@');
    return { kind: 'github', pinned: at > 0 && /^[0-9a-f]{40}$/i.test(body.slice(at + 1)) };
  }
  if (source.startsWith('pypi:')) return { kind: 'pypi', pinned: source.includes('@') };
  if (source.startsWith('packhub://')) return { kind: 'packhub', pinned: true };
  if (source.startsWith('https://') || source.startsWith('http://')) return { kind: 'https', pinned: true };
  if (source.startsWith('./') || source.startsWith('../')) return { kind: 'local', pinned: true };
  return { kind: 'unknown', pinned: false };
}

/** 只生成受支持的字段：结构化表单 → YAML（不引第三方 YAML 库）。 */
function toYaml(
  form: typeof EMPTY_FORM,
  resources: Draft[],
  nameOverride?: string,
): string {
  const q = (s: string): string => JSON.stringify(s);
  const list = (items: string[]): string => `[${items.map((x) => q(x)).join(', ')}]`;
  const lines: string[] = [
    'apiVersion: packhub.dev/v0',
    'kind: Pack',
    'metadata:',
    `  name: ${nameOverride ?? form.name}`,
    `  version: ${form.version}`,
    `  title: ${q(form.title)}`,
    `  description: ${q(form.description)}`,
    `  targets: [${form.targets.join(', ')}]`,
    `  visibility: ${form.visibility}`,
  ];
  const keywords = form.keywords
    .split(',')
    .map((k) => k.trim())
    .filter(Boolean);
  if (keywords.length > 0) lines.push(`  keywords: ${list(keywords)}`);
  if (form.license.trim()) lines.push(`  license: ${q(form.license.trim())}`);
  if (form.homepage.trim()) lines.push(`  homepage: ${q(form.homepage.trim())}`);
  lines.push('requires:', '  packhub: ">=0.0.1 <0.1"');
  if (resources.length === 0) {
    lines.push('resources: []');
  } else {
    lines.push('resources:');
    for (const r of resources) {
      lines.push(`  - id: ${r.id}`);
      lines.push(`    type: ${r.type}`);
      lines.push(`    source: ${q(r.source)}`);
      if (r.slot) lines.push(`    slot: ${r.slot}`);
      if (r.transport) lines.push(`    transport: ${r.transport}`);
      if (r.provides && r.provides.length > 0) lines.push(`    provides: ${list(r.provides)}`);
      if (r.needs && r.needs.length > 0) lines.push(`    needs: ${list(r.needs)}`);
      if (r.dependsOn && r.dependsOn.length > 0) lines.push(`    dependsOn: ${list(r.dependsOn)}`);
      if (r.config && r.config.trim()) lines.push(`    config: ${r.config.trim()}`);
    }
    // 行顺序就是安装顺序：写进 composition.order，预览与保存都按这个顺序
    lines.push('composition:', `  order: [${resources.map((r) => r.id).join(', ')}]`);
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
      return { ...EMPTY_FORM, ...(saved?.form ?? {}) };
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
  const [saveDir, setSaveDir] = useState('');
  const [savedDir, setSavedDir] = useState<string | null>(null);
  const [delivery, setDelivery] = useState<{ kind: 'ok' | 'error' | 'busy'; text: string } | null>(null);
  const [installInto, setInstallInto] = useState('');
  const [registryPath, setRegistryPath] = useState('registry');
  const [conflict, setConflict] = useState<string | null>(null);
  const [copiedHash, setCopiedHash] = useState(false);
  const [expandedRes, setExpandedRes] = useState<Set<string>>(new Set());
  const fileRef = useRef<HTMLInputElement | null>(null);

  const yaml = useMemo(() => toYaml(form, resources), [form, resources]);

  const nameOk = /^[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9-]*$/.test(form.name);
  const versionOk = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(form.version);
  const targetsOk = form.targets.length > 0;
  const gate = [
    { ok: nameOk && versionOk && targetsOk, text: '表单字段' },
    { ok: form.visibility === 'public' || form.visibility === 'unlisted', text: 'visibility 可发布' },
    { ok: resources.length > 0, text: '至少一个资源' },
    { ok: !issues.some((i) => i.severity === 'error'), text: '预览无错误' },
    { ok: plan !== null, text: '计划可生成' },
  ];
  const dupIds = new Set(
    resources.map((r) => r.id).filter((id, i, arr) => arr.indexOf(id) !== i),
  );

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

  useEffect(() => {
    const guard = (event: BeforeUnloadEvent): void => {
      if (resources.length === 0) return;
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', guard);
    return () => window.removeEventListener('beforeunload', guard);
  }, [resources.length]);

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
      ...EMPTY_FORM,
      name: `${browser.name.split('/')[0]}/my-${uid()}`,
      version: '0.1.0',
      title: browser.meta.title ?? '未命名整合包',
      description: browser.meta.description ?? '',
      keywords: (browser.meta.keywords ?? []).join(', '),
      targets: browser.meta.targets.length > 0 ? browser.meta.targets : ['dir'],
      visibility: 'public',
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


  const doSave = async (force = false): Promise<void> => {
    if (!nameOk || !versionOk || !targetsOk) {
      setDelivery({ kind: 'error', text: '包名 / 版本 / targets 不合法，先修表单' });
      return;
    }
    const dir = saveDir.trim() || `packs/${form.name}`;
    setDelivery({ kind: 'busy', text: '保存中…' });
    setConflict(null);
    try {
      const res = await fetch('/api/packs/create', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ dir, manifest: yaml, force }),
      });
      const data = (await res.json()) as { dir?: string; error?: string; issues?: { message: string }[] };
      if (res.status === 409) {
        setConflict(dir);
        setDelivery({ kind: 'error', text: data.error ?? '目录里已经有 packhub.yaml' });
        return;
      }
      if (!res.ok) {
        setDelivery({ kind: 'error', text: data.error ?? data.issues?.map((i) => i.message).join('; ') ?? '保存失败' });
        return;
      }
      setSavedDir(data.dir ?? dir);
      setDelivery({ kind: 'ok', text: `已保存到 ${data.dir ?? dir}（只写了 packhub.yaml）` });
    } catch (err) {
      setDelivery({ kind: 'error', text: (err as Error).message });
    }
  };

  const doInstall = async (dryRun = false): Promise<void> => {
    if (!savedDir) return;
    setDelivery({ kind: 'busy', text: dryRun ? '预演安装…' : '安装中…' });
    try {
      const res = await fetch(`/api/install?dir=${encodeURIComponent(savedDir)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ into: installInto.trim() || undefined, dryRun }),
      });
      const data = (await res.json()) as {
        outcomes?: { status: string }[];
        root?: string;
        error?: string;
        issues?: { message: string }[];
      };
      if (!res.ok) {
        setDelivery({ kind: 'error', text: data.error ?? data.issues?.map((i) => i.message).join('; ') ?? '安装失败' });
        return;
      }
      const bad = (data.outcomes ?? []).filter((o) => o.status !== 'done' && o.status !== 'noop');
      setDelivery(
        bad.length === 0
          ? { kind: 'ok', text: `安装完成：${(data.outcomes ?? []).length} 个动作 → ${data.root ?? 'Pack 目录'}` }
          : { kind: 'error', text: `安装未完成：${bad.length} 个动作失败/跳过` },
      );
    } catch (err) {
      setDelivery({ kind: 'error', text: (err as Error).message });
    }
  };

  const doPublish = async (): Promise<void> => {
    if (!savedDir) return;
    if (form.visibility === 'private' || form.visibility === 'internal') {
      setDelivery({ kind: 'error', text: `${form.visibility} 不能进公共索引；改成 public/unlisted 再发` });
      return;
    }
    setDelivery({ kind: 'busy', text: '发布中（会跑干净安装+校验）…' });
    try {
      const res = await fetch('/api/publish', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ dir: savedDir, registry: registryPath.trim() || 'registry' }),
      });
      const data = (await res.json()) as { name?: string; version?: string; error?: string };
      if (!res.ok) {
        setDelivery({ kind: 'error', text: data.error ?? '发布失败' });
        return;
      }
      setDelivery({ kind: 'ok', text: `已发布 ${data.name}@${data.version}，索引已更新` });
    } catch (err) {
      setDelivery({ kind: 'error', text: (err as Error).message });
    }
  };

  const doSaveCopy = async (): Promise<void> => {
    const base = saveDir.trim() || `packs/${form.name}`;
    const dir = `${base}-copy`;
    setDelivery({ kind: 'busy', text: '保存副本…' });
    try {
      const res = await fetch('/api/packs/create', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ dir, manifest: toYaml(form, resources, `${form.name}-copy`) }),
      });
      const data = (await res.json()) as { dir?: string; error?: string; issues?: { message: string }[] };
      if (!res.ok) {
        setDelivery({ kind: 'error', text: data.error ?? data.issues?.map((i) => i.message).join('; ') ?? '保存副本失败' });
        return;
      }
      setSavedDir(data.dir ?? dir);
      setDelivery({ kind: 'ok', text: `副本已保存到 ${data.dir ?? dir}（包名加了 -copy）` });
    } catch (err) {
      setDelivery({ kind: 'error', text: (err as Error).message });
    }
  };

  const uploadFiles = async (files: FileList | null): Promise<void> => {
    if (!files || files.length === 0) return;
    const dir = saveDir.trim() || `packs/${form.name}`;
    setDelivery({ kind: 'busy', text: `上传 ${files.length} 个文件…` });
    try {
      const added: Draft[] = [];
      for (const file of Array.from(files)) {
        const dataBase64 = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
          reader.onerror = () => reject(reader.error);
          reader.readAsDataURL(file);
        });
        const res = await fetch('/api/packs/upload', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ dir, path: `resources/${file.name}`, dataBase64 }),
        });
        const data = (await res.json()) as { error?: string };
        if (!res.ok) throw new Error(data.error ?? `上传失败：${file.name}`);
        const idBase = file.name
          .replace(/\.[^.]+$/, '')
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-+|-+$/g, '');
        added.push({
          key: uid(),
          id: idBase || `file-${uid()}`,
          type: 'knowledge',
          source: `./resources/${file.name}`,
        });
      }
      setResources((prev) => [...prev, ...added]);
      setSaveDir(dir);
      setDelivery({ kind: 'ok', text: `已上传 ${added.length} 个文件并加入资源` });
    } catch (err) {
      setDelivery({ kind: 'error', text: (err as Error).message });
    }
  };
  const resetDraft = (): void => {
    setForm({ ...EMPTY_FORM, targets: [...EMPTY_FORM.targets] });
    setResources([]);
    setPlan(null);
    setIssues([]);
    setSavedDir(null);
    setConflict(null);
    setDelivery({ kind: 'ok', text: '已清空草稿' });
  };

  const duplicateResource = (index: number): void => {
    setResources((prev) => {
      const src = prev[index];
      if (!src) return prev;
      const next = [...prev];
      next.splice(index + 1, 0, { ...src, key: uid(), id: `${src.id}-copy` });
      return next;
    });
  };

  const moveResource = (index: number, by: number): void => {
    setResources((prev) => {
      const target = index + by;
      if (target < 0 || target >= prev.length) return prev;
      const next = [...prev];
      const [row] = next.splice(index, 1);
      if (row) next.splice(target, 0, row);
      return next;
    });
  };

  const copyHash = (): void => {
    if (!plan) return;
    void navigator.clipboard?.writeText(plan.planHash);
    setCopiedHash(true);
    window.setTimeout(() => setCopiedHash(false), 1200);
  };
  const addBlankResource = (): void => {
    setResources((prev) => [
      ...prev,
      {
        key: uid(),
        id: `resource-${prev.length + 1}`,
        type: 'knowledge',
        source: './resources/example.md',
      },
    ]);
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
            <option value="codex">codex</option>
          </select>
        </label>
        <button className="cs-btn ghost" onClick={resetDraft}>
          清空草稿
        </button>
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
                  aria-invalid={!nameOk}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  spellCheck={false}
                />
                {!nameOk && <span className="cs-field-error">要 scope/name（小写字母、数字、连字符）</span>}
              </label>
              <label>
                版本
                <input
                  value={form.version}
                  aria-invalid={!versionOk}
                  onChange={(e) => setForm({ ...form, version: e.target.value })}
                  spellCheck={false}
                />
                {!versionOk && <span className="cs-field-error">要 x.y.z</span>}
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
            <div className="cs-row three">
              <label>
                keywords
                <input
                  value={form.keywords}
                  placeholder="逗号分隔"
                  onChange={(e) => setForm({ ...form, keywords: e.target.value })}
                />
              </label>
              <label>
                license
                <input
                  value={form.license}
                  placeholder="MIT / Apache-2.0"
                  onChange={(e) => setForm({ ...form, license: e.target.value })}
                />
              </label>
              <label>
                homepage
                <input
                  value={form.homepage}
                  placeholder="https://…"
                  onChange={(e) => setForm({ ...form, homepage: e.target.value })}
                />
              </label>
            </div>            <div className="cs-row">
              <span className="cs-label">visibility</span>
              <select
                className="cs-visibility"
                aria-label="visibility"
                value={form.visibility}
                onChange={(e) => setForm({ ...form, visibility: e.target.value })}
              >
                {['public', 'unlisted', 'internal', 'private'].map((v) => (
                  <option key={v} value={v}>
                    {v}
                  </option>
                ))}
              </select>
            </div>
            {!targetsOk && <span className="cs-field-error">至少选一个 target</span>}
            <div className="cs-row">
              <span className="cs-label">targets</span>
              {['dir', 'claude-code', 'dsh', 'codex'].map((t) => (
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
              <span className="cs-reslist-actions">
                <button className="cs-link" onClick={addBlankResource}>
                  + 新增资源
                </button>
                <button className="cs-link" onClick={() => fileRef.current?.click()}>
                  上传文件
                </button>
                <input
                  ref={fileRef}
                  type="file"
                  multiple
                  className="cs-file"
                  onChange={(e) => {
                    void uploadFiles(e.target.files);
                    e.target.value = '';
                  }}
                />
              </span>
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
                <div className="cs-row-actions">
                  <button className="cs-rowbtn" onClick={() => moveResource(i, -1)} title="上移" aria-label={`上移 ${r.id}`}>
                    ↑
                  </button>
                  <button className="cs-rowbtn" onClick={() => moveResource(i, 1)} title="下移" aria-label={`下移 ${r.id}`}>
                    ↓
                  </button>
                  <button className="cs-rowbtn" onClick={() => duplicateResource(i)} title="复制" aria-label={`复制 ${r.id}`}>
                    ⧉
                  </button>
                  <button
                    className="cs-del"
                    onClick={() => setResources(resources.filter((_, j) => j !== i))}
                    title="移除"
                    aria-label={`移除 ${r.id}`}
                  >
                    ×
                  </button>
                </div>
                {dupIds.has(r.id) && <span className="cs-field-error">id 重复：{r.id}</span>}
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
                <button className="cs-hash-copy" onClick={copyHash}>
                  {copiedHash ? '已复制' : '复制 planHash'}
                </button>
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
          <section className="cs-deliver">
            <h3>保存与发布</h3>
            <label className="cs-deliver-row">
              目录
              <input
                value={saveDir}
                placeholder={`packs/${form.name}`}
                onChange={(e) => setSaveDir(e.target.value)}
                spellCheck={false}
              />
            </label>
            <label className="cs-deliver-row">
              安装到
              <input
                value={installInto}
                placeholder="留空=装在 Pack 目录；或填项目目录"
                onChange={(e) => setInstallInto(e.target.value)}
                spellCheck={false}
              />
            </label>
            <label className="cs-deliver-row">
              registry
              <input
                value={registryPath}
                placeholder="registry 目录（默认 registry）"
                onChange={(e) => setRegistryPath(e.target.value)}
                spellCheck={false}
              />
            </label>
            <div className="cs-deliver-actions">
              <button className="cs-btn" onClick={() => void doSave()}>
                保存到目录
              </button>
              <button className="cs-btn ghost" onClick={() => void doInstall()} disabled={!savedDir}>
                安装
              </button>
              <button className="cs-btn ghost" onClick={() => void doPublish()} disabled={!savedDir}>
                发布到 registry
              </button>
              {conflict && (
                <button className="cs-btn ghost" onClick={() => void doSave(true)}>
                  覆盖 {conflict}
                </button>
              )}
            </div>
            {delivery && (
              <p
                className={delivery.kind === 'error' ? 'cs-deliver-msg bad' : 'cs-deliver-msg'}
                role="status"
              >
                {delivery.text}
              </p>
            )}
            <p className="cs-hint">
              保存只写 packhub.yaml；本地 source 指向的文件仍需放进该目录。发布前会跑干净安装与校验。
            </p>
          </section>
          {!plan && issues.length === 0 && <p className="cs-hint">改动会自动预览；点「预览计划」强制重算。</p>}
          {errors.length > 0 && <p className="cs-hint">有 {errors.length} 个错误，修完再看计划。</p>}
        </aside>
      </div>
    </div>
  );
}
