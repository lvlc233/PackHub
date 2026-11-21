import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import packhubSchema from '../../../schema/packhub.v0.schema.json' with { type: 'json' };
import resourcesSchema from '../../../schema/resources.v0.schema.json' with { type: 'json' };
import {
  CAPABILITY_FORMS,
  CAPABILITY_TOKEN_PATTERN,
  isCapabilityToken,
  parseCapabilityToken,
} from '../src/index.ts';

/**
 * schema 与 types.ts 是两份手写镜像：权威定义是 `schema/packhub.v0.schema.json`，
 * `packages/kernel/src/types.ts` 是读端用的那份。这里逐字段比对四件事，漂移就失败，
 * 并报出字段名与两边的值：
 *
 * 1. 字段集合（Manifest 顶层、definitions.resource ↔ ResourceSpec）
 * 2. required 归属：schema 的 `required` ↔ types.ts 字段上的 `?`
 * 3. enum 字面量集合：schema 的 `enum` / `const` ↔ types.ts 的字面量联合
 * 4. 顶层字段的类型类别：string / number / boolean / object / array 对 TypeScript 的
 *    string / number / boolean / object / array / unknown
 *
 * 仍然比不到的（这里绿了不等于一致）：`pattern` / `maxLength` / `format` / `minItems` /
 * `uniqueItems` / `additionalProperties`、嵌套对象内部的字段与类型（例如
 * `metadata.required`、`auth.scheme`）、数组元素类型（enum 除外）、
 * `definitions.resource.allOf` 里的条件必填（mcp 要 transport、tool2 要 commands、
 * http 来源要 integrity）。`pattern` 没法在 types.ts 里镜像：来源语法由
 * `ref-source-consistency.test.ts` 直接比 schema 与源码，能力令牌由本文件末尾的
 * 「能力令牌：pattern 单源」比两份 schema 与 kernel 常量。
 */

const TYPES_PATH = fileURLToPath(new URL('../src/types.ts', import.meta.url));
const typesSource = ts.createSourceFile(
  TYPES_PATH,
  readFileSync(TYPES_PATH, 'utf8'),
  ts.ScriptTarget.Latest,
  true,
);

/** types.ts 里某个接口的一个直接属性。 */
interface TypeField {
  /** 带 `?` 的可选字段 */
  optional: boolean;
  /** 类型注解节点；没写类型注解时是 undefined */
  node: ts.TypeNode | undefined;
}

/** types.ts 里某个接口的直接属性：字段名 → 可选性与类型节点。 */
function interfaceFields(name: string): Map<string, TypeField> {
  for (const statement of typesSource.statements) {
    if (!ts.isInterfaceDeclaration(statement) || statement.name.text !== name) continue;
    const fields = new Map<string, TypeField>();
    for (const member of statement.members) {
      if (!ts.isPropertySignature(member) || !member.name || !ts.isIdentifier(member.name)) {
        // 出现方法 / 索引 / 计算属性签名说明镜像写法变了，字段集合已经不可比
        throw new Error(`types.ts 的 ${name} 里有非属性成员：${member.getText(typesSource)}`);
      }
      fields.set(member.name.text, {
        optional: member.questionToken !== undefined,
        node: member.type,
      });
    }
    return fields;
  }
  throw new Error(`types.ts 里找不到接口 ${name}`);
}

/** types.ts 顶层的 type 别名或变量声明；找不到返回 undefined。 */
function topLevelDeclaration(
  name: string,
): ts.TypeAliasDeclaration | ts.VariableDeclaration | undefined {
  for (const statement of typesSource.statements) {
    if (ts.isTypeAliasDeclaration(statement) && statement.name.text === name) return statement;
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.name.text === name) return declaration;
    }
  }
  return undefined;
}

/**
 * `const X = ['a', ...Y] as const` 里的字符串字面量。
 * 不是字符串数组常量（或解不开）返回 undefined——不猜。
 */
