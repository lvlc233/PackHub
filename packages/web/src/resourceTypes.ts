/**
 * 面板用的资源类型清单。
 *
 * 从 schema 的 enum 读，不再在面板里抄一份；schema 与 kernel 的 `RESOURCE_TYPES`
 * 由 `packages/kernel/test/resource-types.test.ts` 比对，两边不会各走各的。
 */
import schema from '../../../schema/packhub.v0.schema.json';

interface ManifestSchema {
  definitions: { resource: { properties: { type: { enum: string[] } } } };
}

const definition = (schema as unknown as ManifestSchema).definitions.resource.properties.type.enum;

export const RESOURCE_TYPES: readonly string[] = definition;
