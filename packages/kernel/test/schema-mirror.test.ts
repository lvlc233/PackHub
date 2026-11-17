import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import packhubSchema from '../../../schema/packhub.v0.schema.json' with { type: 'json' };

/**
 * schema 与 types.ts 是两份手写镜像：权威定义是 `schema/packhub.v0.schema.json`，
 * `packages/kernel/src/types.ts` 是读端用的那份。这里比对字段集合，漂移就失败并报出字段名。
 *
 * 只比字段名（Manifest 顶层、ResourceSpec 对 definitions.resource），不比类型细节：
 * schema 里的 `enum` / `pattern` 由各自的测试盯着，字段增删才是最容易两边忘一边的漂移。
 */

const TYPES_PATH = fileURLToPath(new URL('../src/types.ts', import.meta.url));

/** types.ts 里某个接口的直接属性：字段名 → 是否可选（`?`）。 */
function interfaceFields(name: string): Map<string, boolean> {
  const source = ts.createSourceFile(
    TYPES_PATH,
    readFileSync(TYPES_PATH, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
  for (const statement of source.statements) {
    if (!ts.isInterfaceDeclaration(statement) || statement.name.text !== name) continue;
    const fields = new Map<string, boolean>();
    for (const member of statement.members) {
      if (!ts.isPropertySignature(member) || !member.name || !ts.isIdentifier(member.name)) {
        // 出现方法 / 索引 / 计算属性签名说明镜像写法变了，字段集合已经不可比
        throw new Error(`types.ts 的 ${name} 里有非属性成员：${member.getText(source)}`);
      }
      fields.set(member.name.text, member.questionToken !== undefined);
    }
    return fields;
  }
  throw new Error(`types.ts 里找不到接口 ${name}`);
}

/**
 * 允许 types.ts 有、schema 里没有的字段：schema 之外的可选镜像字段。
 * 必须显式列在这里（写清为什么 schema 里没有），并且必须真的是可选字段；
 * 白名单条目一旦在 schema 里出现或从 types.ts 消失，同样算失败——不许静默通过。
 * 空数组 = 当前两侧字段完全一致。
 */
const MANIFEST_TYPES_ONLY: readonly string[] = [];
const RESOURCE_TYPES_ONLY: readonly string[] = [];

/** 返回人读的漂移描述；空数组表示两侧字段集合一致。 */
function drift(
  label: string,
  schemaFields: ReadonlySet<string>,
  typeFields: ReadonlyMap<string, boolean>,
  typesOnly: readonly string[],
): string[] {
  const sorted = (fields: Iterable<string>): string[] => [...fields].sort();
  const missingInTypes = sorted([...schemaFields].filter((field) => !typeFields.has(field)));
  const unmirroredInSchema = sorted(
    [...typeFields.keys()].filter((field) => !schemaFields.has(field) && !typesOnly.includes(field)),
  );
  const staleWhitelist = sorted(
    typesOnly.filter((field) => schemaFields.has(field) || !typeFields.has(field)),
  );
  const requiredWhitelist = sorted(typesOnly.filter((field) => typeFields.get(field) === false));

  const problems: string[] = [];
  if (missingInTypes.length > 0) {
    problems.push(`types.ts 的 ${label} 缺少 schema 字段：${missingInTypes.join(', ')}`);
  }
  if (unmirroredInSchema.length > 0) {
    problems.push(
      `types.ts 的 ${label} 多出 schema 之外的字段（要镜像就显式加进白名单）：${unmirroredInSchema.join(', ')}`,
    );
  }
  if (staleWhitelist.length > 0) {
    problems.push(
      `${label} 的白名单条目在 schema 里已有或 types.ts 里已删（过期条目要删掉）：${staleWhitelist.join(', ')}`,
    );
  }
  if (requiredWhitelist.length > 0) {
    problems.push(`${label} 的白名单字段必须是可选镜像字段：${requiredWhitelist.join(', ')}`);
  }
  return problems;
}

const schema = packhubSchema as unknown as {
  properties: Record<string, unknown>;
  definitions: { resource: { properties: Record<string, unknown> } };
};
const manifestSchemaFields = new Set(Object.keys(schema.properties));
const resourceSchemaFields = new Set(Object.keys(schema.definitions.resource.properties));

describe('schema ↔ types.ts 字段镜像', () => {
  it('Manifest 顶层字段与 schema 一致', () => {
    expect(manifestSchemaFields.size, 'schema 里没读到 Manifest 顶层字段').toBeGreaterThan(0);
    const fields = interfaceFields('Manifest');
    expect(fields.size, 'types.ts 的 Manifest 没解析出字段').toBeGreaterThan(0);
    expect(fields.has('resources'), '解析器没读到 Manifest.resources').toBe(true);
    expect(drift('Manifest', manifestSchemaFields, fields, MANIFEST_TYPES_ONLY)).toEqual([]);
  });

  it('definitions.resource 与 ResourceSpec 字段一致', () => {
    expect(resourceSchemaFields.size, 'schema 里没读到 definitions.resource 字段').toBeGreaterThan(0);
    const fields = interfaceFields('ResourceSpec');
    expect(fields.size, 'types.ts 的 ResourceSpec 没解析出字段').toBeGreaterThan(0);
    expect(fields.has('commands'), '解析器没读到 ResourceSpec.commands').toBe(true);
    expect(drift('ResourceSpec', resourceSchemaFields, fields, RESOURCE_TYPES_ONLY)).toEqual([]);
  });

  it('比对函数自己会报出具体字段名（用造的漂移自检）', () => {
    const missing = drift('Fixture', new Set(['a', 'b']), new Map([['a', false]]), []);
    expect(missing.join('\n')).toContain('缺少 schema 字段：b');

    const extra = drift('Fixture', new Set(['a']), new Map([['a', false], ['x', true]]), []);
    expect(extra.join('\n')).toContain('多出 schema 之外的字段');
    expect(extra.join('\n')).toContain('x');

    const stale = drift('Fixture', new Set(['a']), new Map([['a', false]]), ['a']);
    expect(stale.join('\n')).toContain('过期条目要删掉');

    const required = drift('Fixture', new Set(['a']), new Map([['a', false], ['x', false]]), ['x']);
    expect(required.join('\n')).toContain('白名单字段必须是可选镜像字段：x');
  });
});