function constArrayLiterals(name: string, seen = new Set<string>()): Set<string> | undefined {
  if (seen.has(name)) return undefined;
  seen.add(name);
  const declaration = topLevelDeclaration(name);
  if (!declaration || !ts.isVariableDeclaration(declaration)) return undefined;
  let initializer = declaration.initializer;
  if (!initializer) return undefined;
  if (ts.isAsExpression(initializer)) initializer = initializer.expression;
  if (!ts.isArrayLiteralExpression(initializer)) return undefined;
  const literals = new Set<string>();
  for (const element of initializer.elements) {
    if (ts.isStringLiteral(element)) {
      literals.add(element.text);
      continue;
    }
    if (ts.isSpreadElement(element) && ts.isIdentifier(element.expression)) {
      const spread = constArrayLiterals(element.expression.text, seen);
      if (!spread) return undefined;
      for (const value of spread) literals.add(value);
      continue;
    }
    return undefined;
  }
  return literals;
}

/**
 * 类型节点上的字符串字面量集合：字面量联合、`ResourceType` 这类别名、
 * `(typeof LIST)[number]`、数组元素（`TargetId[]`）。
 * 不是字面量联合（或解不开）返回 undefined——那是「这里没有 enum 可比」，不是一致。
 */
function literalSetOfType(
  node: ts.TypeNode | undefined,
  seen = new Set<string>(),
): Set<string> | undefined {
  if (!node) return undefined;
  if (ts.isParenthesizedTypeNode(node)) return literalSetOfType(node.type, seen);
  if (ts.isLiteralTypeNode(node)) {
    if (ts.isStringLiteral(node.literal)) return new Set([node.literal.text]);
    if (ts.isNumericLiteral(node.literal)) return new Set([node.literal.text]);
    return undefined;
  }
  if (ts.isUnionTypeNode(node)) {
    const union = new Set<string>();
    for (const member of node.types) {
      const literals = literalSetOfType(member, seen);
      if (!literals) return undefined;
      for (const value of literals) union.add(value);
    }
    return union;
  }
  if (ts.isArrayTypeNode(node)) return literalSetOfType(node.elementType, seen);
  if (ts.isTypeReferenceNode(node) && ts.isIdentifier(node.typeName)) {
    const name = node.typeName.text;
    if (seen.has(name)) return undefined;
    const declaration = topLevelDeclaration(name);
    if (!declaration || !ts.isTypeAliasDeclaration(declaration)) return undefined;
    return literalSetOfType(declaration.type, new Set([...seen, name]));
  }
  if (ts.isIndexedAccessTypeNode(node) && node.indexType.kind === ts.SyntaxKind.NumberKeyword) {
    // `(typeof LIST)[number]`：对象侧可能是括号包着的 typeof 查询
    const objectType = unwrapParens(node.objectType);
    if (ts.isTypeQueryNode(objectType) && ts.isIdentifier(objectType.exprName)) {
      return constArrayLiterals(objectType.exprName.text);
    }
  }
  return undefined;
}

/** 去掉类型节点外层的括号：`(typeof X)` → `typeof X`。 */
function unwrapParens(node: ts.TypeNode): ts.TypeNode {
  let current = node;
  while (ts.isParenthesizedTypeNode(current)) current = current.type;
  return current;
}

type Category = 'string' | 'number' | 'boolean' | 'object' | 'array' | 'unknown';

/** TypeScript 类型节点的类别；比不出就写 unknown，不猜。 */
function typeCategoryOf(node: ts.TypeNode | undefined, seen = new Set<string>()): Category {
  if (!node) return 'unknown';
  if (ts.isParenthesizedTypeNode(node)) return typeCategoryOf(node.type, seen);
  if (ts.isLiteralTypeNode(node)) {
    const literal = node.literal;
    if (ts.isStringLiteral(literal) || ts.isNoSubstitutionTemplateLiteral(literal)) return 'string';
    if (ts.isNumericLiteral(literal)) return 'number';
    if (
      literal.kind === ts.SyntaxKind.TrueKeyword ||
      literal.kind === ts.SyntaxKind.FalseKeyword
    ) {
      return 'boolean';
    }
    return 'unknown';
  }
  switch (node.kind) {
    case ts.SyntaxKind.StringKeyword:
      return 'string';
    case ts.SyntaxKind.NumberKeyword:
      return 'number';
    case ts.SyntaxKind.BooleanKeyword:
      return 'boolean';
    case ts.SyntaxKind.ObjectKeyword:
      return 'object';
    default:
      break;
  }
  if (ts.isArrayTypeNode(node) || ts.isTupleTypeNode(node)) return 'array';
  if (ts.isTypeLiteralNode(node)) return 'object';
  if (ts.isUnionTypeNode(node)) {
    const categories = new Set(node.types.map((member) => typeCategoryOf(member, seen)));
    const [only] = categories;
    return categories.size === 1 && only ? only : 'unknown';
  }
  if (ts.isIndexedAccessTypeNode(node)) {
    // `(typeof LIST)[number]`：元素全是字符串字面量时就是 string
    return literalSetOfType(node) ? 'string' : 'unknown';
  }
  if (ts.isTypeQueryNode(node)) {
    return ts.isIdentifier(node.exprName) && constArrayLiterals(node.exprName.text)
      ? 'array'
      : 'unknown';
  }
  if (ts.isTypeReferenceNode(node) && ts.isIdentifier(node.typeName)) {
    const name = node.typeName.text;
    if (name === 'Record') return 'object';
    if (name === 'Array' || name === 'ReadonlyArray') return 'array';
    if (seen.has(name)) return 'unknown';
    const declaration = topLevelDeclaration(name);
    if (!declaration) return 'unknown';
    if (ts.isTypeAliasDeclaration(declaration)) {
      return typeCategoryOf(declaration.type, new Set([...seen, name]));
    }
    return 'unknown';
  }
  return 'unknown';
}

