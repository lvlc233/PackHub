import { existsSync, readFileSync } from 'node:fs';
import { httpJson } from './download.ts';
import { join, resolve } from 'node:path';
import type { Manifest } from '@packhub/kernel';
import { parseSource } from '@packhub/kernel';

export interface LicenseFinding {
  resource: string;
  type: string;
  source: string;
  /** 找到的许可证文件（相对 Pack 目录） */
  file?: string;
  /** 从文本里猜的 SPDX 标识，猜不出就是 undefined */
  spdx?: string;
  vendored: boolean;
}

const CANDIDATES = ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'COPYING', 'NOTICE'];

/** 只做"有没有、像不像"，不做法律判断。 */
function detect(file: string): string | undefined {
  const text = readFileSync(file, 'utf8').slice(0, 4000);
  if (/MIT License|Permission is hereby granted, free of charge/i.test(text)) return 'MIT';
  if (/Apache License\s+Version 2\.0/i.test(text)) return 'Apache-2.0';
  if (/BSD 3-Clause|Redistribution and use in source and binary forms/i.test(text)) return 'BSD';
  if (/Creative Commons Attribution/i.test(text)) return 'CC-BY';
  if (/Mozilla Public License\s+Version 2\.0/i.test(text)) return 'MPL-2.0';
  if (/GNU AFFERO GENERAL PUBLIC LICENSE/i.test(text)) return 'AGPL-3.0';
  if (/GNU LESSER GENERAL PUBLIC LICENSE/i.test(text)) return 'LGPL-3.0';
  if (/GNU GENERAL PUBLIC LICENSE/i.test(text)) return 'GPL-3.0';
  return undefined;
}

/**
 * 列出每个资源的许可证情况。
 * 只对本地（vendored）资源找许可证文件——远程资源的许可在它自己的仓库里，我们看不到。
 */
export function inspectLicenses(dir: string, manifest: Manifest): LicenseFinding[] {
  const root = resolve(dir);
  return manifest.resources.map((res) => {
    const parsed = parseSource(res.source);
    const vendored = parsed.kind === 'local';
    const out: LicenseFinding = {
      resource: res.id,
      type: res.type,
      source: res.source,
      vendored,
    };
    if (!vendored) return out;

    const target = resolve(root, parsed.locator);
    for (const name of CANDIDATES) {
      const file = join(target, name);
      if (existsSync(file)) {
        out.file = `${parsed.locator.replace(/^\.\//, '')}/${name}`;
        const spdx = detect(file);
        if (spdx) out.spdx = spdx;
        break;
      }
    }
    return out;
  });
}

export interface LicensePolicy {
  /** 只允许这些 SPDX（前缀匹配）；为空表示不限制 */
  allow?: string[];
  /** 命中即拒绝（前缀匹配，例如 GPL 会拦 GPL-3.0） */
  deny?: string[];
  /** 允许 GPL/AGPL 这类强 copyleft */
  allowCopyleft?: boolean;
  allowNC?: boolean;
  allowND?: boolean;
  /** 猜不出 SPDX 时也拒绝 */
  requireSpdx?: boolean;
}

export interface LicenseVerdict {
  ok: boolean;
  reason?: string;
}

function isCopyleft(spdx: string): boolean {
  return /^(A|L)?GPL/i.test(spdx);
}

/** 只做策略匹配，不做法律解释：deny 优先，其次 NC/ND、copyleft、allow 白名单。 */
export function evaluateLicense(spdx: string | undefined, policy: LicensePolicy): LicenseVerdict {
  if (!spdx) {
    return policy.requireSpdx
      ? { ok: false, reason: '猜不出 SPDX，且策略要求明确许可' }
      : { ok: true, reason: '猜不出 SPDX，按未知处理（策略未强制）' };
  }
  const upper = spdx.toUpperCase();
  for (const denied of policy.deny ?? []) {
    if (upper.startsWith(denied.toUpperCase())) {
      return { ok: false, reason: `命中拒绝列表：${denied}` };
    }
  }
  if (/-NC\b/i.test(spdx) && !policy.allowNC) return { ok: false, reason: 'NC（禁止商用）未获允许' };
  if (/-ND\b/i.test(spdx) && !policy.allowND) return { ok: false, reason: 'ND（禁止演绎）未获允许' };
  if (isCopyleft(spdx) && !policy.allowCopyleft) {
    return { ok: false, reason: `${spdx} 是强 copyleft，策略未允许` };
  }
  if (policy.allow && policy.allow.length > 0) {
    const hit = policy.allow.some((a) => upper.startsWith(a.toUpperCase()));
    if (!hit) return { ok: false, reason: `不在允许列表：${policy.allow.join(', ')}` };
  }
  return { ok: true };
}

/** 远程 npm 资源：从 registry 元数据读 license 字段（拿不到就 undefined）。 */
export async function npmLicense(
  source: string,
  fetcher: (url: string) => Promise<unknown> = (url) =>
    httpJson(url, { accept: 'application/json' }),
): Promise<string | undefined> {
  const parsed = parseSource(source);
  if (parsed.kind !== 'npm') return undefined;
  const name = parsed.locator.replace(/^npm:/, '');
  const version = parsed.pin ?? 'latest';
  const meta = (await fetcher(
    `https://registry.npmjs.org/${name}/${encodeURIComponent(version)}`,
  )) as { license?: string | { type?: string } };
  if (typeof meta.license === 'string') return meta.license;
  return meta.license?.type;
}