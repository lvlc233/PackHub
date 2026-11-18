import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));

const ALLOWED: Record<string, string[]> = {
  // 内核是最底层：不许 import 任何同仓包
  kernel: [],
  // runner 的执行面依赖 runtime，清单/计划直接取 kernel
  runner: ['@packhub/runtime', '@packhub/kernel'],
  // launcher 是外壳：不能反过来依赖 registry
  launcher: ['@packhub/kernel', '@packhub/runtime'],
};

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) walk(abs, out);
    else if (entry.isFile() && entry.name.endsWith('.ts')) out.push(abs);
  }
  return out;
}

function workspaceImports(pkg: string): Set<string> {
  const dir = join(ROOT, 'packages', pkg, 'src');
  const found = new Set<string>();
  for (const file of walk(dir)) {
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g)) {
      if (m[1]!.startsWith('@packhub/')) found.add(m[1]!);
    }
    for (const m of text.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) {
      if (m[1]!.startsWith('@packhub/')) found.add(m[1]!);
    }
  }
  return found;
}

function workspaceDeps(pkg: string): string[] {
  const file = join(ROOT, 'packages', pkg, 'package.json');
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as { dependencies?: Record<string, string> };
  return Object.keys(parsed.dependencies ?? {}).filter((name) => name.startsWith('@packhub/')).sort();
}

describe('import 方向', () => {
  it('读 package.json 与 src import 图：方向、allowed 集合、声明一致', () => {
    for (const [pkg, allowed] of Object.entries(ALLOWED)) {
      const imports = [...workspaceImports(pkg)].sort();
      const deps = workspaceDeps(pkg);

      // 1) 实际 import 不许越过方向限制
      for (const mod of imports) {
        expect(
          allowed.includes(mod),
          `${pkg} 不许 import ${mod}（允许：${allowed.join(', ') || '无'}）`,
        ).toBe(true);
      }
      // 2) 不许有未声明的 workspace 依赖
      for (const mod of imports) {
        expect(deps, `${pkg} import 了 ${mod} 但 package.json 没声明`).toContain(mod);
      }
      // 3) 声明了就要真的用到（避免挂空的 workspace 依赖）
      for (const dep of deps) {
        expect(imports, `${pkg} 声明了 ${dep} 但 src 里没用到`).toContain(dep);
      }
    }
  });

  it('kernel 里没有任何 @packhub/* import', () => {
    expect([...workspaceImports('kernel')]).toEqual([]);
    expect(workspaceDeps('kernel')).toEqual([]);
  });

  it('launcher 不 import registry', () => {
    const imports = workspaceImports('launcher');
    expect(imports.has('@packhub/registry')).toBe(false);
  });
});

// 防止 walk 在空目录上静默通过：至少确认三个包的 src 都读到了
describe('扫描面', () => {
  it('三个包都有 src 文件被扫描', () => {
    for (const pkg of Object.keys(ALLOWED)) {
      const dir = join(ROOT, 'packages', pkg, 'src');
      expect(existsSync(dir), `${pkg}/src 不存在`).toBe(true);
      const files = walk(dir);
      expect(files.length, `${pkg}/src 没有 .ts 文件`).toBeGreaterThan(0);
      expect(files.every((f) => statSync(f).isFile())).toBe(true);
    }
  });
});