/** 这里只用到 JSON Schema 的一个子集；没用到的不写。 */
interface JsonSchema {
  type?: string | string[];
  enum?: unknown[];
  const?: unknown;
  $ref?: string;
  items?: JsonSchema;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  oneOf?: JsonSchema[];
  anyOf?: JsonSchema[];
  definitions?: Record<string, JsonSchema>;
}

const schema = packhubSchema as unknown as JsonSchema & {
  definitions: Record<string, JsonSchema>;
};

/** 只解本文件内的 `#/definitions/x`；解不开直接抛，别静默当成空。 */
function resolveRef(node: JsonSchema): JsonSchema {
  if (node.$ref === undefined) return node;
  const prefix = '#/definitions/';
  if (!node.$ref.startsWith(prefix)) throw new Error(`schema 里有不认识的 $ref：${node.$ref}`);
  const definition = schema.definitions[node.$ref.slice(prefix.length)];
  if (!definition) throw new Error(`schema 的 $ref 指不到定义：${node.$ref}`);
  return definition;
}

function schemaTypeName(type: string): Category {
  if (type === 'string') return 'string';
  if (type === 'number' || type === 'integer') return 'number';
  if (type === 'boolean') return 'boolean';
  if (type === 'object') return 'object';
  if (type === 'array') return 'array';
  return 'unknown';
}

function literalCategory(value: unknown): Category {
  if (typeof value === 'string') return 'string';
  if (typeof value === 'number') return 'number';
  if (typeof value === 'boolean') return 'boolean';
  return 'unknown';
}

/** schema 侧一个字段的类型类别（会解 `$ref`，enum / const 按字面量归类）。 */
function schemaCategory(node: JsonSchema): Category {
  const resolved = resolveRef(node);
  if (resolved.type !== undefined) {
    const types = Array.isArray(resolved.type) ? resolved.type : [resolved.type];
    const categories = new Set(types.map((type) => schemaTypeName(type)));
    const [only] = categories;
    return categories.size === 1 && only ? only : 'unknown';
  }
  const literals = resolved.enum ?? (resolved.const === undefined ? undefined : [resolved.const]);
  if (literals) {
    const categories = new Set(literals.map((value) => literalCategory(value)));
    const [only] = categories;
    return categories.size === 1 && only ? only : 'unknown';
  }
  const branches = resolved.oneOf ?? resolved.anyOf;
  if (branches) {
    const categories = new Set(branches.map((branch) => schemaCategory(branch)));
    const [only] = categories;
    return categories.size === 1 && only ? only : 'unknown';
  }
  return 'unknown';
}

/** schema 侧的字面量集合：`enum` / `const`；数组看 `items` 的 enum。没有返回 undefined。 */
function schemaLiterals(node: JsonSchema): Set<string> | undefined {
  const resolved = resolveRef(node);
  if (resolved.enum) return new Set(resolved.enum.map((value) => String(value)));
  if (resolved.const !== undefined) return new Set([String(resolved.const)]);
  if (resolved.items) return schemaLiterals(resolved.items);
  return undefined;
}

