import { describe, expect, it } from 'vitest';
import packhubSchema from '../../../schema/packhub.v0.schema.json' with { type: 'json' };
import { HARNESS_IDS, TARGET_IDS } from '../src/types.ts';
import { TARGET_VARS } from '../src/targets.ts';

/**
 * 安装 target 只在代码里有一份来源：`TARGET_IDS` 与落点表 `TARGET_VARS`。
 *
 * target 不参与内容声明——清单级与资源条目都没有 target 字段，装到哪由命令行
 * `--target` 现选。schema 里也不再带 target 的 enum，所以这里只比 TS 常量本身。
 */
describe('安装 target 单源', () => {
  it('HARNESS_IDS 是不含 dir 的宿主名单，TARGET_IDS 由它派生', () => {
    expect([...TARGET_IDS]).toEqual(['dir', ...HARNESS_IDS]);
    expect(HARNESS_IDS).not.toContain('dir');
  });

  it('metadata 不声明 targets（target 不在内容层）', () => {
    const metadata = (packhubSchema as unknown as {
      properties: { metadata: { properties: Record<string, unknown> } };
    }).properties.metadata;
    expect(Object.keys(metadata.properties)).not.toContain('targets');
  });

  it('落点表覆盖且只覆盖 TARGET_IDS', () => {
    expect(Object.keys(TARGET_VARS)).toEqual([...TARGET_IDS]);
  });

  it('dir 不碰宿主指令面，其余宿主都有指令文件', () => {
    expect(TARGET_VARS.dir.instructionFile).toBeUndefined();
    for (const id of TARGET_IDS.filter((target) => target !== 'dir')) {
      expect(TARGET_VARS[id].instructionFile).toBeTruthy();
    }
  });
});
