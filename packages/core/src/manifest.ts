import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import Ajv, { type ValidateFunction } from 'ajv';
import addFormats from 'ajv-formats';
import type { Issue, Manifest } from './types.ts';

const SCHEMA_URL = new URL('../../../schema/packhub.v0.0.1.schema.json', import.meta.url);

let cachedValidator: ValidateFunction | undefined;

function validator(): ValidateFunction {
  if (!cachedValidator) {
    const schema = JSON.parse(readFileSync(SCHEMA_URL, 'utf8'));
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
  const text = readFileSync(file, 'utf8');
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
          code: 'yaml-syntax',
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
      code: 'schema',
      severity: 'error',
      message: `${e.instancePath || '/'} ${e.message ?? ''}`.trim(),
      path: e.instancePath,
    }));
    return { issues, text };
  }

  return { manifest: data as Manifest, issues: [], text };
}
