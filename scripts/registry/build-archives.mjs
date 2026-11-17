#!/usr/bin/env node
// 把 registry 里的每个版本目录打成 .phub（vendored），路径遵循 archivePath 约定：
// registry/packs/<scope>/<name>/<version>.phub
import { readdirSync, existsSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { packVersionArchive } from '../../packages/registry/src/index.ts';

const ROOT = resolve(import.meta.dirname, '../..');
const PACKS = join(ROOT, 'registry/packs');

function dirs(p) {
  if (!existsSync(p)) return [];
  return readdirSync(p, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
    .map((d) => d.name)
    .sort();
}

let built = 0;
for (const scope of dirs(PACKS)) {
  for (const name of dirs(join(PACKS, scope))) {
    for (const version of dirs(join(PACKS, scope, name))) {
      if (!/^\d+\.\d+\.\d+/.test(version)) continue;
      const dir = join(PACKS, scope, name, version);
      const out = join(PACKS, scope, name, `${version}.phub`);
      // 从版本目录打：与 publish / relock 同一入口，归档里的锁就是 registry 里那份
      await packVersionArchive(dir, out);
      const bytes = statSync(out).size;
      console.log(`✓ ${scope}/${name}@${version} → ${out.replace(ROOT, '')}（${Math.round(bytes / 1024)} KB）`);
      built++;
    }
  }
}
console.log(`\n${built} 个归档`);