/**
 * 允许 types.ts 有、schema 里没有的字段：schema 之外的可选镜像字段。
 * 必须显式列在这里（写清为什么 schema 里没有），并且必须真的是可选字段；
 * 白名单条目一旦在 schema 里出现或从 types.ts 消失，同样算失败——不许静默通过。
 * 空数组 = 当前两侧字段完全一致。
 */
const MANIFEST_TYPES_ONLY: readonly string[] = [];
const RESOURCE_TYPES_ONLY: readonly string[] = [];

/**
 * 已钉住的真实漂移：这里只放「现在两边确实不一致」的显式期望，不是白名单。
 * 目前为空：`Manifest.requires` 已按 schema 改成可选（schema 的顶层 required 里没有它，
 * 读端也一直按可选取）。再出现不一致时先修两边，别往这里加期望把漂移盖住。
 */
const KNOWN_MANIFEST_DRIFT: readonly string[] = [];

/** 返回人读的漂移描述；空数组表示 schema 与 types.ts 在这几项上一致。 */
function drift(
  label: string,
  schemaObject: JsonSchema,
  typeFields: ReadonlyMap<string, TypeField>,
  typesOnly: readonly string[],
): string[] {
  const schemaProps = schemaObject.properties ?? {};
  const schemaFields = new Set(Object.keys(schemaProps));
  const schemaRequired = new Set(schemaObject.required ?? []);
  const sorted = (values: Iterable<string>): string[] => [...values].sort();

  // 1. 字段集合
  const missingInTypes = sorted([...schemaFields].filter((field) => !typeFields.has(field)));
  const unmirroredInSchema = sorted(
    [...typeFields.keys()].filter(
      (field) => !schemaFields.has(field) && !typesOnly.includes(field),
    ),
  );
  const staleWhitelist = sorted(
    typesOnly.filter((field) => schemaFields.has(field) || !typeFields.has(field)),
  );
  const requiredWhitelist = sorted(
    typesOnly.filter((field) => typeFields.get(field)?.optional === false),
  );

  // 2. required 归属
  const requiredMarkedOptional = sorted(
    [...schemaRequired].filter((field) => typeFields.get(field)?.optional === true),
  );
  const requiredInTypesOnly = sorted(
    [...typeFields]
      .filter(
        ([field, info]) =>
          !info.optional &&
          !schemaRequired.has(field) &&
          !typesOnly.includes(field) &&
          Object.hasOwn(schemaProps, field),
      )
      .map(([field]) => field),
  );

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
  if (requiredMarkedOptional.length > 0) {
    problems.push(
      `types.ts 的 ${label} 把 schema 的 required 字段标成了可选：${requiredMarkedOptional.join(', ')}`,
    );
  }
  if (requiredInTypesOnly.length > 0) {
    problems.push(
      `types.ts 的 ${label} 把这些字段标成必填，但 schema 的 required 里没有：${requiredInTypesOnly.join(', ')}`,
    );
  }

  // 3. enum 字面量 + 4. 顶层类型类别；按字段名排序，问题顺序稳定、好读
  for (const field of sorted(schemaFields)) {
    const info = typeFields.get(field);
    if (!info) continue;
    const prop = schemaProps[field]!;

    const schemaEnum = schemaLiterals(prop);
    const typeEnum = literalSetOfType(info.node);
    if (schemaEnum || typeEnum) {
      if (!schemaEnum) {
        problems.push(
          `${label}.${field}：types.ts 写成了字面量联合，schema 没有对应的 enum / const`,
        );
      } else if (!typeEnum) {
        problems.push(
          `${label}.${field}：schema 用 enum / const 限定了取值，types.ts 没写成字面量联合`,
        );
      } else {
        const missing = sorted([...schemaEnum].filter((literal) => !typeEnum.has(literal)));
        const extra = sorted([...typeEnum].filter((literal) => !schemaEnum.has(literal)));
        if (missing.length > 0 || extra.length > 0) {
          const detail: string[] = [];
          if (missing.length > 0) detail.push(`types.ts 少了 ${missing.join(', ')}`);
          if (extra.length > 0) detail.push(`types.ts 多了 ${extra.join(', ')}`);
          problems.push(`${label}.${field} 的 enum 字面量不一致：${detail.join('；')}`);
        }
      }
    }

    const schemaSide = schemaCategory(prop);
    const typeSide = typeCategoryOf(info.node);
    if (schemaSide !== typeSide) {
      problems.push(
        `types.ts 的 ${label}.${field} 类型类别不一致：schema 是 ${schemaSide}，types.ts 是 ${typeSide}`,
      );
    }
  }

  return problems;
}

