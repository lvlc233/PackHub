// 由 cli.ts 拆分：update——把已装的包升级到 registry 上的新版本。
// （原 add 已并入 install.ts；sync 已删除，全局落点归 PAL 实例。）
import { resolve } from 'node:path';
import { EXIT, command, json, problemRaw, sayUnless, stop, warn } from '../emit.ts';
import { parsePackRef } from '../ref.ts';
import { PACKHUB_ENV } from '@packhub/kernel';
import {
  updatePack,
  verifyInstalled,
  resolveRegistry,
  appendAudit,
} from '@packhub/runtime';
import { parseHarness, SAFE_CHECKS } from './shared.ts';

export const update = command({
  meta: { name: 'update', description: '把已装的包升级到 registry 上的新版本' },
  args: {
    name: { type: 'positional', required: true },
    index: { type: 'string', description: '索引路径、URL 或本机配置里的 registry 名（默认取默认 registry）' },
    dir: { type: 'string', default: '.' },
    version: { type: 'string' },
    harness: { type: 'string', description: '默认沿用上次安装的宿主（平铺目录则沿用平铺）' },
    overwrite: { type: 'boolean', default: false },
    'allow-stale-lock': { type: 'boolean', default: false },
    'no-verify': { type: 'boolean', default: false, description: '更新后不跑 verify 检查' },
    'deep-verify': { type: 'boolean', default: false, description: '更新后也跑 command / mcp-ready（会执行包里的命令）' },
    json: { type: 'boolean', default: false, description: '输出结构化结果（脚本用）' },
  },
  async run({ args }) {
    const indexRef = resolveRegistry(args.index ? String(args.index) : undefined);
    if (!indexRef) {
      problemRaw(`没有索引：加 --index <路径|URL|registry 名>，或设 ${PACKHUB_ENV.index}`);
      stop(EXIT.USAGE);
    }
    const say = sayUnless(args.json);
    const harness = parseHarness(args.harness === undefined ? undefined : String(args.harness));
    const res = await updatePack({
      name: String(args.name),
      index: indexRef,
      projectDir: resolve(String(args.dir)),
      // 不传就沿用上次安装的宿主（旧快照没有 harness 时按平铺目录）
      ...(harness ? { harness } : {}),
      overwrite: Boolean(args.overwrite),
      allowStaleLock: Boolean(args['allow-stale-lock']),
      ...(args.version ? { version: String(args.version) } : {}),
    });
    if (!res.changed) {
      if (args.json) json(res);
      else say(`${res.name} 已是最新（planHash ${res.planHash.slice(0, 22)}…）`);
      return;
    }
    say(`更新 ${res.from ?? '(未装)'} → ${res.to}`);
    for (const a of res.removed) say(`  - ${a}（计划里移除）`);
    for (const a of res.added) say(`  + ${a}`);
    for (const p of res.pruned) say(`  × ${p}（已从磁盘清掉）`);
    for (const w of res.warnings) warn(w);
    say(`\nplanHash ${res.planHash.slice(0, 22)}…（可用 packhub rollback 退回）`);
    try {
      appendAudit({
        action: 'update',
        pack: res.name,
        version: parsePackRef(res.to)?.version ?? res.to,
        planHash: res.planHash,
        ok: true,
        root: resolve(String(args.dir)),
      });
    } catch (err) {
      warn(`审计写入失败：${(err as Error).message}`);
    }

    let reports: Awaited<ReturnType<typeof verifyInstalled>> | undefined;
    if (res.changed && !args['no-verify']) {
      reports = await verifyInstalled(resolve(String(args.dir)), {
        pack: res.to,
        ...(args['deep-verify'] ? {} : { types: [...SAFE_CHECKS] }),
      });
      for (const r of reports) {
        say(`\n校验 ${r.pack}：${r.ok ? '通过' : '未通过'}`);
        for (const c of r.results) {
          const mark = c.status === 'pass' ? '✓' : c.status === 'fail' ? 'x' : '-';
          say(`  ${mark} [${c.index}] ${c.type.padEnd(18)} ${c.status.padEnd(8)} ${c.detail}`);
        }
      }
      if (!reports.every((r) => r.ok)) {
        if (args.json) json({ ...res, verify: reports });
        problemRaw('更新完成，但有校验没过；可用 rollback 退回上一版。');
        stop(EXIT.RUNTIME);
      }
    }
    if (args.json) json({ ...res, ...(reports ? { verify: reports } : {}) });
  },
});
