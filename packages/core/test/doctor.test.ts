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

  it('块还在但内容被改过不算漂移（我们只管块的存在）', async () => {
    const dir = await installed();
    const text = readFileSync(join(dir, 'CLAUDE.md'), 'utf8');
    writeFileSync(join(dir, 'CLAUDE.md'), text.replace('可以被 Agent 引用', '被改过'), 'utf8');
    expect(doctorPack(dir).ok).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });
});
