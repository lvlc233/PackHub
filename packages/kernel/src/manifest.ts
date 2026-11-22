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

/**
 * 已经从格式里删掉的字段：给出点名报错，而不是让 ajv 报一句「additional properties」。
 *
 * 形如 `{ where, keys, message }`：where 决定去哪一层找键。只列已删除、且曾经有人写过的字段。
 */
const REMOVED_FIELDS: { where: 'top' | 'resource' | 'requires'; keys: string[]; message: string }[] = [
  {
    where: 'top',
    keys: ['alternatives', 'pick'],
    message: '已删除：同一能力的多个实现现在全部安装（能力叠加），不再二选一。删掉这个键。',
  },
  {
    where: 'top',
    keys: ['slots', 'bindings', 'roles'],
    message: '已删除：可替换位/备选组模型已移除；依赖关系用资源级 provides / needs 表达。删掉这个键。',
  },
  {
    where: 'resource',
    keys: ['targets'],
    message: '已删除：资源不再声明安装形态，装到哪个 target 由安装时的 --target 决定。删掉这个键。',
  },
  {
    where: 'resource',
    keys: ['slot', 'role'],
    message: '已删除：资源不再声明槽位/角色。删掉这个键。',
  },
  {
    where: 'resource',
    keys: ['dependsOn'],
    message: '已删除：needs 同时决定安装顺序，不再需要 dependsOn。删掉这个键。',
  },
  {
    where: 'requires',
    keys: ['agent'],
    message: '已删除：requires 只剩 packhub；宿主偏好由安装时选 target 决定。删掉这个键。',
  },
];

function findRemovedFields(data: unknown): Issue[] {
  if (!data || typeof data !== 'object') return [];
  const root = data as Record<string, unknown>;
  const issues: Issue[] = [];
  for (const rule of REMOVED_FIELDS) {
    if (rule.where === 'top') {
      for (const key of rule.keys) {
        if (key in root) {
          issues.push({ code: ISSUE_CODES.removedField, severity: 'error', message: `${key}：${rule.message}`, path: `/${key}` });
        }
      }
      continue;
    }
    if (rule.where === 'requires') {
      const requires = root.requires;
      if (requires && typeof requires === 'object') {
        for (const key of rule.keys) {
          if (key in (requires as Record<string, unknown>)) {
            issues.push({
              code: ISSUE_CODES.removedField,
              severity: 'error',
              message: `requires.${key}：${rule.message}`,
              path: `/requires/${key}`,
            });
          }
        }
      }
      continue;
    }
    const resources = root.resources;
    if (Array.isArray(resources)) {
      resources.forEach((res, i) => {
        if (!res || typeof res !== 'object') return;
        for (const key of rule.keys) {
          if (key in (res as Record<string, unknown>)) {
            issues.push({
              code: ISSUE_CODES.removedField,
              severity: 'error',
              message: `resources[${i}].${key}：${rule.message}`,
              path: `/resources/${i}/${key}`,
            });
          }
        }
      });
    }
  }
  return issues;
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

  // 先点名已删除的字段：schema 只会说「additional properties」，旧清单的作者看不出该删什么
  const removed = findRemovedFields(data);
  if (removed.length > 0) return { issues: removed, text };

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
