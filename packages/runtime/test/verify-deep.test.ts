import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installPack, loadPack, planFor, verifyPack } from '../src/index.ts';

const hash = (s: string): string => `sha256-${createHash('sha256').update(s).digest('base64')}`;

const MANIFEST = (integrity: string): string => `apiVersion: packhub.dev/v0
kind: Pack
metadata: { name: demo/deep, version: 0.0.1, targets: [dir] }
requires: { packhub: ">=0.0.1 <0.1" }
resources:
  - id: rules
    type: knowledge
    source: ./rules.md
    integrity: ${integrity}
  - id: fake-mcp
    type: mcp
    source: ./mcp.mjs
    transport: stdio
    config:
      command: node
      args: ["mcp.mjs"]
verify:
  - type: knowledge-integrity
    resource: rules
  - type: command
    run: ["node", "-e", "process.exit(0)"]
  - type: mcp-ready
    resource: fake-mcp
    timeout: 15
`;

function pack(): string {
  const dir = mkdtempSync(join(tmpdir(), 'packhub-deep-'));
  const content = '# rules\n';
  writeFileSync(join(dir, 'packhub.yaml'), MANIFEST(hash(content)), 'utf8');
  writeFileSync(join(dir, 'rules.md'), content, 'utf8');
  writeFileSync(
    join(dir, 'mcp.mjs'),
    `let buf = '';
process.stdin.on('data', (d) => {
  buf += d;
  if (!buf.includes('\\n')) return;
  const msg = JSON.parse(buf.split('\\n')[0]);
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2024-11-05' } }) + '\\n');
  process.exit(0);
});
`,
    'utf8',
  );
  return dir;
}

describe('深校验', () => {
  it('command / knowledge-integrity / mcp-ready 都能真的判定', async () => {
    const dir = pack();
    const ctx = loadPack(dir);
    const { plan } = planFor(ctx);
    await installPack(ctx, plan!);

    const results = verifyPack(dir, plan!);
    expect(results.map((r) => [r.type, r.status])).toEqual([
      ['knowledge-integrity', 'pass'],
      ['command', 'pass'],
      ['mcp-ready', 'pass'],
    ]);
    rmSync(dir, { recursive: true, force: true });
  });

  it('文件被改过时 knowledge-integrity 失败；命令非零退出时 command 失败', async () => {
    const dir = pack();
    const ctx = loadPack(dir);
    const { plan } = planFor(ctx);
    await installPack(ctx, plan!);
    writeFileSync(join(dir, '.packhub/knowledge/rules.md'), '# tampered\n', 'utf8');

    const bad = { ...plan!, verify: [
      { type: 'knowledge-integrity' as const, resource: 'rules', integrity: hash('# rules\n') },
      { type: 'command' as const, run: ['node', '-e', 'process.exit(2)'] },
    ] };
    const results = verifyPack(dir, bad);
    expect(results.map((r) => r.status)).toEqual(['fail', 'fail']);
    rmSync(dir, { recursive: true, force: true });
  });
});
