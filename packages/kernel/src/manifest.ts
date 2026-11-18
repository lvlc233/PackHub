// 加载并解析 packhub.yaml（清单），按 schema 校验后转成内存数据。

import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import Ajv, { type ValidateFunction } from 'ajv';
import addFormats from 'ajv-formats';
import type { Issue, Manifest } from './types.ts';
import { ISSUE_CODES } from './issueCodes.ts';

import schemaJson from '../../../schema/packhub.v0.schema.json' with { type: 'json' };

/**
 * `metadata.name` 的形状：`owner/name`。
 *
 * 从 schema 里取，不在这里再写一遍——init 需要提前拦一个坏名字，而权威只有一个来源。
 */
export const PACK_NAME_PATTERN = new RegExp(
  (schemaJson as { properties: { metadata: { properties: { name: { pattern: string } } } } })
    .properties.metadata.properties.name.pattern,
);

/** `metadata.version` 的形状，同样从 schema 取。 */
export const PACK_VERSION_PATTERN = new RegExp(
  (schemaJson as { properties: { metadata: { properties: { version: { pattern: string } } } } })
    .properties.metadata.properties.version.pattern,
);

let cachedValidator: ValidateFunction | undefined;

function validator(): ValidateFunction {
  if (!cachedValidator) {
    const schema = schemaJson as Record<string, unknown>;
    const ajv = new Ajv({ allErrors: true, strict: false });
    addFormats(ajv);
    cachedValidator = ajv.compile(schema);
  }
  return cachedValidator;
}

export interface LoadResult {
  manifest?: Manifest;
  issues: Issue[];
  /** YAML 文本，给诊断用 */
  text: string;
}

export function loadManifest(file: string): LoadResult {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return {
      issues: [
        {
          code: code === 'ENOENT' ? ISSUE_CODES.manifestMissing : ISSUE_CODES.manifestUnreadable,
          severity: 'error',
          message:
            code === 'ENOENT'
              ? `没有这个 Pack 清单：${file}（确认目录，或先跑 packhub init）`
              : `读不了清单：${file}（${(err as Error).message}）`,
        },
      ],
      text: '',
    };
  }
  return parseManifest(text, file);
}

export function parseManifest(text: string, file = '<inline>'): LoadResult {
  let data: unknown;
  try {
    data = parseYaml(text);
  } catch (err) {
    return {
      issues: [
        {
          code: ISSUE_CODES.yamlSyntax,
          severity: 'error',
          message: `${file}: YAML 解析失败：${(err as Error).message}`,
        },
      ],
      text,
    };
  }

  const validate = validator();
  if (!validate(data)) {
    const issues = (validate.errors ?? []).map<Issue>((e) => ({
      code: ISSUE_CODES.schema,
      severity: 'error',
      message: `${e.instancePath || '/'} ${e.message ?? ''}`.trim(),
      path: e.instancePath,
    }));
    return { issues, text };
  }

  return { manifest: data as Manifest, issues: [], text };
}
