import { readFileSync, writeFileSync } from 'node:fs';
import { parseDocument } from 'yaml';
import type { Manifest, ResourceType } from '@packhub/kernel';
import { MANIFEST_FILE } from '@packhub/kernel';

export interface AddResourceInput {
  type: ResourceType;
  source: string;
  id?: string;
}

export interface AddResourceResult {
  id: string;
  manifest: Manifest;
}

/** 从 source 推断一个资源 id；重名时自动加序号。 */
export function inferId(source: string, taken: string[] = []): string {
  let base: string;
  if (source.startsWith('npm:')) {
    const body = source.slice(4);
    // `@scope/pkg@1.2.3`：版本前那个 @ 才是分隔符，开头的 @ 是 scope
    const at = body.lastIndexOf('@');
    const name = at > 0 ? body.slice(0, at) : body;
    base = name.split('/').filter(Boolean).pop() ?? 'resource';
  } else if (source.startsWith('pypi:')) {
    base = source.slice(5).split('@')[0] ?? 'resource';
  } else if (source.startsWith('github:')) {
    const body = source.slice('github:'.length).split('@')[0] ?? '';
    base = body.split('/').filter(Boolean).pop() ?? 'resource';
  } else {
    const clean = source.split('?')[0] ?? source;
    base = clean.split('/').filter(Boolean).pop() ?? 'resource';
    base = base.replace(/\.[a-z0-9]+$/i, '');
  }
  const slug = base
    .toLowerCase()
    .replace(/^@/, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'resource';
  const safe = /^[a-z]/.test(slug) ? slug : `r-${slug}`;
  if (!taken.includes(safe)) return safe;
  let n = 2;
  while (taken.includes(`${safe}-${n}`)) n++;
  return `${safe}-${n}`;
}

/**
 * 往 packhub.yaml 里追加一个资源，保留原有格式与注释。
 * 只做结构化编辑，判断（能不能装、能力图对不对）仍交给 plan/verify。
 */
export function addResource(manifestPath: string, input: AddResourceInput): AddResourceResult {
  const text = readFileSync(manifestPath, 'utf8');
  const doc = parseDocument(text);
  if (doc.errors.length > 0) {
    throw new Error(`${MANIFEST_FILE} 解析失败：${doc.errors[0]?.message ?? '未知错误'}`);
  }

  const current = doc.toJS() as Manifest;
  const taken = (current.resources ?? []).map((r) => r.id);
  const id = input.id ?? inferId(input.source, taken);
  if (taken.includes(id)) throw new Error(`资源 id 已存在：${id}`);

  const resource: Record<string, unknown> = { id, type: input.type, source: input.source };
  if (input.type === 'mcp') resource.transport = 'stdio';

  if (doc.has('resources')) {
    doc.addIn(['resources'], resource);
  } else {
    doc.set('resources', [resource]);
  }

  writeFileSync(manifestPath, doc.toString({ lineWidth: 100 }), 'utf8');
  return { id, manifest: doc.toJS() as Manifest };
}

/**
 * 改角色实现：只动 pick.<role> 一个键，其它内容与注释保持原样。
 * 换实现 = 一行，这是「快速替换」的入口。
 */
export function setPick(manifestPath: string, role: string, resourceId: string): AddResourceResult {
  const text = readFileSync(manifestPath, 'utf8');
  const doc = parseDocument(text);
  if (doc.errors.length > 0) {
    throw new Error(`${MANIFEST_FILE} 解析失败：${doc.errors[0]?.message ?? '未知错误'}`);
  }
  const current = doc.toJS() as Manifest;
  const roles = current.roles ?? {};
  if (!roles[role]) throw new Error(`没有声明角色：${role}`);
  const res = current.resources.find((r) => r.id === resourceId);
  if (!res) throw new Error(`没有这个资源：${resourceId}`);
  if (res.role !== role) {
    throw new Error(`资源 ${resourceId} 不占角色 ${role}（它属于 ${res.role ?? '无角色'}）`);
  }

  if (doc.has('pick')) {
    doc.setIn(['pick', role], resourceId);
  } else {
    doc.set('pick', { [role]: resourceId });
  }
  writeFileSync(manifestPath, doc.toString({ lineWidth: 100 }), 'utf8');
  return { id: resourceId, manifest: doc.toJS() as Manifest };
}

/** 追加一条签名（保留注释与格式），同一 key 覆盖旧的。 */
export function addSignature(
  manifestPath: string,
  signature: { key: string; sig: string; at?: string },
): void {
  const text = readFileSync(manifestPath, 'utf8');
  const doc = parseDocument(text);
  if (doc.errors.length > 0) throw new Error(`${MANIFEST_FILE} 解析失败：${doc.errors[0]?.message}`);
  const current = doc.toJS() as Manifest;
  const others = (current.signatures ?? []).filter((s) => s.key !== signature.key);
  doc.set('signatures', [...others, signature]);
  writeFileSync(manifestPath, doc.toString({ lineWidth: 100 }), 'utf8');
}
