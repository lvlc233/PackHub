import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installPack, loadPack, planFor, removePack } from '../src/index.ts';

const MANIFEST = `apiVersion: packhub.dev/v0
kind: Pack
metadata:
  name: demo/projection
  version: 0.0.1
  title: 投影测试
  targets: [dir, claude-code, dsh]
requires:
  packhub: ">=0.0.1 <0.1"
resources:
  - id: rules
    type: skill
    source: ./skills/rules
  - id: search
    type: mcp
    source: npm:@scope/mcp-server@0.6.2
    transport: stdio
verify:
  - type: file-exists
    path: "\${target.skillsDir}/rules/SKILL.md"
`;

function pack(): string {
  const dir = mkdtempSync(join(tmpdir(), 'packhub-proj-'));
  mkdirSync(join(dir, 'skills/rules'), { recursive: true });
  writeFileSync(join(dir, 'packhub.yaml'), MANIFEST, 'utf8');
  writeFileSync(join(dir, 'skills/rules/SKILL.md'), '# rules\n', 'utf8');
  return dir;
}

describe('投影到宿主', () => {
  it('claude-code：skill 落 .claude/skills，MCP 落 .mcp.json，指令落 CLAUDE.md', () => {
    const dir = pack();
    const { plan } = planFor(loadPack(dir), { target: 'claude-code' });
    expect(plan).toBeDefined();
    const targets = plan!.actions.map((a) => ('to' in a ? a.to : 'path' in a ? a.path : ''));
    expect(targets.some((t) => (t ?? '').startsWith('.claude/skills'))).toBe(true);
    const reg = plan!.actions.find((a) => a.op === 'register.mcp');
    expect(reg && 'path' in reg ? reg.path : '').toBe('.mcp.json');
    const inst = plan!.actions.find((a) => a.op === 'instruction');
    expect(inst && 'file' in inst ? inst.file : '').toBe('CLAUDE.md');
    rmSync(dir, { recursive: true, force: true });
  });

  it('dsh：指令落 AGENTS.md，MCP 仍在 .packhub（项目级未验证）', () => {
    const dir = pack();
    const { plan } = planFor(loadPack(dir), { target: 'dsh' });
    const inst = plan!.actions.find((a) => a.op === 'instruction');
    expect(inst && 'file' in inst ? inst.file : '').toBe('AGENTS.md');
    rmSync(dir, { recursive: true, force: true });
  });

  it('重复安装不会产生第二个托管块，第二次全是 noop', async () => {
    const dir = pack();
    const ctx = loadPack(dir);
    const { plan } = planFor(ctx, { target: 'claude-code' });
    await installPack(ctx, plan!);
    const once = readFileSync(join(dir, 'CLAUDE.md'), 'utf8');
    const second = await installPack(ctx, plan!);
    const twice = readFileSync(join(dir, 'CLAUDE.md'), 'utf8');
    expect(twice).toBe(once);
    expect(once.match(/packhub:begin/g)).toHaveLength(1);
    expect(second.outcomes.every((o) => o.status === 'noop' || o.status === 'done')).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  it('卸载只摘掉自己的块，保留用户写在块外的话', async () => {
    const dir = pack();
    writeFileSync(join(dir, 'CLAUDE.md'), '# 我的项目\n\n用户自己的说明。\n', 'utf8');
    const ctx = loadPack(dir);
    const { plan } = planFor(ctx, { target: 'claude-code' });
    await installPack(ctx, plan!);
    expect(readFileSync(join(dir, 'CLAUDE.md'), 'utf8')).toContain('我的项目');

    removePack(dir);
    const after = readFileSync(join(dir, 'CLAUDE.md'), 'utf8');
    expect(after).toContain('我的项目');
    expect(after).not.toContain('packhub:begin');
    expect(existsSync(join(dir, '.claude/skills/rules/SKILL.md'))).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });
});
