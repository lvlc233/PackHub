import { existsSync, readFileSync } from 'node:fs';
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
  if (/GNU GENERAL PUBLIC LICENSE/i.test(text)) return 'GPL';
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
