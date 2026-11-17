import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildIndex, writeIndex } from '../src/index.ts';
import { RESOURCES_API_VERSION, checkResourcesCatalog } from '../src/build.ts';

/** 空的 registry：没有 packs 也没有 resources.json，输入完全由用例决定。 */
function makeRegistry(): string {
  const dir = mkdtempSync(join(tmpdir(), 'packhub-reg-resources-'));
  mkdirSync(join(dir, 'packs'), { recursive: true });
  return dir;
}

function validCatalog(): Record<string, unknown> {
  return {
    apiVersion: RESOURCES_API_VERSION,
    resources: [
      { id: 'mcp/example', type: 'mcp', source: 'npm:@example/mcp@1.0.0', title: '示例' },
    ],
  };
}

describe('registry/resources.json 门禁', () => {
  const made: string[] = [];
  afterEach(() => {
    for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  /** catalog 传 undefined 表示「文件不存在」；其余原样写进 resources.json。 */
  function registryWith(catalog: unknown | undefined): string {
    const dir = makeRegistry();
    made.push(dir);
    if (catalog !== undefined) {
      writeFileSync(join(dir, 'resources.json'), `${JSON.stringify(catalog, null, 2)}\n`, 'utf8');
    }
    return dir;
  }

  it('正常：合法资源目录不产生 error / warning', () => {
    const reg = registryWith(validCatalog());
    const res = buildIndex(reg);
    expect(res.errors).toEqual([]);
    expect(res.warnings).toEqual([]);
    expect(writeIndex(reg, { checkOnly: true }).ok).toBe(true);
  });

  it('坏版本：apiVersion 不精确等于 packhub.dev/resources/v0 时 check 失败', () => {
    const catalog = validCatalog();
    catalog.apiVersion = 'packhub.dev/resources/v1';
    const reg = registryWith(catalog);
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const res = buildIndex(reg);
    const errors = res.errors.join('\n');
    expect(errors).toContain(`apiVersion 必须是 ${RESOURCES_API_VERSION}`);
    expect(errors).toContain('实际是 packhub.dev/resources/v1');
    // registry:check 走 writeIndex(checkOnly)，坏版本必须让它返回失败
    expect(writeIndex(reg, { checkOnly: true }).ok).toBe(false);
    expect(existsSync(join(reg, 'index.json'))).toBe(false);
  });

  it('缺文件：只给 warning，不阻断', () => {
    const reg = registryWith(undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const res = buildIndex(reg);
    expect(res.errors).toEqual([]);
    expect(res.warnings.join('\n')).toContain('resources.json 不存在');
    expect(writeIndex(reg, { checkOnly: true }).ok).toBe(true);
  });

  it('坏结构：结构问题按 kernel 的 issue code 进 errors', () => {
    const badType = validCatalog();
    badType.resources = [{ id: 'mcp/example', type: 'plugin', source: 'npm:x' }];
    const missingSource = validCatalog();
    missingSource.resources = [{ id: 'mcp/example', type: 'mcp' }];
    const duplicateId = validCatalog();
    duplicateId.resources = [
      { id: 'mcp/example', type: 'mcp', source: 'npm:a' },
      { id: 'mcp/example', type: 'mcp', source: 'npm:b' },
    ];
    const notArray = validCatalog();
    notArray.resources = 'nope';

    const cases: [string, unknown, string][] = [
      ['type 不合法', badType, '[catalog-entry]'],
      ['缺 source', missingSource, '缺少 source'],
      ['id 重复', duplicateId, '[catalog-duplicate]'],
      ['resources 不是数组', notArray, '[catalog-shape]'],
    ];
    for (const [label, catalog, expected] of cases) {
      const errors = buildIndex(registryWith(catalog)).errors.join('\n');
      expect(errors, `${label} 应该进 errors`).toContain('resources.json');
      expect(errors, `${label} 应该进 errors`).toContain(expected);
    }
  });

  it('不是合法 JSON：报 error，不抛异常', () => {
    const dir = makeRegistry();
    made.push(dir);
    writeFileSync(join(dir, 'resources.json'), '{ "apiVersion": ', 'utf8');
    expect(buildIndex(dir).errors.join('\n')).toContain('resources.json 不是合法 JSON');
  });

  it('纯函数：版本必须精确相等，尾随空格也算坏版本', () => {
    const trailing = checkResourcesCatalog(
      JSON.stringify({ apiVersion: `${RESOURCES_API_VERSION} `, resources: [] }),
    );
    expect(trailing.errors).toHaveLength(1);
    expect(trailing.errors[0]).toContain('apiVersion 必须是');

    expect(checkResourcesCatalog(JSON.stringify(validCatalog()))).toEqual({ errors: [], warnings: [] });
    expect(checkResourcesCatalog(undefined).errors).toEqual([]);
    expect(checkResourcesCatalog(undefined).warnings.join('\n')).toContain('不存在');
  });
});
