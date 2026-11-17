import { RESOURCE_TYPES, isResourceType, type Issue, type ResourceType, type TargetId } from './types.ts';
import { ISSUE_CODES } from './issueCodes.ts';

/** 资源目录的格式版本：`registry/resources.json` 与 `schema/resources.v0.schema.json` 用的是同一个值。 */
export const RESOURCES_API_VERSION = 'packhub.dev/resources/v0';

/** 资源目录里的一条候选：不是 Pack，只是「可以装进 Pack 的东西」。 */
export interface CatalogEntry {
  id: string;
  type: ResourceType;
  source: string;
  title?: string;
  description?: string;
  keywords?: string[];
  provides?: string[];
  homepage?: string;
  targets?: TargetId[];
}

export interface ResourceCatalog {
  apiVersion: typeof RESOURCES_API_VERSION;
  resources: CatalogEntry[];
}

/** 只做结构校验；source 能不能解析留给 plan（目录可能收着暂不可用的候选）。 */
export function parseCatalog(raw: unknown): { catalog?: ResourceCatalog; issues: Issue[] } {
  const issues: Issue[] = [];
  if (!raw || typeof raw !== 'object') {
    return { issues: [{ code: ISSUE_CODES.catalogShape, severity: 'error', message: '资源目录不是对象' }] };
  }
  const data = raw as Record<string, unknown>;
  if (data.apiVersion !== RESOURCES_API_VERSION) {
    issues.push({
      code: ISSUE_CODES.catalogVersion,
      severity: 'error',
      message: `不认识的资源目录版本：${String(data.apiVersion)}（只支持 ${RESOURCES_API_VERSION}）`,
    });
  }
  if (!Array.isArray(data.resources)) {
    issues.push({ code: ISSUE_CODES.catalogShape, severity: 'error', message: 'resources 必须是数组' });
    return { issues };
  }
  const entries: CatalogEntry[] = [];
  const seen = new Set<string>();
  for (const [i, item] of data.resources.entries()) {
    if (!item || typeof item !== 'object') {
      issues.push({ code: ISSUE_CODES.catalogEntry, severity: 'error', message: `resources[${i}] 不是对象` });
      continue;
    }
    const e = item as Record<string, unknown>;
    if (typeof e.id !== 'string' || !e.id.trim()) {
      issues.push({ code: ISSUE_CODES.catalogEntry, severity: 'error', message: `resources[${i}] 缺少 id` });
      continue;
    }
    if (typeof e.source !== 'string' || !e.source.trim()) {
      issues.push({ code: ISSUE_CODES.catalogEntry, severity: 'error', message: `resources[${i}] 缺少 source` });
      continue;
    }
    if (!isResourceType(e.type)) {
      issues.push({
        code: ISSUE_CODES.catalogEntry,
        severity: 'error',
        message: `resources[${i}].type 不合法：${String(e.type)}（可选 ${RESOURCE_TYPES.join(' / ')}）`,
      });
      continue;
    }
    if (seen.has(e.id)) {
      issues.push({ code: ISSUE_CODES.catalogDuplicate, severity: 'error', message: `资源目录 id 重复：${e.id}` });
      continue;
    }
    seen.add(e.id);
    entries.push({
      id: e.id.trim(),
      type: e.type as ResourceType,
      source: e.source.trim(),
      ...(typeof e.title === 'string' ? { title: e.title } : {}),
      ...(typeof e.description === 'string' ? { description: e.description } : {}),
      ...(Array.isArray(e.keywords) ? { keywords: e.keywords.map(String) } : {}),
      ...(Array.isArray(e.provides) ? { provides: e.provides.map(String) } : {}),
      ...(typeof e.homepage === 'string' ? { homepage: e.homepage } : {}),
      ...(Array.isArray(e.targets) ? { targets: e.targets as TargetId[] } : {}),
    });
  }
  return { catalog: { apiVersion: RESOURCES_API_VERSION, resources: entries }, issues };
}

export interface CatalogHit {
  entry: CatalogEntry;
  score: number;
  /** 命中的字段：便于在输出里解释为什么是它 */
  matched: string[];
}

/** 关键词搜索：id/title/keywords 命中权重高于描述，空关键词返回全部。 */
export function searchResources(entries: CatalogEntry[], keyword: string): CatalogHit[] {
  const terms = keyword
    .toLowerCase()
    .split(/\s+/)
    .map((t) => t.trim())
    .filter(Boolean);
  const hits: CatalogHit[] = [];
  for (const entry of entries) {
    const fields: [string, string, number][] = [
      ['id', entry.id, 6],
      ['title', entry.title ?? '', 5],
      ['keywords', (entry.keywords ?? []).join(' '), 4],
      ['provides', (entry.provides ?? []).join(' '), 3],
      ['description', entry.description ?? '', 2],
      ['source', entry.source, 1],
    ];
    let score = 0;
    const matched = new Set<string>();
    for (const term of terms) {
      let hit = false;
      for (const [name, text, weight] of fields) {
        if (text.toLowerCase().includes(term)) {
          score += weight;
          matched.add(name);
          hit = true;
        }
      }
      if (!hit) {
        score = 0;
        break;
      }
    }
    if (terms.length === 0 || score > 0) hits.push({ entry, score, matched: [...matched] });
  }
  return hits.sort((a, b) => b.score - a.score || a.entry.id.localeCompare(b.entry.id));
}
