import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { PLAN_OPS } from '../src/index.ts';

const TYPES = fileURLToPath(new URL('../src/types.ts', import.meta.url));
const CONTRACT = fileURLToPath(new URL('../../../docs/contract.md', import.meta.url));

/** 从 `export type PlanOp = ...` 的联合里取出每个成员的 `op` 字面量。 */
function opsFromTypes(): string[] {
  const sf = ts.createSourceFile(TYPES, readFileSync(TYPES, 'utf8'), ts.ScriptTarget.Latest, true);
  const ops: string[] = [];
  for (const node of sf.statements) {
    if (!ts.isTypeAliasDeclaration(node) || node.name.text !== 'PlanOp') continue;
    if (!ts.isUnionTypeNode(node.type)) continue;
    for (const member of node.type.types) {
      if (!ts.isTypeLiteralNode(member)) continue;
      for (const prop of member.members) {
        if (!ts.isPropertySignature(prop) || !ts.isIdentifier(prop.name) || prop.name.text !== 'op') continue;
        if (prop.type && ts.isLiteralTypeNode(prop.type) && ts.isStringLiteral(prop.type.literal)) {
          ops.push(prop.type.literal.text);
        }
      }
    }
  }
  return [...new Set(ops)].sort();
}

/** 从 contract 的「动作原语：」那一行取出反引号里的 op 名。 */
function opsFromContract(): string[] {
  const text = readFileSync(CONTRACT, 'utf8');
  const line = text.split('\n').find((l) => l.trim().startsWith('动作原语：'));
  if (!line) throw new Error('contract.md 里找不到「动作原语：」那一行');
  return [...new Set([...line.matchAll(/`([^`]+)`/g)].map((m) => m[1]!))].sort();
}

describe('op 三方一致', () => {
  it('types.ts 的 PlanOp 联合 = PLAN_OPS 表 = contract.md 的动作原语', () => {
    const fromTypes = opsFromTypes();
    const fromTable = Object.keys(PLAN_OPS).sort();
    const fromContract = opsFromContract();
    expect(fromTypes.length).toBeGreaterThan(0);
    expect(fromTable).toEqual(fromTypes);
    expect(fromContract).toEqual(fromTypes);
  });
});
