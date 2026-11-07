import { describe, expect, it } from 'vitest';
import packhubSchema from '../../../schema/packhub.v0.schema.json' with { type: 'json' };
import resourcesSchema from '../../../schema/resources.v0.schema.json' with { type: 'json' };
import { TARGET_IDS } from '../src/types.ts';
import { TARGET_VARS } from '../src/plan.ts';

/** 安装 target 只有一份 TS 常量；schema 的 enum 与落点表用这个测试盯着。 */
function manifestTargets(): string[] {
  return (packhubSchema as unknown as {
    properties: { metadata: { properties: { targets: { items: { enum: string[] } } } } };
  }).properties.metadata.properties.targets.items.enum;
}

function resourceTargets(): string[] {
  return (packhubSchema as unknown as {
    definitions: { resource: { properties: { targets: { items: { enum: string[] } } } } };
  }).definitions.resource.properties.targets.items.enum;
}

function catalogTargets(): string[] {
  return (resourcesSchema as unknown as {
    properties: { resources: { items: { properties: { targets: { items: { enum: string[] } } } } } };
  }).properties.resources.items.properties.targets.items.enum;
}

describe('安装 target 单源', () => {
  it('schema 的三处 target enum 与 TARGET_IDS 一致', () => {
    expect(manifestTargets()).toEqual([...TARGET_IDS]);
    expect(resourceTargets()).toEqual([...TARGET_IDS]);
    expect(catalogTargets()).toEqual([...TARGET_IDS]);
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
