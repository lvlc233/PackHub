import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MANIFEST_FILE, PACK_NAME_PATTERN, PACK_VERSION_PATTERN, parseManifest } from '@packhub/kernel';

export interface PackResourceInfo {
  id: string;
  type: string;
  source: string;
  slot?: string;
  transport?: string;
  provides?: string[];
}

export interface PackResourcesResult {
  name: string;
  version: string;
  meta: {
    title?: string;
    description?: string;
    targets: string[];
    keywords?: string[];
  };
  resources: PackResourceInfo[];
}

/**
 * 读 registry 里某个版本的清单，把 metadata 与 resources 拆出来给创作台用。
 * 只读：不解包、不联网。
 */
export function collectPackResources(
  root: string,
  name: string,
  version?: string,
): PackResourcesResult | null {
  // 包名与版本号的形状跟 kernel 同一条判据（schema 派生），不在每个读入口各写一份正则
  if (!PACK_NAME_PATTERN.test(name)) return null;
  let v = version ?? '';
  if (!v) {
    const idxPath = join(root, 'registry/index.json');
    if (!existsSync(idxPath)) return null;
    const idx = JSON.parse(readFileSync(idxPath, 'utf8')) as {
      packs?: { name: string; latest: string }[];
    };
    v = idx.packs?.find((x) => x.name === name)?.latest ?? '';
  }
  if (!PACK_VERSION_PATTERN.test(v)) return null;

  const manifestPath = join(root, 'registry/packs', name, v, MANIFEST_FILE);
  if (!existsSync(manifestPath)) return null;
  const parsed = parseManifest(readFileSync(manifestPath, 'utf8'), manifestPath);
  if (!parsed.manifest) return null;
  const m = parsed.manifest.metadata;

  return {
    name,
    version: v,
    meta: {
      ...(m.title ? { title: m.title } : {}),
      ...(m.description ? { description: m.description } : {}),
      targets: m.targets,
      ...(m.keywords ? { keywords: m.keywords } : {}),
    },
    resources: parsed.manifest.resources.map((r) => ({
      id: r.id,
      type: r.type,
      source: r.source,
      ...(r.slot ? { slot: r.slot } : {}),
      ...(r.transport ? { transport: r.transport } : {}),
      ...(r.provides ? { provides: r.provides } : {}),
    })),
  };
}
