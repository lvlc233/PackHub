import schemaJson from '../../../schema/packhub.v0.schema.json' with { type: 'json' };
import { PACK_NAME_PATTERN } from '@packhub/kernel';

/** 包名同 kernel 的那一条（`owner/name`），这里只转手，不另写正则。 */
export { PACK_NAME_PATTERN };

/**
 * `metadata.version` 的形状。
 *
 * 与 kernel 的 `PACK_NAME_PATTERN`（`kernel/src/manifest.ts`）同一写法：从 schema 取正则，
 * 不在这里手抄。kernel 目前只导出了名字那一条；等 kernel 导出版本常量，这里换成 import，
 * 否则两份从同一 schema 派生的正则虽然不会漂，但会多一个派生点。
 */
export const PACK_VERSION_PATTERN = new RegExp(
  (schemaJson as { properties: { metadata: { properties: { version: { pattern: string } } } } })
    .properties.metadata.properties.version.pattern,
);
