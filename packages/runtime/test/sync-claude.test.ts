import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { doctorGlobal, removeSynced, syncPack } from '../src/index.ts';

const dirs: string[] = [];
function temp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

/** 一个假的 claude：只实现 --version / mcp get / add / remove，状态存在 JSON 里。 */
function fakeClaude(): string {
  const dir = temp('packhub-fake-claude-');
  const store = join(dir, 'store.json');
  writeFileSync(store, JSON.stringify({ servers: {} }), 'utf8');
  writeFileSync(
    join(dir, 'claude.js'),
    `import { existsSync, readFileSync, writeFileSync } from 'node:fs';
const store = process.env.PACKHUB_CLAUDE_FAKE_STORE;
const load = () => existsSync(store) ? JSON.parse(readFileSync(store, 'utf8')) : { servers: {} };
const save = (d) => writeFileSync(store, JSON.stringify(d));
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('fake-claude 1.0'); process.exit(0); }
const cmd = args[0] === 'mcp' ? args[1] : '';
if (cmd === 'get') {
  const d = load();
  if (d.servers[args[2]]) { console.log('found'); process.exit(0); }
  console.error('No MCP server found with name: ' + args[2]); process.exit(1);
}
if (cmd === 'remove') {
  const name = args[args.indexOf('--scope') >= 0 ? args.length - 1 : 2];
  const d = load();
  if (!d.servers[name]) { console.error('No MCP server found with name: ' + name); process.exit(1); }
  delete d.servers[name]; save(d); console.log('Removed'); process.exit(0);
}
if (cmd === 'add') {
  const rest = args.slice(args.indexOf('--') + 1);
  const sep = args.indexOf('--');
  const before = args.slice(0, sep);
  const name = before[before.length - 1];
  const envs = {};
  for (let i = 0; i < before.length; i++) if (before[i] === '-e') envs[before[i + 1].split('=')[0]] = before[i + 1].split('=')[1];
  const d = load();
  d.servers[name] = { command: rest[0], args: rest.slice(1), env: envs };
  save(d); console.log('Added'); process.exit(0);
}
console.error('unsupported: ' + args.join(' ')); process.exit(2);
`,
    'utf8',
  );
  let bin: string;
  if (process.platform === 'win32') {
    bin = join(dir, 'claude.cmd');
    writeFileSync(bin, `@echo off\r\nnode "%~dp0claude.js" %*\r\n`, 'utf8');
  } else {
    bin = join(dir, 'claude');
    writeFileSync(bin, `#!/bin/sh\nexec node "$(dirname "$0")/claude.js" "$@"\n`, 'utf8');
    chmodSync(bin, 0o755);
  }
  process.env.PACKHUB_CLAUDE_BIN = bin;
  process.env.PACKHUB_CLAUDE_FAKE_STORE = store;
  return store;
}

function pack(): string {
  const dir = temp('packhub-sync-claude-');
  mkdirSync(join(dir, 'skills/hello'), { recursive: true });
  writeFileSync(join(dir, 'skills/hello/SKILL.md'), '---\nname: hello\ndescription: hello\n---\n\n# Hello\n', 'utf8');
  writeFileSync(
    join(dir, 'packhub.yaml'),
    `apiVersion: packhub.dev/v0
kind: Pack
metadata: { name: demo/claude-mcp, version: 0.1.0, targets: [claude-code] }
requires: { packhub: ">=0.0.1 <0.1" }
resources:
  - id: hello
    type: skill
    source: ./skills/hello
  - id: search
    type: mcp
    source: npm:@scope/search@1.4.0
    transport: stdio
    config: { env: { TOKEN: "\${vars.token}" } }
vars: { token: abc }
`,
    'utf8',
  );
  return dir;
}

const saved: Record<string, string | undefined> = {
  PACKHUB_CLAUDE_HOME: process.env.PACKHUB_CLAUDE_HOME,
  PACKHUB_CLAUDE_BIN: process.env.PACKHUB_CLAUDE_BIN,
  PACKHUB_CLAUDE_FAKE_STORE: process.env.PACKHUB_CLAUDE_FAKE_STORE,
};
afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('Claude Code 全局 MCP adapter', () => {
  it('skill 走计划，mcp 走 claude CLI；state 记名，doctor/remove 都能接上', async () => {
    const store = fakeClaude();
    const home = temp('packhub-claude-home-');
    process.env.PACKHUB_CLAUDE_HOME = home;
    const src = pack();

    const res = await syncPack(src, { targets: ['claude-code'] });
    expect(existsSync(join(home, 'skills/hello/SKILL.md'))).toBe(true);
    const data = JSON.parse(readFileSync(store, 'utf8'));
    expect(data.servers.search.command).toBe('npx');
    expect(data.servers.search.args).toEqual(['-y', '@scope/search@1.4.0']);
    expect(data.servers.search.env).toEqual({ TOKEN: 'abc' });
    expect(res.results[0]!.mcp).toEqual([{ id: 'search', status: 'added' }]);

    const state = JSON.parse(readFileSync(join(home, '.packhub/state.json'), 'utf8'));
    expect(state.packs['demo/claude-mcp@0.1.0'].hostMcp).toEqual(['search']);
    expect(doctorGlobal(['claude-code'])[0]!.report?.ok).toBe(true);

    // 再同步一次：已在 user scope 里，记 kept 而不是重复 add
    const again = await syncPack(src, { targets: ['claude-code'] });
    expect(again.results[0]!.mcp).toEqual([{ id: 'search', status: 'kept' }]);

    // 用户在 Claude 里手工删掉：doctor 报出来
    writeFileSync(store, JSON.stringify({ servers: {} }), 'utf8');
    const drift = doctorGlobal(['claude-code'])[0]!.report!;
    expect(drift.ok).toBe(false);
    expect(drift.findings[0]!.mcpMissing).toContain('search');

    // 卸载时从 user scope 摘掉
    removeSynced(src, ['claude-code']);
    expect(JSON.parse(readFileSync(store, 'utf8')).servers).toEqual({});
    expect(existsSync(join(home, 'skills/hello'))).toBe(false);
  });

  it('dsh 仍然明确拒绝全局 MCP，不写半套', async () => {
    process.env.PACKHUB_DSH_HOME = temp('packhub-dsh-');
    const src = pack();
    await expect(syncPack(src, { targets: ['dsh'] })).rejects.toThrow(/没有可依赖的全局 MCP/);
  });
});
