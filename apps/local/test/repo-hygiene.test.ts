import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const WORKFLOWS = join(ROOT, '.github/workflows');

describe('仓库的供应链卫生', () => {
  // 钉的必须是 commit。annotated tag 的 `refs/tags/v4` 指向的是 tag 对象而不是 commit，
  // 拿那个 SHA 钉上去，Actions 在 setup 阶段就解析不了（pnpm/action-setup@v4 踩过）。
  it('workflow 里的 action 钉在 commit SHA 上，注释里写版本', () => {
    const files = readdirSync(WORKFLOWS).filter((f) => /\.ya?ml$/.test(f));
    expect(files.length).toBeGreaterThan(0);

    const offenders: string[] = [];
    for (const file of files) {
      for (const [index, line] of readFileSync(join(WORKFLOWS, file), 'utf8').split(/\r?\n/).entries()) {
        const match = line.match(/uses:\s*([^\s#]+)/);
        if (!match) continue;
        const ref = match[1]!;
        if (ref.startsWith('./')) continue; // 仓库内的本地 action 不需要钉
        const at = ref.lastIndexOf('@');
        const pin = at >= 0 ? ref.slice(at + 1) : '';
        if (!/^[0-9a-f]{40}$/.test(pin)) {
          offenders.push(`${file}:${index + 1} ${ref}（不是 commit SHA）`);
        } else if (!/#\s*v\d/.test(line)) {
          offenders.push(`${file}:${index + 1} ${ref}（注释里缺版本）`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('dependabot 盯着 actions 与 npm，每周看一次', () => {
    const text = readFileSync(join(ROOT, '.github/dependabot.yml'), 'utf8');
    expect(text).toContain('package-ecosystem: github-actions');
    expect(text).toContain('package-ecosystem: npm');
    expect(text).toMatch(/interval:\s*weekly/);
  });
});
