import { describe, expect, it } from 'vitest';
import packhubSchema from '../../../schema/packhub.v0.schema.json' with { type: 'json' };
import resourcesSchema from '../../../schema/resources.v0.schema.json' with { type: 'json' };
import { RESOURCE_TYPES, isResourceType } from '../src/types.ts';

/** 资源类型只有一份 TS 常量；schema 的两处 enum 用这个测试盯着，别各写各的。 */
function manifestTypeEnum(): string[] {
  return (packhubSchema as unknown as {
    definitions: { resource: { properties: { type: { enum: string[] } } } };
  }).definitions.resource.properties.type.enum;
}

function catalogTypeEnum(): string[] {
  return (resourcesSchema as unknown as {
    properties: { resources: { items: { properties: { type: { enum: string[] } } } } };
  }).properties.resources.items.properties.type.enum;
}

describe('资源类型单源', () => {
  it('packhub schema 的 type enum 与 RESOURCE_TYPES 一致（含顺序）', () => {
    expect(manifestTypeEnum()).toEqual([...RESOURCE_TYPES]);
  });

  it('resources schema 的 type enum 与 RESOURCE_TYPES 一致（含顺序）', () => {
    expect(catalogTypeEnum()).toEqual([...RESOURCE_TYPES]);
  });

  it('isResourceType 只认表里的值', () => {
    for (const type of RESOURCE_TYPES) expect(isResourceType(type)).toBe(true);
    expect(isResourceType('plugin')).toBe(false);
    expect(isResourceType(undefined)).toBe(false);
  });
});