/** 把 `'a' | 'b'` 这类类型源码解析成节点，自检用例用。 */
function typeNode(source: string): ts.TypeNode {
  const file = ts.createSourceFile(
    'fixture.ts',
    `type Fixture = ${source};`,
    ts.ScriptTarget.Latest,
    true,
  );
  const alias = file.statements[0];
  if (!alias || !ts.isTypeAliasDeclaration(alias)) {
    throw new Error(`自检用例的类型片段解析失败：${source}`);
  }
  return alias.type;
}

const RESOURCE_DEFINITION = resolveRef({ $ref: '#/definitions/resource' });

describe('schema ↔ types.ts 镜像', () => {
  it('Manifest 顶层字段、required、enum、类型类别与 schema 对得上（已钉住的漂移除外）', () => {
    expect(
      Object.keys(schema.properties ?? {}).length,
      'schema 里没读到 Manifest 顶层字段',
    ).toBeGreaterThan(0);
    const fields = interfaceFields('Manifest');
    expect(fields.size, 'types.ts 的 Manifest 没解析出字段').toBeGreaterThan(0);
    expect(fields.has('resources'), '解析器没读到 Manifest.resources').toBe(true);
    const problems = drift('Manifest', schema, fields, MANIFEST_TYPES_ONLY);
    expect(problems, problems.join('\n')).toEqual(KNOWN_MANIFEST_DRIFT);
  });

  it('definitions.resource 与 ResourceSpec 的字段、required、enum、类型类别一致', () => {
    expect(
      Object.keys(RESOURCE_DEFINITION.properties ?? {}).length,
      'schema 里没读到 definitions.resource 字段',
    ).toBeGreaterThan(0);
    const fields = interfaceFields('ResourceSpec');
    expect(fields.size, 'types.ts 的 ResourceSpec 没解析出字段').toBeGreaterThan(0);
    expect(fields.has('commands'), '解析器没读到 ResourceSpec.commands').toBe(true);
    const problems = drift('ResourceSpec', RESOURCE_DEFINITION, fields, RESOURCE_TYPES_ONLY);
    expect(problems, problems.join('\n')).toEqual([]);
  });

  it('没有已钉住的漂移：两边当前完全一致', () => {
    expect(KNOWN_MANIFEST_DRIFT).toEqual([]);
  });

  it('自检：schema 的 required 字段在 types.ts 标了可选时报出字段名', () => {
    const problems = drift(
      'Fixture',
      { properties: { id: { type: 'string' }, name: { type: 'string' } }, required: ['id', 'name'] },
      new Map([
        ['id', { optional: true, node: typeNode('string') }],
        ['name', { optional: false, node: typeNode('string') }],
      ]),
      [],
    );
    expect(problems.join('\n')).toContain('把 schema 的 required 字段标成了可选：id');
  });

  it('自检：schema enum 之外多出的字面量会点名到字段', () => {
    const problems = drift(
      'Fixture',
      { properties: { level: { enum: ['low', 'high'] } } },
      new Map([['level', { optional: false, node: typeNode("'low' | 'high' | 'extra'") }]]),
      [],
    );
    const text = problems.join('\n');
    expect(text).toContain('Fixture.level 的 enum 字面量不一致');
    expect(text).toContain('types.ts 多了 extra');
  });

  it('自检：顶层类型类别不符时报出字段名与两边类别', () => {
    const problems = drift(
      'Fixture',
      { properties: { count: { type: 'number' } } },
      new Map([['count', { optional: false, node: typeNode('string') }]]),
      [],
    );
    expect(problems.join('\n')).toContain(
      'Fixture.count 类型类别不一致：schema 是 number，types.ts 是 string',
    );
  });

  it('自检：字段增删与白名单过期也会点名', () => {
    const missing = drift(
      'Fixture',
      { properties: { a: {}, b: {} }, required: ['a', 'b'] },
      new Map([['a', { optional: false, node: undefined }]]),
      [],
    );
    expect(missing.join('\n')).toContain('缺少 schema 字段：b');

    const extra = drift(
      'Fixture',
      { properties: { a: {} }, required: ['a'] },
      new Map([
        ['a', { optional: false, node: undefined }],
        ['x', { optional: true, node: undefined }],
      ]),
      [],
    );
    expect(extra.join('\n')).toContain(
      '多出 schema 之外的字段（要镜像就显式加进白名单）：x',
    );

    const stale = drift(
      'Fixture',
      { properties: { a: {} }, required: ['a'] },
      new Map([['a', { optional: false, node: undefined }]]),
      ['a'],
    );
    expect(stale.join('\n')).toContain('过期条目要删掉');

    const requiredWhitelist = drift(
      'Fixture',
      { properties: { a: {} }, required: ['a'] },
      new Map([
        ['a', { optional: false, node: undefined }],
        ['x', { optional: false, node: undefined }],
      ]),
      ['x'],
    );
    expect(requiredWhitelist.join('\n')).toContain('白名单字段必须是可选镜像字段：x');
  });
});

