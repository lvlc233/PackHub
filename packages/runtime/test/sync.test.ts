import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { doctorGlobal, removeSynced, syncPack } from '../src/index.ts';

const dirs: string[] = [];
function temp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

function pack(skillBody = '---\nname: hello\ndescription: A hello skill.\n---\n\n# Hello\n'): string {
  const dir = temp('packhub-sync-pack-');
  mkdirSync(join(dir, 'skills/hello'), { recursive: true });
  writeFileSync(join(dir, 'skills/hello/SKILL.md'), skillBody, 'utf8');
  writeFileSync(
    join(dir, 'packhub.yaml'),
    `apiVersion: packhub.dev/v0
kind: Pack
metadata:
  name: demo/sync
  version: 0.1.0
  targets: [dsh, codex]
requires:
  packhub: ">=0.0.1 <0.1"
resources:
  - id: hello
    type: skill
    source: ./skills/hello
`,
    'utf8',
  );
  return dir;
}

function homes(): { dsh: string; codex: string } {
  const dsh = temp('packhub-dsh-');
  const codex = temp('packhub-codex-');
  process.env.PACKHUB_DSH_HOME = dsh;
  process.env.PACKHUB_CODEX_HOME = codex;
  return { dsh, codex };
}

afterEach(() => {
  delete process.env.PACKHUB_DSH_HOME;
  delete process.env.PACKHUB_CODEX_HOME;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('全局 harness 同步', () => {
  it('把 skill 同步到 dsh 与 codex，state 各记一份', async () => {
    const { dsh, codex } = homes();
    const src = pack();
    const res = await syncPack(src, { targets: ['dsh', 'codex'] });
    expect(res.pack).toBe('demo/sync@0.1.0');
    expect(existsSync(join(dsh, 'skills/hello/SKILL.md'))).toBe(true);
    expect(existsSync(join(codex, 'skills/hello/SKILL.md'))).toBe(true);
    expect(existsSync(join(dsh, '.packhub/state.json'))).toBe(true);
    expect(existsSync(join(codex, '.packhub/state.json'))).toBe(true);
    expect(doctorGlobal(['dsh', 'codex']).every((r) => r.report?.ok)).toBe(true);
    // 指令面写进各自 home 的 AGENTS.md 托管块
    for (const home of [dsh, codex]) {
      const agents = readFileSync(join(home, 'AGENTS.md'), 'utf8');
      expect(agents).toContain('<!-- packhub:begin demo/sync -->');
      expect(agents).toContain('hello');
    }
    // codex 的选择器要求 agents/openai.yaml：源里没有就生成一份
    const yaml = readFileSync(join(codex, 'skills/hello/agents/openai.yaml'), 'utf8');
    expect(yaml).toContain('interface:');
    expect(yaml).toContain('display_name: "Hello"');
    expect(yaml).toContain('$hello');
    // dsh 不需要这个文件，不乱写
    expect(existsSync(join(dsh, 'skills/hello/agents/openai.yaml'))).toBe(false);
  });

  it('SKILL.md 带 BOM 也能读', async () => {
    const { dsh } = homes();
    const src = pack('\uFEFF---\nname: hello\ndescription: BOM skill.\n---\n\n# Hello\n');
    await syncPack(src, { targets: ['dsh'] });
    expect(existsSync(join(dsh, 'skills/hello/SKILL.md'))).toBe(true);
  });

  it('dry-run 不写盘', async () => {
    const { dsh, codex } = homes();
    const src = pack();
    const res = await syncPack(src, { targets: ['dsh', 'codex'], dryRun: true });
    expect(res.results.map((r) => r.target)).toEqual(['dsh', 'codex']);
    expect(res.results.every((r) => r.planHash?.startsWith('sha256-'))).toBe(true);
    expect(existsSync(join(dsh, 'skills'))).toBe(false);
    expect(existsSync(join(codex, 'skills'))).toBe(false);
  });

  it('移除后两个 harness 都不留文件', async () => {
    const { dsh, codex } = homes();
    const src = pack();
    await syncPack(src, { targets: ['dsh', 'codex'] });
    const removed = removeSynced(src, ['dsh', 'codex']);
    expect(removed.every((r) => r.packs.length === 1)).toBe(true);
    expect(existsSync(join(dsh, 'skills/hello'))).toBe(false);
    expect(existsSync(join(codex, 'skills/hello'))).toBe(false);
    // 托管块也只摘自己这一段；块外没内容时文件被删掉
    expect(existsSync(join(dsh, 'AGENTS.md'))).toBe(false);
    expect(existsSync(join(codex, 'AGENTS.md'))).toBe(false);
  });

  it('frontmatter 不合法时拒绝，不写盘', async () => {
    const { dsh } = homes();
    const src = pack('---\nname: hello\ndescription: Bad: value\n---\n\n# Hello\n');
    await expect(syncPack(src, { targets: ['dsh'] })).rejects.toThrow(/frontmatter/);
    expect(existsSync(join(dsh, 'skills'))).toBe(false);
  });

  it('拒绝非 skill 资源', async () => {
    const { dsh } = homes();
    const src = pack();
    writeFileSync(
      join(src, 'packhub.yaml'),
      readFileSync(join(src, 'packhub.yaml'), 'utf8').replace(
        '  - id: hello\n    type: skill',
        '  - id: notes\n    type: knowledge\n    source: ./notes.md\n  - id: hello\n    type: skill',
      ),
      'utf8',
    );
    writeFileSync(join(src, 'notes.md'), '# notes\n', 'utf8');
    await expect(syncPack(src, { targets: ['dsh'] })).rejects.toThrow(/只支持 skill/);
    expect(existsSync(join(dsh, 'skills'))).toBe(false);
  });

  it('不覆盖手放的同名 skill', async () => {
    const { dsh } = homes();
    const src = pack();
    mkdirSync(join(dsh, 'skills/hello'), { recursive: true });
    writeFileSync(join(dsh, 'skills/hello/SKILL.md'), 'hand-written', 'utf8');
    await expect(syncPack(src, { targets: ['dsh'] })).rejects.toThrow(/已存在/);
    expect(readFileSync(join(dsh, 'skills/hello/SKILL.md'), 'utf8')).toBe('hand-written');
  });

  it('一个目标不存在时，另一个也不写', async () => {
    const dsh = temp('packhub-dsh-');
    process.env.PACKHUB_DSH_HOME = dsh;
    process.env.PACKHUB_CODEX_HOME = join(tmpdir(), 'packhub-missing-codex');
    const src = pack();
    await expect(syncPack(src, { targets: ['dsh', 'codex'] })).rejects.toThrow(/home 不存在/);
    expect(existsSync(join(dsh, 'skills'))).toBe(false);
  });

  it('codex 的全局 MCP 写进 config.toml 托管块，移除时摘掉', async () => {
    const { codex } = homes();
    const src = temp('packhub-sync-mcp-');
    writeFileSync(
      join(src, 'packhub.yaml'),
      `apiVersion: packhub.dev/v0
kind: Pack
metadata: { name: demo/mcp, version: 0.1.0, targets: [codex] }
requires: { packhub: ">=0.0.1 <0.1" }
resources:
  - id: search
    type: mcp
    source: npm:@scope/search@1.4.0
    transport: stdio
    config: { args: ["-y", "@scope/search@1.4.0"] }
`,
      'utf8',
    );
    await syncPack(src, { targets: ['codex'] });
    const toml = readFileSync(join(codex, 'config.toml'), 'utf8');
    expect(toml).toContain('[mcp_servers.search]');
    expect(toml).toContain('npx');
    expect(toml).toContain('# packhub:end mcp search');

    // dsh 没有可依赖的全局 MCP 配置契约：明确拒绝，不写半套
    process.env.PACKHUB_DSH_HOME = temp('packhub-dsh-');
    await expect(syncPack(src, { targets: ['dsh'] })).rejects.toThrow(/没有可依赖的全局 MCP/);

    removeSynced(src, ['codex']);
    const after = existsSync(join(codex, 'config.toml')) ? readFileSync(join(codex, 'config.toml'), 'utf8') : '';
    expect(after).not.toContain('[mcp_servers.search]');
  });

  it('harness home 不存在时明确报错', async () => {
    process.env.PACKHUB_DSH_HOME = join(tmpdir(), 'packhub-missing-dsh');
    const src = pack();
    await expect(syncPack(src, { targets: ['dsh'] })).rejects.toThrow(/home 不存在/);
  });
});
