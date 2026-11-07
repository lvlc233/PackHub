/**
 * 面板用的枚举清单。
 *
 * 从 schema 读，不再在面板里抄一份；schema 与 kernel 的 `RESOURCE_TYPES` / `TARGET_IDS`
 * 由 `packages/kernel/test/resource-types.test.ts`、`targets.test.ts` 比对，两边不会各走各的。
 */
import schema from '../../../schema/packhub.v0.schema.json';

interface ManifestSchema {
  definitions: {
    resource: { properties: { type: { enum: string[] } } };
    metadata: { properties: { targets: { items: { enum: string[] } } } };
  };
}

const manifest = (schema as unknown as ManifestSchema).definitions;

export const RESOURCE_TYPES: readonly string[] = manifest.resource.properties.type.enum;
export const TARGETS: readonly string[] = manifest.metadata.properties.targets.items.enum;
