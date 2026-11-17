import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXIT, EXIT_TEXT } from '../src/emit.ts';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const BIN = join(ROOT, 'apps/local/src/bin.ts');

interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function run(args: string[], env: Record<string, string> = {}): RunResult {
  const res = spawnSync(process.execPath, ['--experimental-strip-types', BIN, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 60_000,
    env: { ...process.env, PACKHUB_HOME: join(tmpdir(), 'packhub-cli-exit-home'), ...env },
  });
  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

const MANIFEST = (extra = ''): string => `apiVersion: packhub.dev/v0
kind: Pack
metadata:
  name: demo/exit
  version: 0.0.1
  targets: [dir]
requires: { packhub: ">=0.0.1 <0.1" }
resources:
  - id: rules
    type: knowledge
    source: ./rules.md
${extra}`;

function makePack(dir: string, opts: { verifyMissing?: boolean; extra?: string } = {}): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'packhub.yaml'), MANIFEST(opts.extra), 'utf8');
  writeFileSync(join(dir, 'rules.md'), '# rules\n', 'utf8');
  if (opts.verifyMissing) {
    writeFileSync(
      join(dir, 'packhub.yaml'),
      MANIFEST(
        'verify:\n  - type: file-exists\n    path: "${target.knowledgeDir}/not-there.md"\n' +
          (opts.extra ?? ''),
      ),
      'utf8',
    );
  }
}

/**
 * 失败分支只在这里枚举：退出码（EXIT 表）与 stderr 前缀（`x ` / 原样一行）都是契约。
 * 新增命令的失败分支请往这张表里加一行，别在命令体里再发明一种退出码。
 */
const CASES: {
  name: string;
  args: (base: string) => string[];
  prepare?: (base: string) => void;
  code: number;
  stderr?: RegExp;
  stdout?: RegExp;
  /** 失败时 stdout 必须为空（错误只走 stderr，不污染脚本可解析的输出）。 */
  quietStdout?: boolean;
}[] = [
  {
    name: '缺清单：plan 找不到 packhub.yaml',
    args: (base) => ['plan', join(base, 'nope')],
    code: 2,
    stderr: /^error \[manifest-missing\] /m,
    quietStdout: true,
  },
  {
    name: '缺清单：plan 的收尾摘要仍打印「N 个错误」',
    args: (base) => ['plan', join(base, 'nope')],
    code: 2,
    stderr: /^packhub: 1 个错误，未继续。$/m,
    quietStdout: true,
  },
  {
    name: '未知参数：带 x 前缀 + 下一步提示',
    args: (base) => ['plan', base, '--nonsense'],
    code: 2,
    stderr: /^x 未知参数 --nonsense（plan）；用 packhub plan --help 看可用参数$/m,
    quietStdout: true,
  },
  {
    name: '坏参数：init 的 owner/name 校验（原样一行，不带 x）',
    args: (base) => ['init', join(base, 'pack'), '--name', 'bare'],
    code: 2,
    stderr: /^--name 要写成 owner\/name（小写字母、数字、连字符，两段各至少一个字符）：收到 bare$/m,
    quietStdout: true,
  },
  {
    name: '坏参数：trust require 只认 on/off',
    args: () => ['trust', 'require', 'maybe'],
    code: 2,
    stderr: /^只认 on 或 off：收到 maybe$/m,
    quietStdout: true,
  },
  {
    name: '坏参数：activate 缺版本',
    args: (base) => ['activate', 'demo/exit', base],
    code: 2,
    stderr: /^用法：packhub activate <name>@<version>$/m,
    quietStdout: true,
  },
  {
    name: '坏参数：completion 不支持的 shell',
    args: () => ['completion', 'fish'],
    code: 2,
    stderr: /^不支持的 shell：fish（bash \/ zsh \/ pwsh）$/m,
    quietStdout: true,
  },
  {
    name: '坏参数：resource add 未知类型',
    args: (base) => ['resource', 'add', 'bogus', './rules.md', '--dir', base],
    code: 2,
    stderr: /^未知类型：bogus（可选：/m,
    quietStdout: true,
  },
  {
    name: '前置条件：diff 没有锁',
    args: (base) => ['diff', base],
    code: 2,
    stderr: /^没有 packhub\.lock\.json：先跑 packhub lock$/m,
    quietStdout: true,
  },
  {
    name: '前置条件：search 没有索引',
    args: () => ['search', 'conventions'],
    code: 2,
    stderr: /^没有索引：加 --index/m,
    quietStdout: true,
  },
  {
    name: '前置条件：add 用 registry 名称但没配索引',
    args: (base) => ['add', 'lvlc233/team-conventions', '--dir', base],
    code: 2,
    stderr: /^用 registry 名称安装需要一个索引/m,
    quietStdout: true,
  },
  {
    name: '前置条件：pack --reference 遇到本地来源（错误码 2，不是 1）',
    args: (base) => ['pack', base, '--reference'],
    prepare: (base) => makePack(base),
    code: 2,
    stderr: /^x 清单里有 1 个本地文件/m,
    quietStdout: true,
  },
  {
    name: '前置条件：sync 未知 target',
    args: (base) => ['sync', base, '--to', 'opencode'],
    prepare: (base) => makePack(base),
    code: 2,
    stderr: /^x 未知 target：opencode/m,
    quietStdout: true,
  },
  {
    name: '校验失败是运行错：verify 退出 1 并列出 fail',
    args: (base) => ['verify', base],
    prepare: (base) => makePack(base, { verifyMissing: true }),
    code: 1,
    stdout: /fail/,
  },
];

describe('退出码与错误前缀的单点契约', () => {
  it('EXIT 表只有三档：成功 0 / 运行失败 1 / 输入与前置条件 2', () => {
    expect(EXIT).toEqual({ OK: 0, RUNTIME: 1, USAGE: 2 });
    expect(Object.keys(EXIT_TEXT).sort()).toEqual(['0', '1', '2']);
    expect(EXIT_TEXT[EXIT.USAGE]).toContain('前置条件');
  });

  it.each(CASES)('$name → 退出码 $code', (c) => {
    const base = mkdtempSync(join(tmpdir(), 'packhub-cli-exit-'));
    const home = mkdtempSync(join(tmpdir(), 'packhub-cli-exit-home-'));
    try {
      c.prepare?.(base);
      const res = run(c.args(base), { PACKHUB_HOME: home });
      expect(res.status).toBe(c.code);
      if (c.stderr) expect(res.stderr).toMatch(c.stderr);
      if (c.stdout) expect(res.stdout).toMatch(c.stdout);
      if (c.quietStdout) expect(res.stdout).toBe('');
    } finally {
      rmSync(base, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('单点约束：退出码与输出不再散落在命令里', () => {
  const read = (file: string): string => readFileSync(join(ROOT, 'apps/local/src', file), 'utf8');

  it('cli.ts / ref.ts 里没有 process.exit 与 console.*', () => {
    for (const file of ['cli.ts', 'ref.ts']) {
      const text = read(file);
      expect(text, `${file} 不该自己 process.exit`).not.toMatch(/process\.exit\(/);
      expect(text, `${file} 不该自己写 stdout/stderr`).not.toMatch(/console\.(log|error|warn)\(/);
    }
  });

  it('bin.ts 只保留入口级的 terminate，不自己拼错误行', () => {
    const text = read('bin.ts');
    expect(text).not.toMatch(/console\./);
    expect(text).toMatch(/terminate\(EXIT\.USAGE\)/);
    expect(text).toMatch(/terminate\(EXIT\.RUNTIME\)/);
  });
});
