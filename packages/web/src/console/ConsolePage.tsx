import { useEffect, useMemo, useRef, useState } from 'react';
import { parse as parseYaml } from 'yaml';
import { RESOURCE_TYPES } from '../resourceTypes.ts';
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
  integrity?: string;
  auth?: { env: string; scheme?: string };
  targets?: string[];
  optional?: boolean;
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

interface DraftRes extends ResourceInfo {
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
  excluded: { resource: string; slot: string; reason?: string }[];
  planHash: string;
  target: string;
}

interface FormState {
  name: string;
  version: string;
  title: string;
  description: string;
  keywords: string;
  license: string;
  homepage: string;
  authors: string;
  extends: string;
  agent: string;
  targets: string[];
  visibility: string;
}

interface AdvancedState {
  compositionEnv: string;
  slots: string;
  bindings: string;
  overrides: string;
  overlays: string;
  verify: string;
  exec: string;
  vars: string;
  state: string;
}

interface DraftRecord {
  id: string;
  label: string;
  updatedAt: string;
  form: FormState;
  resources: DraftRes[];
  advanced: AdvancedState;
  docs: { readme: string; changelog: string };
}

const FAV_KEY = 'packhub.favorites.v1';
const LEGACY_DRAFT_KEY = 'packhub.draft.v2';
const DRAFTS_KEY = 'packhub.drafts.v2';
const ACTIVE_KEY = 'packhub.activeDraft.v2';

const EMPTY_FORM: FormState = {
  name: 'me/my-pack',
  version: '0.1.0',
  title: '未命名整合包',
  description: '一句话说清这个包替使用者完成了哪些整合工作。',
  keywords: '',
  license: '',
  homepage: '',
  authors: '',
  extends: '',
  agent: '',
  targets: ['dir'],
  visibility: 'public',
};

const EMPTY_ADVANCED: AdvancedState = {
  compositionEnv: '',
  slots: '',
  bindings: '',
  overrides: '',
  overlays: '',
  verify: '',
  exec: '',
  vars: '',
  state: '',
};

const TARGETS = ['dir', 'claude-code', 'dsh', 'codex'];

const uid = (): string => Math.random().toString(36).slice(2, 8);

/** 粗判 source 类型；只用于面板提示，最终判定仍在 kernel。 */
function sourceKind(source: string): { kind: string; pinned: boolean; hint: string } {
  if (source.startsWith('npm:')) {
    const body = source.slice(4);
    const at = body.lastIndexOf('@');
    const pin = at > 0 ? body.slice(at + 1) : '';
    return { kind: 'npm', pinned: Boolean(pin) && !/^(latest|next)$/i.test(pin), hint: 'npm 包，@版本 必须写死' };
  }
  if (source.startsWith('github:')) {
    const body = source.slice(7);
    const at = body.lastIndexOf('@');
    const pin = at > 0 ? body.slice(at + 1) : '';
    return { kind: 'github', pinned: /^[0-9a-f]{40}$/i.test(pin), hint: 'github 仓库，@commit 必须 40 位' };
  }
  if (source.startsWith('pypi:')) return { kind: 'pypi', pinned: source.includes('@'), hint: 'PyPI sdist，@版本 必须写死' };
  if (source.startsWith('packhub://')) return { kind: 'packhub', pinned: true, hint: 'registry 包内路径，发布时会扁平化' };
  if (source.startsWith('https://') || source.startsWith('http://')) return { kind: 'https', pinned: true, hint: 'https 直链，要有 integrity' };
  if (source.startsWith('./') || source.startsWith('../')) return { kind: 'local', pinned: true, hint: '包内相对路径' };
  return { kind: 'unknown', pinned: false, hint: '要 npm: / pypi: / github: / https:// / ./' };
}

function splitList(text: string): string[] {
  return text
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
}

function readJson<T>(text: string, fallback: T): T {
  if (!text.trim()) return fallback;
  return JSON.parse(text) as T;
}

/** 生成 YAML 时用：非法 JSON 不炸整个面板，留给 advancedErrors 报。 */
function safeJson<T>(text: string, fallback: T): T {
  try {
    return readJson(text, fallback);
  } catch {
    return fallback;
  }
}

function envLines(env: unknown): string {
  if (!env || typeof env !== 'object') return '';
  return Object.entries(env as Record<string, unknown>)
    .map(([k, v]) => `${k}=${String(v)}`)
    .join('\n');
}

function linesToEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const at = line.indexOf('=');
    if (at <= 0) throw new Error(`composition.env 行要 KEY=value：${line}`);
    out[line.slice(0, at).trim()] = line.slice(at + 1).trim();
  }
  return out;
}

function bumpVersion(version: string): string {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!m) return version;
  return `${m[1]}.${m[2]}.${Number(m[3]) + 1}`;
}

function emptyDraft(index: number): DraftRecord {
  return {
    id: uid(),
    label: `草稿 ${index}`,
    updatedAt: new Date().toISOString(),
    form: { ...EMPTY_FORM, targets: [...EMPTY_FORM.targets] },
    resources: [],
    advanced: { ...EMPTY_ADVANCED },
    docs: { readme: '', changelog: '' },
  };
}

function loadDrafts(): DraftRecord[] {
  try {
    const saved = JSON.parse(localStorage.getItem(DRAFTS_KEY) ?? 'null') as DraftRecord[] | null;
    if (Array.isArray(saved) && saved.length > 0) {
      return saved.map((d) => ({
        ...d,
        form: { ...EMPTY_FORM, ...(d.form ?? {}) },
        resources: Array.isArray(d.resources) ? d.resources : [],
        advanced: { ...EMPTY_ADVANCED, ...(d.advanced ?? {}) },
        docs: d.docs ?? { readme: '', changelog: '' },
      }));
    }
  } catch {
    /* 坏数据就走迁移 */
  }
  try {
    const legacy = JSON.parse(localStorage.getItem(LEGACY_DRAFT_KEY) ?? 'null') as {
      form?: Partial<FormState>;
      resources?: DraftRes[];
    } | null;
    if (legacy) {
      return [
        {
          ...emptyDraft(1),
          form: { ...EMPTY_FORM, ...(legacy.form ?? {}) },
          resources: legacy.resources ?? [],
        },
      ];
    }
  } catch {
    /* 忽略 */
  }
  return [emptyDraft(1)];
}

