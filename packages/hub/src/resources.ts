import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseManifest } from '@packhub/kernel';

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
  if (!/^[a-z0-9-]+\/[a-z0-9-]+$/.test(name)) return null;
  let v = version ?? '';
  if (!v) {
    const idxPath = join(root, 'registry/index.json');
    if (!existsSync(idxPath)) return null;
    const idx = JSON.parse(readFileSync(idxPath, 'utf8')) as {
      packs?: { name: string; latest: string }[];
    };
    v = idx.packs?.find((x) => x.name === name)?.latest ?? '';
  }
  if (!/^\d+\.\d+\.\d+/.test(v)) return null;

  const manifestPath = join(root, 'registry/packs', name, v, 'packhub.yaml');
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
