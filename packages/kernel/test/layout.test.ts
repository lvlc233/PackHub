import { describe, expect, it } from 'vitest';
import packhubSchema from '../../../schema/packhub.v0.schema.json' with { type: 'json' };
import { HARNESS_IDS } from '../src/types.ts';
import { DIR_LAYOUT_VARS, LAYOUT_VARS, layoutFor } from '../src/layout.ts';

/**
 * 宿主只在代码里有一份来源：`HARNESS_IDS` 与落点表 `LAYOUT_VARS`。
 *
 * 「平铺到项目里」不是宿主，只是没选宿主（`layoutFor()` → `DIR_LAYOUT_VARS`），
 * 所以宿主名单里没有 `dir`。安装形态也不进内容层：schema 的 metadata 里没有 targets。
 */
describe('宿主与落点名单源', () => {
  it('HARNESS_IDS 里没有 dir：不选宿主就是平铺目录', () => {
    expect(HARNESS_IDS.length).toBeGreaterThan(0);
    expect(HARNESS_IDS).not.toContain('dir');
  });

  it('LAYOUT_VARS 覆盖且只覆盖 HARNESS_IDS', () => {
    expect(Object.keys(LAYOUT_VARS)).toEqual([...HARNESS_IDS]);
  });

  it('layoutFor() 是平铺；每个宿主都有自己的指令文件', () => {
    expect(layoutFor()).toBe(DIR_LAYOUT_VARS);
    expect(DIR_LAYOUT_VARS.instructionFile).toBeUndefined();
    for (const id of HARNESS_IDS) {
      expect(layoutFor(id)).toBe(LAYOUT_VARS[id]);
      expect(layoutFor(id).instructionFile).toBeTruthy();
    }
  });

  it('metadata 不声明 targets（安装形态不在内容层）', () => {
    const metadata = (packhubSchema as unknown as {
      properties: { metadata: { properties: Record<string, unknown> } };
    }).properties.metadata;
    expect(Object.keys(metadata.properties)).not.toContain('targets');
  });
});