/** 只生成受支持的字段：结构化表单 → YAML（不引第三方 YAML 库）。 */
function toYaml(
  form: FormState,
  resources: DraftRes[],
  advanced: AdvancedState,
  overrides: { name?: string; version?: string } = {},
): string {
  const q = (s: string): string => JSON.stringify(s);
  const list = (items: string[]): string => `[${items.map((x) => q(x)).join(', ')}]`;
  const lines: string[] = ['apiVersion: packhub.dev/v0', 'kind: Pack'];
  if (form.extends.trim()) lines.push(`extends: ${q(form.extends.trim())}`);
  lines.push(
    'metadata:',
    `  name: ${overrides.name ?? form.name}`,
    `  version: ${overrides.version ?? form.version}`,
    `  title: ${q(form.title)}`,
    `  description: ${q(form.description)}`,
    `  targets: [${form.targets.join(', ')}]`,
    `  visibility: ${form.visibility}`,
  );
  const keywords = splitList(form.keywords);
  if (keywords.length > 0) lines.push(`  keywords: ${list(keywords)}`);
  if (form.license.trim()) lines.push(`  license: ${q(form.license.trim())}`);
  if (form.homepage.trim()) lines.push(`  homepage: ${q(form.homepage.trim())}`);
  if (form.authors.trim()) {
    try {
      const parsed = form.authors.trim().startsWith('[')
        ? (JSON.parse(form.authors) as unknown)
        : splitList(form.authors).map((name) => ({ name }));
      if (Array.isArray(parsed) && parsed.length > 0) {
        lines.push(`  authors: ${JSON.stringify(parsed)}`);
      }
    } catch {
      /* 高级错误单独提示，这里不写 */
    }
  }
  lines.push('requires:', '  packhub: ">=0.0.1 <0.1"');
  if (form.agent.trim()) lines.push(`  agent: ${q(form.agent.trim())}`);

  const vars = safeJson<Record<string, unknown>>(advanced.vars, {});
  if (Object.keys(vars).length > 0) {
    lines.push('vars:');
    for (const [k, v] of Object.entries(vars)) lines.push(`  ${k}: ${JSON.stringify(v)}`);
  }
  const stateDirs = safeJson<unknown[]>(advanced.state, []);
  if (stateDirs.length > 0) lines.push(`state: ${JSON.stringify(stateDirs)}`);

  if (resources.length === 0) {
    lines.push('resources: []');
  } else {
    lines.push('resources:');
    for (const r of resources) {
      lines.push(`  - id: ${r.id}`);
      lines.push(`    type: ${r.type}`);
      lines.push(`    source: ${q(r.source)}`);
      if (r.integrity?.trim()) lines.push(`    integrity: ${q(r.integrity.trim())}`);
      if (r.slot) lines.push(`    slot: ${r.slot}`);
      if (r.transport) lines.push(`    transport: ${r.transport}`);
      if (r.provides && r.provides.length > 0) lines.push(`    provides: ${list(r.provides)}`);
      if (r.needs && r.needs.length > 0) lines.push(`    needs: ${list(r.needs)}`);
      if (r.dependsOn && r.dependsOn.length > 0) lines.push(`    dependsOn: ${list(r.dependsOn)}`);
      if (r.targets && r.targets.length > 0) lines.push(`    targets: [${r.targets.join(', ')}]`);
      if (r.optional) lines.push('    optional: true');
      if (r.auth?.env) {
        lines.push(`    auth: { env: ${r.auth.env}${r.auth.scheme ? `, scheme: ${r.auth.scheme}` : ''} }`);
      }
      if (r.config && r.config.trim()) lines.push(`    config: ${r.config.trim()}`);
    }
  }

  const composition: string[] = [];
  const order = resources.map((r) => r.id);
  if (order.length > 0) composition.push(`  order: [${order.join(', ')}]`);
  if (advanced.compositionEnv.trim()) {
    try {
      const env = linesToEnv(advanced.compositionEnv);
      const rows = Object.entries(env).map(([k, v]) => `    ${k}: ${q(v)}`);
      if (rows.length > 0) composition.push('  env:', ...rows);
    } catch {
      /* 格式错误由 advancedErrors 提示，这里不写半截 */
    }
  }
  if (composition.length > 0) lines.push('composition:', ...composition);

  const slots = safeJson<Record<string, unknown>>(advanced.slots, {});
  if (Object.keys(slots).length > 0) lines.push(`slots: ${JSON.stringify(slots)}`);
  const bindings = safeJson<Record<string, unknown>>(advanced.bindings, {});
  if (Object.keys(bindings).length > 0) lines.push(`bindings: ${JSON.stringify(bindings)}`);
  const overridesList = safeJson<unknown[]>(advanced.overrides, []);
  if (overridesList.length > 0) lines.push(`overrides: ${JSON.stringify(overridesList)}`);
  const overlays = safeJson<unknown[]>(advanced.overlays, []);
  if (overlays.length > 0) lines.push(`overlays: ${JSON.stringify(overlays)}`);
  const verify = safeJson<unknown[]>(advanced.verify, []);
  if (verify.length > 0) lines.push(`verify: ${JSON.stringify(verify)}`);
  const exec = safeJson<unknown[]>(advanced.exec, []);
  if (exec.length > 0) lines.push(`install:\n  exec: ${JSON.stringify(exec)}`);
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
  const [drafts, setDrafts] = useState<DraftRecord[]>(loadDrafts);
  const [activeId, setActiveId] = useState<string>(() => localStorage.getItem(ACTIVE_KEY) ?? '');
  const initial = drafts.find((d) => d.id === activeId) ?? drafts[0]!;
  const [form, setForm] = useState<FormState>(initial.form);
  const [resources, setResources] = useState<DraftRes[]>(initial.resources);
  const [advanced, setAdvanced] = useState<AdvancedState>(initial.advanced);
  const [docs, setDocs] = useState(initial.docs);
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
  const [outcomes, setOutcomes] = useState<{ actionId: string; op: string; status: string; message?: string }[]>([]);
  const [yamlEditing, setYamlEditing] = useState(false);
  const [yamlText, setYamlText] = useState('');
  const fileRef = useRef<HTMLInputElement | null>(null);
  const importRef = useRef<HTMLInputElement | null>(null);

  const generated = useMemo(() => toYaml(form, resources, advanced), [form, resources, advanced]);
  const yaml = yamlEditing ? yamlText : generated;

  const advancedErrors = useMemo(() => {
    const errors: Record<string, string> = {};
    const check = (key: string, text: string, kind: 'array' | 'object'): void => {
      if (!text.trim()) return;
      try {
        const value = JSON.parse(text) as unknown;
        if (kind === 'array' && !Array.isArray(value)) errors[key] = '要 JSON 数组';
        if (kind === 'object' && (Array.isArray(value) || typeof value !== 'object' || value === null)) {
          errors[key] = '要 JSON 对象';
        }
      } catch (err) {
        errors[key] = (err as Error).message;
      }
    };
    check('compositionEnv', advanced.compositionEnv, 'object');
    check('slots', advanced.slots, 'object');
    check('bindings', advanced.bindings, 'object');
    check('overrides', advanced.overrides, 'array');
    check('overlays', advanced.overlays, 'array');
    check('verify', advanced.verify, 'array');
    check('exec', advanced.exec, 'array');
    check('vars', advanced.vars, 'object');
    check('state', advanced.state, 'array');
    if (advanced.compositionEnv.trim()) {
      try {
        linesToEnv(advanced.compositionEnv);
      } catch (err) {
        errors.compositionEnv = (err as Error).message;
      }
    }
    return errors;
  }, [advanced]);

  const nameOk = /^[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9-]*$/.test(form.name);
  const versionOk = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(form.version);
  const targetsOk = form.targets.length > 0;
  const configErrors = useMemo(() => {
    const errors: Record<string, string> = {};
    for (const r of resources) {
      if (!r.config?.trim()) continue;
      try {
        const value = JSON.parse(r.config) as unknown;
        if (typeof value !== 'object' || value === null || Array.isArray(value)) {
          errors[r.key] = 'config 要 JSON 对象';
        }
      } catch (err) {
        errors[r.key] = (err as Error).message;
      }
    }
    return errors;
  }, [resources]);
  const hasErrors = Object.keys(advancedErrors).length > 0 || Object.keys(configErrors).length > 0;
  const gate = [
    { ok: nameOk && versionOk && targetsOk, text: '表单字段' },
    { ok: form.visibility === 'public' || form.visibility === 'unlisted', text: 'visibility 可发布' },
    { ok: resources.length > 0, text: '至少一个资源' },
    { ok: !hasErrors, text: '高级 JSON 可解析' },
    { ok: !issues.some((i) => i.severity === 'error'), text: '预览无错误' },
    { ok: plan !== null, text: '计划可生成' },
  ];
  const dupIds = new Set(resources.map((r) => r.id).filter((id, i, arr) => arr.indexOf(id) !== i));

  useEffect(() => {
    fetch('/api/registry')
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { packs?: PackEntry[] } | null) => setPacks(d?.packs ?? []))
      .catch(() => setPacks([]));
  }, []);

  useEffect(() => {
    localStorage.setItem(FAV_KEY, JSON.stringify(favorites));
  }, [favorites]);

  // 草稿持久化：每次改动写回当前草稿；切草稿不丢内容
  useEffect(() => {
    if (!drafts.some((d) => d.id === activeId)) setActiveId(drafts[0]!.id);
  }, [activeId, drafts]);

  useEffect(() => {
    setDrafts((prev) =>
      prev.map((d) =>
        d.id === activeId
          ? { ...d, form, resources, advanced, docs, updatedAt: new Date().toISOString() }
          : d,
      ),
    );
  }, [activeId, form, resources, advanced, docs]);

  useEffect(() => {
    localStorage.setItem(DRAFTS_KEY, JSON.stringify(drafts));
  }, [drafts]);

  useEffect(() => {
    localStorage.setItem(ACTIVE_KEY, activeId);
  }, [activeId]);

  useEffect(() => {
    if (!yamlEditing) setYamlText(generated);
  }, [generated, yamlEditing]);

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
    if (!yaml.trim()) {
      setPlan(null);
      setIssues([{ code: 'empty', severity: 'warn', message: '还没有内容：填清单或从左边加资源。' }]);
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
    setYamlEditing(false);
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

  const switchDraft = (id: string): void => {
    const next = drafts.find((d) => d.id === id);
    if (!next) return;
    setActiveId(id);
    setForm(next.form);
    setResources(next.resources);
    setAdvanced(next.advanced);
    setDocs(next.docs);
    setPlan(null);
    setIssues([]);
    setSavedDir(null);
    setYamlEditing(false);
    setDelivery({ kind: 'ok', text: `已切到「${next.label}」` });
  };

  const newDraft = (): void => {
    const record = emptyDraft(drafts.length + 1);
    setDrafts((prev) => [...prev, record]);
    setActiveId(record.id);
    setForm(record.form);
    setResources(record.resources);
    setAdvanced(record.advanced);
    setDocs(record.docs);
    setSavedDir(null);
    setYamlEditing(false);
    setDelivery({ kind: 'ok', text: `已新建「${record.label}」` });
  };

  const renameDraft = (): void => {
    const current = drafts.find((d) => d.id === activeId);
    const label = window.prompt('草稿名', current?.label ?? '草稿');
    if (!label?.trim()) return;
    setDrafts((prev) => prev.map((d) => (d.id === activeId ? { ...d, label: label.trim() } : d)));
  };

  const deleteDraft = (): void => {
    if (drafts.length <= 1) {
      setDelivery({ kind: 'error', text: '至少保留一个草稿' });
      return;
    }
    const next = drafts.filter((d) => d.id !== activeId);
    setDrafts(next);
    switchDraft(next[0]!.id);
  };

  const exportDraft = (): void => {
    const payload = { apiVersion: 'packhub.dev/draft/v0', form, resources, advanced, docs };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'packhub-draft.json';
    a.click();
    URL.revokeObjectURL(url);
  };

  const importDraft = async (file: File | null): Promise<void> => {
    if (!file) return;
    try {
      const data = JSON.parse(await file.text()) as Partial<DraftRecord>;
      const record: DraftRecord = {
        ...emptyDraft(drafts.length + 1),
        label: `导入 ${new Date().toLocaleTimeString('zh-CN')}`,
        form: { ...EMPTY_FORM, ...(data.form ?? {}) },
        resources: Array.isArray(data.resources) ? data.resources : [],
        advanced: { ...EMPTY_ADVANCED, ...(data.advanced ?? {}) },
        docs: { readme: '', changelog: '', ...(data.docs ?? {}) },
      };
      setDrafts((prev) => [...prev, record]);
      setActiveId(record.id);
      setForm(record.form);
      setResources(record.resources);
      setAdvanced(record.advanced);
      setDocs(record.docs);
      setSavedDir(null);
      setYamlEditing(false);
      setDelivery({ kind: 'ok', text: '草稿已导入' });
    } catch (err) {
      setDelivery({ kind: 'error', text: `导入失败：${(err as Error).message}` });
    }
  };

  const applyYaml = (): void => {
    try {
      const data = parseYaml(yamlText) as Record<string, unknown>;
      if (!data || typeof data !== 'object') throw new Error('YAML 不是对象');
      const meta = (data.metadata ?? {}) as Record<string, unknown>;
      const requires = (data.requires ?? {}) as Record<string, unknown>;
      setForm({
        ...EMPTY_FORM,
        name: String(meta.name ?? ''),
        version: String(meta.version ?? ''),
        title: String(meta.title ?? ''),
        description: String(meta.description ?? ''),
        keywords: Array.isArray(meta.keywords) ? meta.keywords.join(', ') : '',
        license: String(meta.license ?? ''),
        homepage: String(meta.homepage ?? ''),
        authors: meta.authors ? JSON.stringify(meta.authors, null, 2) : '',
        extends: String(data.extends ?? ''),
        agent: String(requires.agent ?? ''),
        targets: Array.isArray(meta.targets) ? meta.targets.map(String) : ['dir'],
        visibility: String(meta.visibility ?? 'private'),
      });
      setResources(
        Array.isArray(data.resources)
          ? (data.resources as ResourceInfo[]).map((r) => ({
              ...r,
              key: uid(),
              config: r.config ? JSON.stringify(r.config, null, 2) : undefined,
            }))
          : [],
      );
      const composition = (data.composition ?? {}) as Record<string, unknown>;
      const install = (data.install ?? {}) as Record<string, unknown>;
      setAdvanced({
        compositionEnv: envLines(composition.env),
        slots: data.slots ? JSON.stringify(data.slots, null, 2) : '',
        bindings: data.bindings ? JSON.stringify(data.bindings, null, 2) : '',
        overrides: data.overrides ? JSON.stringify(data.overrides, null, 2) : '',
        overlays: data.overlays ? JSON.stringify(data.overlays, null, 2) : '',
        verify: data.verify ? JSON.stringify(data.verify, null, 2) : '',
        exec: install.exec ? JSON.stringify(install.exec, null, 2) : '',
        vars: data.vars ? JSON.stringify(data.vars, null, 2) : '',
        state: data.state ? JSON.stringify(data.state, null, 2) : '',
      });
      setYamlEditing(false);
      setDelivery({ kind: 'ok', text: '已把 YAML 应用回表单' });
    } catch (err) {
      setDelivery({ kind: 'error', text: `YAML 解析失败：${(err as Error).message}` });
    }
  };

  const doSave = async (force = false): Promise<void> => {
    if (!nameOk || !versionOk || !targetsOk || hasErrors) {
      setDelivery({ kind: 'error', text: '表单 / 高级 JSON 不合法，先修' });
      return;
    }
    const dir = saveDir.trim() || `packs/${form.name}`;
    setDelivery({ kind: 'busy', text: '保存中…' });
    setConflict(null);
    try {
      const res = await fetch('/api/packs/create', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ dir, manifest: yaml, docs, force }),
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
      setDelivery({ kind: 'ok', text: `已保存到 ${data.dir ?? dir}（清单 + PACK.md / CHANGELOG）` });
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
        outcomes?: { actionId: string; op: string; status: string; message?: string }[];
        root?: string;
        error?: string;
        issues?: { message: string }[];
      };
      if (!res.ok) {
        setDelivery({ kind: 'error', text: data.error ?? data.issues?.map((i) => i.message).join('; ') ?? '安装失败' });
        return;
      }
      setOutcomes(data.outcomes ?? []);
      const bad = (data.outcomes ?? []).filter((o) => o.status !== 'done' && o.status !== 'noop');
      setDelivery(
        bad.length === 0
          ? { kind: 'ok', text: `${dryRun ? '预演完成' : '安装完成'}：${(data.outcomes ?? []).length} 个动作 → ${data.root ?? 'Pack 目录'}` }
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
    const copyName = `${form.name}-copy`;
    const copyVersion = bumpVersion(form.version);
    setDelivery({ kind: 'busy', text: '保存副本…' });
    try {
      const res = await fetch('/api/packs/create', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          dir,
          manifest: toYaml(form, resources, advanced, { name: copyName, version: copyVersion }),
          docs,
        }),
      });
      const data = (await res.json()) as { dir?: string; error?: string; issues?: { message: string }[] };
      if (!res.ok) {
        setDelivery({ kind: 'error', text: data.error ?? data.issues?.map((i) => i.message).join('; ') ?? '保存副本失败' });
        return;
      }
      setSavedDir(data.dir ?? dir);
      setDelivery({ kind: 'ok', text: `副本已保存到 ${data.dir ?? dir}（${copyName}@${copyVersion}）` });
    } catch (err) {
      setDelivery({ kind: 'error', text: (err as Error).message });
    }
  };

  const uploadFiles = async (files: FileList | null): Promise<void> => {
    if (!files || files.length === 0) return;
    const dir = saveDir.trim() || `packs/${form.name}`;
    setDelivery({ kind: 'busy', text: `上传 ${files.length} 个文件…` });
    try {
      const added: DraftRes[] = [];
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
    setAdvanced({ ...EMPTY_ADVANCED });
    setDocs({ readme: '', changelog: '' });
    setPlan(null);
    setIssues([]);
    setSavedDir(null);
    setConflict(null);
    setOutcomes([]);
    setYamlEditing(false);
    setDelivery({ kind: 'ok', text: '已清空当前草稿' });
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

  const updateResource = (index: number, patch: Partial<DraftRes>): void => {
    setResources((prev) => prev.map((r, i) => (i === index ? { ...r, ...patch } : r)));
  };

  const toggleExpanded = (key: string): void => {
    setExpandedRes((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const slotDefs = safeJson<Record<string, { contract?: string[]; note?: string }>>(advanced.slots, {});
  const bindingDefs = safeJson<Record<string, string>>(advanced.bindings, {});
  const slotNames = [
    ...new Set([
      ...Object.keys(slotDefs),
      ...resources.map((r) => r.slot).filter((s): s is string => Boolean(s)),
    ]),
  ];
  const verifyList = safeJson<{ type: string }[]>(advanced.verify, []);
  const execList = safeJson<{ command?: string }[]>(advanced.exec, []);

  const updateSlot = (slot: string, patch: { contract?: string[] }): void => {
    const next = { ...slotDefs, [slot]: { ...slotDefs[slot], ...patch } };
    setAdvanced({ ...advanced, slots: JSON.stringify(next, null, 2) });
  };
  const updateBinding = (slot: string, id: string): void => {
    const next = { ...bindingDefs };
    if (id) next[slot] = id;
    else delete next[slot];
    setAdvanced({ ...advanced, bindings: JSON.stringify(next, null, 2) });
  };
  const addSlot = (): void => {
    const name = window.prompt('槽位名（小写字母开头，只含小写字母/数字/连字符）')?.trim();
    if (!name) return;
    if (!/^[a-z][a-z0-9-]*$/.test(name)) {
      setDelivery({ kind: 'error', text: `槽位名不合法：${name}` });
      return;
    }
    updateSlot(name, { contract: slotDefs[name]?.contract ?? [] });
  };
  const removeSlot = (slot: string): void => {
    const next = { ...slotDefs };
    delete next[slot];
    const nextBindings = { ...bindingDefs };
    delete nextBindings[slot];
    setAdvanced({
      ...advanced,
      slots: JSON.stringify(next, null, 2),
      bindings: JSON.stringify(nextBindings, null, 2),
    });
  };
  const addCheck = (type: string): void => {
    const sample: Record<string, unknown> =
      type === 'file-exists'
        ? { type, path: '.packhub/knowledge/example.md' }
        : type === 'config-key'
          ? { type, path: '.packhub/config.json', key: 'app.flavor', equals: 'a' }
          : type === 'command'
            ? { type, run: ['node', '--version'], expectExit: 0 }
            : { type, run: ['node', '-e', 'console.log("ok")'], expectExit: 0, expectOutput: 'ok' };
    setAdvanced({ ...advanced, verify: JSON.stringify([...verifyList, sample], null, 2) });
  };
  const removeCheck = (index: number): void => {
    setAdvanced({
      ...advanced,
      verify: JSON.stringify(verifyList.filter((_, i) => i !== index), null, 2),
    });
  };
  const addExec = (): void => {
    setAdvanced({
      ...advanced,
      exec: JSON.stringify([...execList, { command: 'node', args: ['--version'] }], null, 2),
    });
  };
  const removeExec = (index: number): void => {
    setAdvanced({
      ...advanced,
      exec: JSON.stringify(execList.filter((_, i) => i !== index), null, 2),
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

  const jumpToIssue = (path?: string): void => {
    if (!path) return;
    const numeric = /resources\/(\d+)|resources\[(\d+)\]/.exec(path);
    if (numeric) {
      const index = Number(numeric[1] ?? numeric[2]);
      const el = document.getElementById(`res-${index}`);
      el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      el?.querySelector<HTMLInputElement>('input')?.focus();
      return;
    }
    const byId = /resources\.([a-z][a-z0-9-]*)/.exec(path);
    if (byId) {
      const index = resources.findIndex((r) => r.id === byId[1]);
      if (index >= 0) {
        const el = document.getElementById(`res-${index}`);
        el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
        el?.querySelector<HTMLInputElement>('input')?.focus();
        return;
      }
    }
    const field =
      path.includes('metadata.name') ? 'f-name'
      : path.includes('metadata.version') ? 'f-version'
      : path.includes('metadata.targets') ? 'f-targets'
      : path.includes('composition') ? 'adv-composition'
      : path.includes('verify') ? 'adv-verify'
      : path.includes('install') ? 'adv-exec'
      : path.includes('overlays') ? 'adv-overlays'
      : path.includes('overrides') ? 'adv-overrides'
      : path.includes('slots') ? 'adv-slots'
      : path.includes('bindings') ? 'adv-bindings'
      : path.includes('vars') ? 'adv-vars'
      : '';
    if (!field) return;
    const el = document.getElementById(field);
    el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el?.querySelector<HTMLInputElement | HTMLTextAreaElement>('input, textarea')?.focus();
  };

  const errors = issues.filter((i) => i.severity === 'error');
  const favByKey = new Set(favorites.map((f) => `${f.pack}#${f.id}`));

  const renderResource = (r: DraftRes, i: number) => {
    const idOk = /^[a-z][a-z0-9-]*$/.test(r.id);
    const kind = sourceKind(r.source);
    const expanded = expandedRes.has(r.key);
    return (
      <div className="cs-resblock" key={r.key} id={`res-${i}`}>
        <div className="cs-restable-row">
          <input
            aria-label={`资源 ${i + 1} id`}
            value={r.id}
            aria-invalid={!idOk}
            onChange={(e) => updateResource(i, { id: e.target.value })}
          />
          <select
            aria-label={`资源 ${r.id} 类型`}
            value={r.type}
            onChange={(e) => updateResource(i, { type: e.target.value })}
          >
            {RESOURCE_TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
          <input
            aria-label={`资源 ${r.id} source`}
            value={r.source}
            aria-invalid={kind.kind === 'unknown'}
            onChange={(e) => updateResource(i, { source: e.target.value })}
          />
          <input
            className="cs-slot"
            aria-label={`资源 ${r.id} 槽位`}
            placeholder="slot"
            value={r.slot ?? ''}
            onChange={(e) => updateResource(i, { slot: e.target.value || undefined })}
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
              className="cs-rowbtn"
              onClick={() => toggleExpanded(r.key)}
              title="高级字段"
              aria-label={`${expanded ? '收起' : '展开'} ${r.id} 高级字段`}
            >
              {expanded ? '−' : '+'}
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
        </div>
        <div className="cs-resmeta">
          <span className={kind.kind === 'unknown' ? 'cs-field-error' : 'cs-hint-inline'}>
            {kind.kind} · {kind.hint}
          </span>
          {kind.kind !== 'local' && kind.kind !== 'unknown' && (
            <span className={kind.pinned ? 'cs-hint-inline' : 'cs-field-error'}>
              {kind.pinned ? 'pin 已锁' : 'pin 未锁，发布前会被拒'}
            </span>
          )}
          {!idOk && <span className="cs-field-error">id 要小写字母开头，只含小写字母/数字/连字符</span>}
          {dupIds.has(r.id) && <span className="cs-field-error">id 重复：{r.id}</span>}
          {configErrors[r.key] && <span className="cs-field-error">config：{configErrors[r.key]}</span>}
        </div>
        {expanded && (
          <div className="cs-resadv">
            <label>
              provides（逗号）
              <input
                value={(r.provides ?? []).join(', ')}
                onChange={(e) => updateResource(i, { provides: splitList(e.target.value) })}
              />
            </label>
            <label>
              needs（逗号）
              <input
                value={(r.needs ?? []).join(', ')}
                onChange={(e) => updateResource(i, { needs: splitList(e.target.value) })}
              />
            </label>
            <label>
              dependsOn（逗号）
              <input
                value={(r.dependsOn ?? []).join(', ')}
                onChange={(e) => updateResource(i, { dependsOn: splitList(e.target.value) })}
              />
            </label>
            <label>
              transport
              <select
                value={r.transport ?? ''}
                onChange={(e) => updateResource(i, { transport: e.target.value || undefined })}
              >
                <option value="">默认</option>
                <option value="stdio">stdio</option>
                <option value="http">http</option>
              </select>
            </label>
            <label>
              integrity
              <input
                value={r.integrity ?? ''}
                placeholder="sha256-…"
                onChange={(e) => updateResource(i, { integrity: e.target.value || undefined })}
              />
            </label>
            <label>
              auth.env
              <input
                value={r.auth?.env ?? ''}
                placeholder="NPM_TOKEN"
                onChange={(e) =>
                  updateResource(i, {
                    auth: e.target.value ? { env: e.target.value, scheme: r.auth?.scheme ?? 'bearer' } : undefined,
                  })
                }
              />
            </label>
            <label className="cs-check">
              <input
                type="checkbox"
                checked={r.optional === true}
                onChange={(e) => updateResource(i, { optional: e.target.checked })}
              />
              optional（缺能力时跳过）
            </label>
            <div className="cs-targetchecks">
              <span className="cs-label">targets</span>
              {TARGETS.map((t) => (
                <label key={t} className="cs-check">
                  <input
                    type="checkbox"
                    checked={(r.targets ?? []).includes(t)}
                    onChange={(e) =>
                      updateResource(i, {
                        targets: e.target.checked
                          ? [...(r.targets ?? []), t]
                          : (r.targets ?? []).filter((x) => x !== t),
                      })
                    }
                  />
                  {t}
                </label>
              ))}
            </div>
            <label className="cs-span">
              config（JSON 对象）
              <textarea
                rows={3}
                value={r.config ?? ''}
                onChange={(e) => updateResource(i, { config: e.target.value || undefined })}
              />
            </label>
          </div>
        )}
      </div>
    );
  };

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
        <label className="cs-draft">
          草稿
          <select value={activeId} onChange={(e) => switchDraft(e.target.value)} aria-label="切换草稿">
            {drafts.map((d) => (
              <option key={d.id} value={d.id}>
                {d.label}
              </option>
            ))}
          </select>
        </label>
        <button className="cs-btn ghost" onClick={newDraft}>
          新建
        </button>
        <button className="cs-btn ghost" onClick={renameDraft}>
          重命名
        </button>
        <button className="cs-btn ghost" onClick={deleteDraft}>
          删除
        </button>
        <button className="cs-btn ghost" onClick={exportDraft}>
          导出
        </button>
        <button className="cs-btn ghost" onClick={() => importRef.current?.click()}>
          导入
        </button>
        <input
          ref={importRef}
          type="file"
          accept="application/json"
          aria-label="导入草稿"
          className="cs-file"
          onChange={(e) => {
            void importDraft(e.target.files?.[0] ?? null);
            e.target.value = '';
          }}
        />
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
                <button onClick={() => addResource(f)} title="加入当前草稿" aria-label={`加入 ${f.id}`}>
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
                      aria-label={`收藏 ${r.id}`}
                    >
                      ☆
                    </button>
                    <button onClick={() => addResource(r)} title="加入草稿" aria-label={`加入 ${r.id}`}>
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
                  id="f-name"
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
                  id="f-version"
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
            </div>
            <div className="cs-row three">
              <label>
                authors
                <input
                  value={form.authors}
                  placeholder="名字，或 JSON 数组"
                  onChange={(e) => setForm({ ...form, authors: e.target.value })}
                />
              </label>
              <label>
                extends
                <input
                  value={form.extends}
                  placeholder="../base 或 packhub://scope/name@1.0.0"
                  onChange={(e) => setForm({ ...form, extends: e.target.value })}
                  spellCheck={false}
                />
              </label>
              <label>
                requires.agent
                <input
                  value={form.agent}
                  placeholder="dsh / claude-code / codex / opencode"
                  onChange={(e) => setForm({ ...form, agent: e.target.value })}
                />
              </label>
            </div>
            <div className="cs-row">
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
            <div className="cs-row" id="f-targets">
              <span className="cs-label">targets</span>
              {TARGETS.map((t) => (
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
                  aria-label="上传文件"
                  className="cs-file"
                  onChange={(e) => {
                    void uploadFiles(e.target.files);
                    e.target.value = '';
                  }}
                />
              </span>
            </div>
            {resources.length === 0 && <p className="cs-hint">从左边收藏或包资源里点 + 添加。</p>}
            {resources.map(renderResource)}
          </div>

          <details className="cs-adv" id="adv-composition">
            <summary>composition（env）</summary>
            <div className="cs-advgrid">
              <label className="cs-span">
                env（每行 KEY=value）
                <textarea
                  rows={3}
                  value={advanced.compositionEnv}
                  onChange={(e) => setAdvanced({ ...advanced, compositionEnv: e.target.value })}
                />
                {advancedErrors.compositionEnv && <span className="cs-field-error">{advancedErrors.compositionEnv}</span>}
              </label>
            </div>
          </details>

          <details className="cs-adv" id="adv-slots">
            <summary>slots / bindings（槽位与绑定）</summary>
            <div className="cs-slotlist">
              <div className="cs-reslist-head">
                <span>{slotNames.length} 个槽位</span>
                <button className="cs-link" onClick={addSlot}>
                  + 添加槽位
                </button>
              </div>
              {slotNames.length === 0 && <p className="cs-hint">资源里填了 slot 后，这里可以声明契约并选择绑定实现。</p>}
              {slotNames.map((slot) => {
                const candidates = resources.filter((r) => r.slot === slot);
                return (
                  <div className="cs-slotrow" key={slot}>
                    <code>{slot}</code>
                    <label>
                      契约（逗号）
                      <input
                        value={(slotDefs[slot]?.contract ?? []).join(', ')}
                        onChange={(e) => updateSlot(slot, { contract: splitList(e.target.value) })}
                      />
                    </label>
                    <label>
                      绑定实现
                      <select value={bindingDefs[slot] ?? ''} onChange={(e) => updateBinding(slot, e.target.value)}>
                        <option value="">未绑定</option>
                        {candidates.map((r) => (
                          <option key={r.key} value={r.id}>
                            {r.id}
                          </option>
                        ))}
                      </select>
                    </label>
                    <button className="cs-rowbtn" onClick={() => removeSlot(slot)} aria-label={`删除槽位 ${slot}`}>
                      ×
                    </button>
                  </div>
                );
              })}
            </div>
            <div className="cs-advgrid">
              <label>
                slots（原始 JSON）
                <textarea
                  rows={3}
                  value={advanced.slots}
                  onChange={(e) => setAdvanced({ ...advanced, slots: e.target.value })}
                />
                {advancedErrors.slots && <span className="cs-field-error">{advancedErrors.slots}</span>}
              </label>
              <label id="adv-bindings">
                bindings（原始 JSON）
                <textarea
                  rows={3}
                  value={advanced.bindings}
                  onChange={(e) => setAdvanced({ ...advanced, bindings: e.target.value })}
                />
                {advancedErrors.bindings && <span className="cs-field-error">{advancedErrors.bindings}</span>}
              </label>
            </div>
          </details>

          <details className="cs-adv" id="adv-overrides">
            <summary>overrides / overlays（覆盖）</summary>
            <div className="cs-advgrid">
              <label>
                overrides（JSON 数组）
                <textarea
                  rows={3}
                  value={advanced.overrides}
                  onChange={(e) => setAdvanced({ ...advanced, overrides: e.target.value })}
                />
                {advancedErrors.overrides && <span className="cs-field-error">{advancedErrors.overrides}</span>}
              </label>
              <label id="adv-overlays">
                overlays（JSON 数组）
                <textarea
                  rows={3}
                  value={advanced.overlays}
                  onChange={(e) => setAdvanced({ ...advanced, overlays: e.target.value })}
                />
                {advancedErrors.overlays && <span className="cs-field-error">{advancedErrors.overlays}</span>}
              </label>
            </div>
          </details>

          <details className="cs-adv" id="adv-verify">
            <summary>verify / install.exec（校验与安装命令）</summary>
            <div className="cs-slotlist">
              <div className="cs-reslist-head">
                <span>verify {verifyList.length} 项</span>
                <span className="cs-reslist-actions">
                  {['file-exists', 'config-key', 'command', 'scenario'].map((type) => (
                    <button className="cs-link" key={type} onClick={() => addCheck(type)}>
                      + {type}
                    </button>
                  ))}
                </span>
              </div>
              {verifyList.map((check, index) => (
                <div className="cs-slotrow" key={`${check.type}-${index}`}>
                  <code>{check.type}</code>
                  <span className="cs-hint-inline">在下方 JSON 里改参数</span>
                  <button className="cs-rowbtn" onClick={() => removeCheck(index)} aria-label={`删除校验 ${index}`}>
                    ×
                  </button>
                </div>
              ))}
              <div className="cs-reslist-head">
                <span>install.exec {execList.length} 条（默认不执行）</span>
                <button className="cs-link" onClick={addExec}>
                  + 命令
                </button>
              </div>
              {execList.map((item, index) => (
                <div className="cs-slotrow" key={`exec-${index}`}>
                  <code>{item.command ?? 'command'}</code>
                  <span className="cs-hint-inline">需 --allow-exec 才执行</span>
                  <button className="cs-rowbtn" onClick={() => removeExec(index)} aria-label={`删除命令 ${index}`}>
                    ×
                  </button>
                </div>
              ))}
            </div>
            <div className="cs-advgrid">
              <label>
                verify（JSON 数组）
                <textarea
                  rows={4}
                  value={advanced.verify}
                  onChange={(e) => setAdvanced({ ...advanced, verify: e.target.value })}
                />
                {advancedErrors.verify && <span className="cs-field-error">{advancedErrors.verify}</span>}
              </label>
              <label id="adv-exec">
                install.exec（JSON 数组；默认不执行，需 --allow-exec）
                <textarea
                  rows={4}
                  value={advanced.exec}
                  onChange={(e) => setAdvanced({ ...advanced, exec: e.target.value })}
                />
                {advancedErrors.exec && <span className="cs-field-error">{advancedErrors.exec}</span>}
              </label>
            </div>
          </details>

          <details className="cs-adv">
            <summary>vars / state（变量与持久状态）</summary>
            <div className="cs-advgrid">
              <label id="adv-vars">
                vars（JSON 对象）
                <textarea
                  rows={3}
                  value={advanced.vars}
                  onChange={(e) => setAdvanced({ ...advanced, vars: e.target.value })}
                />
                {advancedErrors.vars && <span className="cs-field-error">{advancedErrors.vars}</span>}
              </label>
              <label id="adv-state">
                state（JSON 数组：id / path / retain: keep|remove）
                <textarea
                  rows={3}
                  value={advanced.state}
                  onChange={(e) => setAdvanced({ ...advanced, state: e.target.value })}
                  placeholder={'[{"id":"memory","description":"长期记忆"}]'}
                />
                {advancedErrors.state && <span className="cs-field-error">{advancedErrors.state}</span>}
              </label>
            </div>
          </details>

          <details className="cs-adv">
            <summary>PACK.md / CHANGELOG（随保存写入）</summary>
            <div className="cs-advgrid">
              <label>
                PACK.md
                <textarea
                  rows={5}
                  value={docs.readme}
                  onChange={(e) => setDocs({ ...docs, readme: e.target.value })}
                />
              </label>
              <label>
                CHANGELOG.md
                <textarea
                  rows={5}
                  value={docs.changelog}
                  onChange={(e) => setDocs({ ...docs, changelog: e.target.value })}
                />
              </label>
            </div>
          </details>

          <details className="cs-yaml">
            <summary>直接编辑 yaml（可应用回表单）</summary>
            <textarea
              className="cs-yaml-edit"
              rows={18}
              value={yamlText}
              spellCheck={false}
              onChange={(e) => {
                setYamlEditing(true);
                setYamlText(e.target.value);
              }}
            />
            <div className="cs-yaml-actions">
              <button className="cs-btn ghost" onClick={() => setYamlEditing(false)}>
                从表单刷新
              </button>
              <button className="cs-btn" onClick={applyYaml}>
                应用 YAML
              </button>
              {yamlEditing && <span className="cs-hint-inline">正在编辑 YAML；表单改动不会覆盖它</span>}
            </div>
          </details>
        </section>

        <aside className="cs-preview">
          <h2>预览</h2>
          {issues.length > 0 && (
            <ul className="cs-issues">
              {issues.map((i2, idx) => (
                <li key={idx} className={i2.severity === 'error' ? 'bad' : 'warn'}>
                  <button className="cs-issue" onClick={() => jumpToIssue(i2.path)} title="跳到对应字段">
                    <code>{i2.code}</code>
                    {i2.message}
                  </button>
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
                  跳过：
                  {plan.excluded
                    .map((e) => `${e.resource}（${e.reason === 'target-mismatch' ? 'target 不匹配' : e.reason === 'optional-unmet' ? 'optional 能力缺失' : `槽位 ${e.slot} 未绑定`}）`)
                    .join('、')}
                </p>
              )}
            </>
          )}
          <section className="cs-deliver">
            <h3>保存与发布</h3>
            <ul className="cs-gates">
              {gate.map((g) => (
                <li key={g.text} className={g.ok ? 'ok' : 'bad'}>
                  {g.ok ? '✓' : 'x'} {g.text}
                </li>
              ))}
            </ul>
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
              <button className="cs-btn" onClick={() => void doSave()} disabled={hasErrors}>
                保存到目录
              </button>
              <button className="cs-btn ghost" onClick={() => void doSaveCopy()} disabled={hasErrors}>
                保存为副本
              </button>
              <button className="cs-btn ghost" onClick={() => void doInstall(true)} disabled={!savedDir}>
                预演安装
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
            {outcomes.length > 0 && (
              <ul className="cs-outcomes">
                {outcomes.map((o) => (
                  <li key={o.actionId} className={o.status === 'failed' ? 'bad' : ''}>
                    <code>{o.actionId}</code> {o.op} · {o.status}
                    {o.message ? ` · ${o.message}` : ''}
                  </li>
                ))}
              </ul>
            )}
            <p className="cs-hint">
              保存写清单与两份文档；本地 source 指向的文件仍需放进该目录。发布前会跑干净安装与校验。
            </p>
          </section>
          {!plan && issues.length === 0 && <p className="cs-hint">改动会自动预览；点「预览计划」强制重算。</p>}
          {errors.length > 0 && <p className="cs-hint">有 {errors.length} 个错误，修完再看计划。</p>}
        </aside>
      </div>
    </div>
  );
}
