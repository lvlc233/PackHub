import { describe, expect, it } from 'vitest';
import packhubSchema from '../../../schema/packhub.v0.schema.json' with { type: 'json' };
import {
  HARNESS_ID_PATTERN,
  harness,
  harnessIds,
  isHarnessId,
  layoutFor,
  registerHarness,
  requireHarness,
  type HarnessSpec,
} from '../src/harness/index.ts';
import { DIR_LAYOUT_VARS, layoutVarsWith } from '../src/layout.ts';

/** 注册表用例用的最小宿主：形状够、行为不参与。 */
function spec(id: string, over: Partial<HarnessSpec> = {}): HarnessSpec {
  return {
    id,
    label: id,
    layout: { instructionFile: 'TEMP.md' },
    instructionFile: 'TEMP.md',
    probe: {
      executable: 'echo',
      args: (ctx) => [ctx.prompt],
      preview: () => 'echo "<prompt>"',
      answer: (stdout) => stdout.trim(),
    },
    ...over,
  };
}

/**
 * 宿主是运行期注册表：`harness/index.ts` import 一遍各宿主模块就算注册。
 *
 * 落点表不再是「一张覆盖所有宿主的常量表」，而是 `layoutFor(id)` 现查注册表、
 * 把模块里的 `layout` 差量叠到平铺约定上；所以这里断言的是「注册表内容」与「派生结果」。
 */
describe('宿主注册表', () => {
  it('注册了三个宿主，id 都符合 HARNESS_ID_PATTERN', () => {
    // 顺序 = harness/index.ts 的 import 顺序（CLI 帮助按它列）
    expect(harnessIds()).toEqual(['dsh', 'claude-code', 'codex']);
    for (const id of harnessIds()) {
      expect(HARNESS_ID_PATTERN.test(id), `${id} 应该匹配 id 规则`).toBe(true);
      expect(isHarnessId(id)).toBe(true);
      expect(requireHarness(id).id).toBe(id);
      expect(harness(id)?.id).toBe(id);
    }
  });

  it('opencode 没有注册：不是宿主', () => {
    expect(isHarnessId('opencode')).toBe(false);
    expect(harness('opencode')).toBeUndefined();
    expect(harnessIds()).not.toContain('opencode');
    expect(harnessIds()).not.toContain('dir');
  });

  it('layoutFor：平铺不碰宿主的落点；每个宿主的差量来自它模块里的 layout', () => {
    expect(layoutFor()).toBe(DIR_LAYOUT_VARS);
    expect(DIR_LAYOUT_VARS.instructionFile).toBeUndefined();

    for (const id of harnessIds()) {
      const specOfId = requireHarness(id);
      expect(layoutFor(id)).toEqual(layoutVarsWith(specOfId.layout));
      expect(layoutFor(id)).toMatchObject(specOfId.layout);
      expect(layoutFor(id).instructionFile).toBeTruthy();
    }
    // 未知宿主：不猜，直接抛
    expect(() => layoutFor('opencode')).toThrow(/未知宿主：opencode/);
  });

  it('schema 的 scenario.harness 是 string + pattern，不是静态 enum', () => {
    const node = (packhubSchema as unknown as {
      definitions: {
        check: { properties: { harness: { type?: string; pattern?: string; enum?: unknown[] } } };
      };
    }).definitions.check.properties.harness;
    expect(node.type).toBe('string');
    expect(node.enum).toBeUndefined();
    expect(node.pattern).toBe(HARNESS_ID_PATTERN.source);
    // 三个已注册的宿主都过这条 pattern；opencode 也过（它是合法 id，只是没注册）
    for (const id of harnessIds()) expect(new RegExp(node.pattern!).test(id)).toBe(true);
    expect(new RegExp(node.pattern!).test('Opencode')).toBe(false);
  });

  it('metadata 不声明 targets（安装形态不在内容层）', () => {
    const metadata = (packhubSchema as unknown as {
      properties: { metadata: { properties: Record<string, unknown> } };
    }).properties.metadata;
    expect(Object.keys(metadata.properties)).not.toContain('targets');
  });
});

describe('临时注册', () => {
  it('registerHarness 之后 harnessIds / isHarnessId / layoutFor 立刻生效', () => {
    const temp = spec('temp-host', {
      layout: { instructionFile: 'TEMP.md', skillsDir: '.temp/skills' },
    });
    registerHarness(temp);

    expect(harnessIds()).toContain('temp-host');
    expect(isHarnessId('temp-host')).toBe(true);
    expect(harness('temp-host')).toBe(temp);
    expect(requireHarness('temp-host').label).toBe('temp-host');
    expect(layoutFor('temp-host').skillsDir).toBe('.temp/skills');
    expect(layoutFor('temp-host').instructionFile).toBe('TEMP.md');
    // 注册项只叠自己的差量：其余仍是平铺
    expect(layoutFor('temp-host').knowledgeDir).toBe(DIR_LAYOUT_VARS.knowledgeDir);
  });

  it('非法 id 抛错，且不会进注册表', () => {
    expect(() => registerHarness(spec('Bad_Id'))).toThrow(/宿主 id 不合法/);
    expect(isHarnessId('Bad_Id')).toBe(false);
  });

  it('重复 id 抛错（模块被 import 两次或 id 抄错）', () => {
    expect(() => registerHarness(spec('dsh'))).toThrow(/宿主重复注册：dsh/);
  });
});
