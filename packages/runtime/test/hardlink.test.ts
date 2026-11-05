import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { activatePack, installPack, loadPack, planFor, removePack } from '../src/index.ts';

function scaffold(version: string, body: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'packhub-hardlink-'));
  writeFileSync(
    join(dir, 'packhub.yaml'),
    `apiVersion: packhub.dev/v0
kind: Pack
metadata: { name: demo/hardlink, version: ${version}, targets: [dir] }
requires: { packhub: ">=0.0.1 <0.1" }
resources:
  - id: rules
    type: knowledge
    source: ./rules.md
  - id: review
    type: skill
    source: ./skill
`,
    'utf8',
  );
  writeFileSync(join(dir, 'rules.md'), body, 'utf8');
  mkdirSync(join(dir, 'skill'), { recursive: true });
  writeFileSync(join(dir, 'skill', 'SKILL.md'), `---\nname: review\ndescription: 审阅\n---\n${body}`, 'utf8');
  return dir;
}

describe('版本镜像硬链接', () => {
  it('安装产物与版本镜像共享 inode；升级用原子替换，不污染旧镜像', async () => {
    const dir = scaffold('0.0.1', '# one\n');
    const first = loadPack(dir);
    await installPack(first, planFor(first).plan!);

    const live = join(dir, '.packhub/knowledge/rules.md');
    const v1 = join(
      dir,
      '.packhub/versions/demo-hardlink/0.0.1/files/.packhub/knowledge/rules.md',
    );
    expect(readFileSync(live, 'utf8')).toBe('# one\n');
    expect(readFileSync(v1, 'utf8')).toBe('# one\n');
    // NTFS / ext4 都支持硬链接；不支持时安装会退回复制，这里只检查字节共享
    expect(statSync(live).nlink).toBeGreaterThanOrEqual(2);
    expect(statSync(join(dir, '.packhub/skills/review/SKILL.md')).nlink).toBeGreaterThanOrEqual(2);

    // 新版本写同一路径：rename 换目录项，旧镜像的 inode 不该被改
    writeFileSync(join(dir, 'packhub.yaml'), readFileSync(join(dir, 'packhub.yaml'), 'utf8').replace('0.0.1', '0.0.2'), 'utf8');
    writeFileSync(join(dir, 'rules.md'), '# two\n', 'utf8');
    const second = loadPack(dir);
    await installPack(second, planFor(second).plan!);

    expect(readFileSync(live, 'utf8')).toBe('# two\n');
    expect(readFileSync(v1, 'utf8')).toBe('# one\n');

    // 切回旧版本：按镜像铺回，内容恢复
    await activatePack(dir, 'demo/hardlink', '0.0.1');
    expect(readFileSync(live, 'utf8')).toBe('# one\n');

    removePack(dir);
    rmSync(dir, { recursive: true, force: true });
  });
});
