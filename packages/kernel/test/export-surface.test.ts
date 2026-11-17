import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const KERNEL = fileURLToPath(new URL('../src/index.ts', import.meta.url));
const RUNTIME = fileURLToPath(new URL('../../runtime/src/index.ts', import.meta.url));

/**
 * 解析一个入口文件导出的名字（含 `export * from './x.ts'` 展开）。
 * 只读静态声明与 named exports：类型与值都算，和 `export *` 的公开面一致。
 */
function exportedNames(file: string, seen = new Set<string>()): string[] {
  if (seen.has(file)) return [];
  seen.add(file);
  const sf = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  const names = new Set<string>();
  const hasExport = (node: ts.Node): boolean =>
    ((node as { modifiers?: readonly ts.ModifierLike[] }).modifiers ?? []).some(
      (m) => m.kind === ts.SyntaxKind.ExportKeyword,
    );
  const fromSpecifier = (spec: string): string => resolve(dirname(file), spec);
  const visit = (node: ts.Node): void => {
    if (ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        const target = fromSpecifier(node.moduleSpecifier.text);
        if (node.exportClause && ts.isNamedExports(node.exportClause)) {
          for (const el of node.exportClause.elements) names.add(el.name.text);
        } else if (!node.exportClause) {
          for (const name of exportedNames(target, seen)) names.add(name);
        }
      } else if (node.exportClause && ts.isNamedExports(node.exportClause)) {
        for (const el of node.exportClause.elements) names.add(el.name.text);
      }
      return;
    }
    if (
      (ts.isFunctionDeclaration(node) ||
        ts.isClassDeclaration(node) ||
        ts.isInterfaceDeclaration(node) ||
        ts.isTypeAliasDeclaration(node) ||
        ts.isEnumDeclaration(node)) &&
      node.name &&
      hasExport(node)
    ) {
      names.add(node.name.text);
    } else if (ts.isVariableStatement(node) && hasExport(node)) {
      for (const decl of node.declarationList.declarations) {
        if (ts.isIdentifier(decl.name)) names.add(decl.name.text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return [...names];
}

function baseline(name: string): string[] {
  const file = fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
  if (!existsSync(file)) throw new Error(`导出面基线不存在：${file}`);
  return readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));
}

/** 基线是排序后的名字列表；差异按「新增 / 删除」分别报出来。 */
function compare(actualNames: string[], expected: string[]): void {
  const actual = [...new Set(actualNames)].sort();
  const missing = expected.filter((n) => !actual.includes(n));
  const added = actual.filter((n) => !expected.includes(n));
  expect({ added, removed: missing }, `${added.length} 个新增 / ${missing.length} 个删除`).toEqual({
    added: [],
    removed: [],
  });
}

describe('导出面快照', () => {
  it('kernel/index.ts 的导出名单与基线一致（新增要写进基线，删除要能说清）', () => {
    compare(exportedNames(KERNEL), baseline('export-surface-kernel.txt'));
  });

  it('runtime/index.ts 的导出名单与基线一致', () => {
    compare(exportedNames(RUNTIME), baseline('export-surface-runtime.txt'));
  });

  it('基线文件本身没有重复项', () => {
    for (const name of ['export-surface-kernel.txt', 'export-surface-runtime.txt']) {
      const lines = baseline(name);
      expect(new Set(lines).size, `${name} 有重复项`).toBe(lines.length);
    }
  });
});