/**
 * 能力令牌 `<form>/<name>@<major>` 的 pattern 有两份 schema 各写一遍
 * （packhub 的 provides / needs / slots.contract，resources 的 provides），
 * kernel 又从 packhub 那份建 CAPABILITY_TOKEN_PATTERN。三处必须字面相等：
 * 任何一处单独改都会让「同一个令牌在清单里合法、在目录里非法」这种裂缝出现。
 */
describe('能力令牌：pattern 单源', () => {
  const packhubToken = (packhubSchema as unknown as {
    definitions: { capabilities: { items: { pattern: string } } };
  }).definitions.capabilities.items.pattern;

  const resourcesToken = (resourcesSchema as unknown as {
    properties: {
      resources: { items: { properties: { provides: { items: { pattern: string } } } } };
    };
  }).properties.resources.items.properties.provides.items.pattern;

  const slotContractToken = (packhubSchema as unknown as {
    properties: {
      slots: {
        additionalProperties: { properties: { contract: { items: { pattern: string } } } };
      };
    };
  }).properties.slots.additionalProperties.properties.contract.items.pattern;

  it('两份 schema 的令牌 pattern 相等（packhub ↔ resources）', () => {
    expect(packhubToken).toBe(resourcesToken);
  });

  it('清单里的三处（provides / needs / slots.contract）用同一条 pattern', () => {
    // needs 与 provides 共用 definitions.capabilities，这里只额外盯 slots.contract 没走偏
    expect(slotContractToken).toBe(packhubToken);
  });

  it('kernel 的 CAPABILITY_TOKEN_PATTERN 就是 schema 那条，不在 TS 里另写正则', () => {
    // RegExp.source 会把 `/` 转义成 `\/`（V8 的写法），比之前先还原
    expect(CAPABILITY_TOKEN_PATTERN.source.replace(/\\\//g, '/')).toBe(packhubToken);
  });

  it('CAPABILITY_FORMS 与 pattern 里的 form 闭集一致', () => {
    const forms = /^\^?\(([^)]+)\)\//.exec(packhubToken)?.[1]?.split('|') ?? [];
    expect(forms).toEqual([...CAPABILITY_FORMS]);
  });

  it('合法令牌拆得开；旧写法、错版本、错 form 一律拒', () => {
    expect(parseCapabilityToken('tool/lint@1')).toEqual({ form: 'tool', name: 'lint', major: 1 });
    expect(parseCapabilityToken('content/review-rubric@12')).toEqual({
      form: 'content',
      name: 'review-rubric',
      major: 12,
    });

    for (const bad of [
      'doc/lint@1', // form 不在闭集：旧写法的 namespace 位置现在是 tool / skill / content / config
      'tool/lint', // 缺主版本
      'tool/lint@0', // 主版本从 1 起
      'Tool/lint@1', // form 闭集是小写
      'tool/Lint@1', // 名字 kebab-case
      'tool/lint_v2@1', // 名字不吃下划线
      'mcp/filesystem@1', // form 是消费形态，不是资源类型
      'tool/lint@1 extra',
    ]) {
      expect(isCapabilityToken(bad), bad).toBe(false);
      expect(parseCapabilityToken(bad), bad).toBeUndefined();
    }
  });
});
