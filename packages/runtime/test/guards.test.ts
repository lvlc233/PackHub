import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyPlan, isSafeArchiveEntry } from '../src/index.ts';
import type { Plan } from '@packhub/kernel';

function plan(actions: Plan['actions']): Plan {
  return {
    apiVersion: 'packhub.dev/plan/v0',
    pack: { name: 'demo/guard', version: '0.0.1' },
    target: 'dir',
    actions,
    verify: [],
    excluded: [],
    planHash: 'sha256-guard',
  };
}

describe('安装锁与所有权', () => {
  it('崩溃留下的锁（pid 已死）自动收回；活着的锁仍然拒绝', async () => {
    const root = mkdtempSync(join(tmpdir(), 'packhub-lock-'));
    mkdirSync(join(root, '.packhub'), { recursive: true });
    const lock = join(root, '.packhub/installing.lock');

    writeFileSync(lock, '999999', 'utf8');
    const ok = await applyPlan(
      plan([
        { actionId: 'write#1', op: 'write', to: '.packhub/a.txt', content: 'a' },
      ]),
      { root },
    );
    expect(ok.outcomes[0]?.status).toBe('done');
    expect(readFileSync(join(root, '.packhub/a.txt'), 'utf8')).toBe('a');

    writeFileSync(lock, String(process.pid), 'utf8');
    await expect(
      applyPlan(plan([{ actionId: 'write#1', op: 'write', to: '.packhub/b.txt', content: 'b' }]), {
        root,
      }),
    ).rejects.toThrow(/另一个安装正在进行/);
    rmSync(root, { recursive: true, force: true });
  });

  it('一个包拥有目录时，另一个包往目录里写文件算冲突', async () => {
    const root = mkdtempSync(join(tmpdir(), 'packhub-own-'));
    const skill = mkdtempSync(join(tmpdir(), 'packhub-own-skill-'));
    writeFileSync(join(skill, 'SKILL.md'), '---\nname: hello\ndescription: d\n---\n', 'utf8');

    await applyPlan(
      {
        ...plan([
          {
            actionId: 'link.skill#1',
            op: 'link.skill',
            from: '.',
            to: '.packhub/skills/hello',
          },
        ]),
        pack: { name: 'demo/owner', version: '0.0.1' },
      },
      { root, packRoot: skill },
    );

    await expect(
      applyPlan(
        plan([
          {
            actionId: 'write#1',
            op: 'write',
            to: '.packhub/skills/hello/SKILL.md',
            content: 'x',
          },
        ]),
        { root },
      ),
    ).rejects.toThrow(/已被别的包占用/);
    rmSync(root, { recursive: true, force: true });
    rmSync(skill, { recursive: true, force: true });
  });
});

describe('归档条目过滤', () => {
  it('拒绝 ..、绝对路径与符号/硬链接，普通文件放行', () => {
    expect(isSafeArchiveEntry('skills/x/SKILL.md', { type: 'File' })).toBe(true);
    expect(isSafeArchiveEntry('../escape', { type: 'File' })).toBe(false);
    expect(isSafeArchiveEntry('a/../../escape', { type: 'File' })).toBe(false);
    expect(isSafeArchiveEntry('/etc/passwd', { type: 'File' })).toBe(false);
    expect(isSafeArchiveEntry('C:/Windows/System32/x', { type: 'File' })).toBe(false);
    expect(isSafeArchiveEntry('..\\escape', { type: 'File' })).toBe(false);
    expect(isSafeArchiveEntry('link', { type: 'SymbolicLink' })).toBe(false);
    expect(isSafeArchiveEntry('hard', { type: 'Link' })).toBe(false);
  });
});
