import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { doctorPack, installPack, loadPack, planFor } from '../src/index.ts';

const MANIFEST = `apiVersion: packhub.dev/v0
kind: Pack
metadata:
  name: demo/doctor
  version: 0.0.1
  title: 漂移检测
  targets: [dir, claude-code]
requires: { packhub: ">=0.0.1 <0.1" }
resources:
  - id: rules
    type: knowledge
    source: ./rules.md
`;

async function installed(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'packhub-doctor-'));
  writeFileSync(join(dir, 'packhub.yaml'), MANIFEST, 'utf8');
  writeFileSync(join(dir, 'rules.md'), '# r\n', 'utf8');
  const ctx = loadPack(dir);
  await installPack(ctx, planFor(ctx, { target: 'claude-code' }).plan!);
  return dir;
}

describe('doctor', () => {
  it('装完立刻检查：全部在位', async () => {
    const dir = await installed();
    const report = doctorPack(dir);
    expect(report.ok).toBe(true);
    expect(report.packs).toHaveLength(1);
    rmSync(dir, { recursive: true, force: true });
  });

  it('active.json 与 state 不一致能发现', async () => {
    const dir = await installed();
    const activePath = join(dir, '.packhub/active.json');
    const active = JSON.parse(readFileSync(activePath, 'utf8')) as {
      packs: Record<string, { version: string }>;
    };
    active.packs['demo/doctor']!.version = '9.9.9';
    writeFileSync(activePath, JSON.stringify(active, null, 2), 'utf8');
    const report = doctorPack(dir);
    expect(report.ok).toBe(false);
    expect(report.findings[0]!.activeDrift.join(' ')).toContain('active=9.9.9');
    rmSync(dir, { recursive: true, force: true });
  });

  it('active.json 丢失能发现', async () => {
    const dir = await installed();
    rmSync(join(dir, '.packhub/active.json'), { force: true });
    const report = doctorPack(dir);
    expect(report.ok).toBe(false);
    expect(report.findings[0]!.activeDrift.join(' ')).toContain('active.json 没有');
    rmSync(dir, { recursive: true, force: true });
  });

  it('宿主重写掉指令文件后能指出托管块不见了', async () => {
    const dir = await installed();
    // 模拟 Claude Code / 用户自己重新生成 CLAUDE.md
    writeFileSync(join(dir, 'CLAUDE.md'), '# 我自己的说明\n', 'utf8');
    const report = doctorPack(dir);
    expect(report.ok).toBe(false);
    expect(report.findings[0]!.blocksMissing).toContain('CLAUDE.md');
    expect(report.findings[0]!.blockIds).toContain('demo/doctor');
    rmSync(dir, { recursive: true, force: true });
  });

  it('写过的文件被删也能发现', async () => {
    const dir = await installed();
    rmSync(join(dir, '.packhub/knowledge/rules.md'));
    const report = doctorPack(dir);
    expect(report.ok).toBe(false);
    expect(report.findings[0]!.filesMissing).toContain('.packhub/knowledge/rules.md');
    rmSync(dir, { recursive: true, force: true });
  });


  it('配置键被外部改掉能发现（靠安装时记录的 applied 值）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'packhub-doctor-cfg-'));
    writeFileSync(
      join(dir, 'packhub.yaml'),
      `apiVersion: packhub.dev/v0
kind: Pack
metadata: { name: demo/cfg-drift, version: 0.0.1, targets: [dir] }
requires: { packhub: ">=0.0.1 <0.1" }
resources:
  - id: cfg
    type: config
    source: ./cfg.yaml
`,
      'utf8',
    );
    writeFileSync(join(dir, 'cfg.yaml'), 'app:\n  flavor: a\n', 'utf8');
    const ctx = loadPack(dir);
    await installPack(ctx, planFor(ctx).plan!);
    expect(doctorPack(dir).ok).toBe(true);

    const cfg = JSON.parse(readFileSync(join(dir, '.packhub/config.json'), 'utf8'));
    cfg.app.flavor = 'b';
    writeFileSync(join(dir, '.packhub/config.json'), JSON.stringify(cfg, null, 2), 'utf8');
    const report = doctorPack(dir);
    expect(report.ok).toBe(false);
    expect(report.findings[0]?.configDrift).toContain('.packhub/config.json:app.flavor');
    rmSync(dir, { recursive: true, force: true });
  });
  it('块还在但内容被改过不算漂移（我们只管块的存在）', async () => {
    const dir = await installed();
    const text = readFileSync(join(dir, 'CLAUDE.md'), 'utf8');
    writeFileSync(join(dir, 'CLAUDE.md'), text.replace('可以被 Agent 引用', '被改过'), 'utf8');
    expect(doctorPack(dir).ok).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });
});
