// pal start / stop / restart / ps / health / logs：实例的运行态。
import { defineCommand } from 'citty';
import pkg from '../../package.json' with { type: 'json' };
import { requireInstance, writeInstance, type InstanceRecord } from '../index.ts';
import { activeEntries } from '../active.ts';
import { coreCall } from '../coreClient.ts';
import { refreshStatuses, logFileOf } from '../start.ts';
import { psReport } from '../ps.ts';
import { discoverAll } from '../harness.ts';
import { checkAll, checkInstance } from '../health.ts';
import { listLogs, readEvents, readLog, tailLog } from '../logs.ts';
import { palHomeInfo } from '../paths.ts';
import { PalError } from '../errors.ts';
import { requireTarget } from './shared.ts';

export const start = defineCommand({
  meta: {
    name: 'start',
    description:
      '起一个实例（交给 core：崩了由它按 --restart 看护）。不写目标时用「当前实例」：create/adopt 默认会把实例设为当前；多个宿主各有当前实例时要求显式指定',
  },
  args: {
    target: {
      type: 'positional',
      required: false,
      description: '实例 id 或名字；不写就用当前实例（create/adopt 默认已把它设为当前）',
    },
    port: { type: 'string', description: '指定端口；被占时报告占用者' },
    restart: { type: 'string', description: 'on-failure：崩了由 core 重起；never：不重起' },
    'no-open': { type: 'boolean', default: false, description: '起来后不用浏览器打开' },
    json: { type: 'boolean', default: false },
  },
  async run({ args }) {
    let id = args.target ? String(args.target) : undefined;
    if (!id) {
      const actives = activeEntries().filter((entry) => entry.record);
      if (actives.length === 0) {
        throw new PalError('invalid-input', '没有指定实例，也没有当前实例；先 pal use <id>');
      }
      if (actives.length > 1) {
        throw new PalError(
          'invalid-input',
          `当前有 ${actives.length} 个宿主的实例：${actives.map((e) => `${e.harness}=${e.record!.id}`).join(', ')}；指定一个`,
          { hint: 'pal start <实例>；或先用 pal use <实例> 把某个宿主的当前实例选出来。' },
        );
      }
      id = actives[0]!.record!.id;
    }
    const rec = requireInstance(id);
    if (args.restart) {
      const mode = String(args.restart);
      if (mode !== 'on-failure' && mode !== 'never') {
        throw new PalError('invalid-input', '--restart 只支持 on-failure / never');
      }
      rec.restart = mode;
      writeInstance(rec);
    }
    const record = await coreCall<InstanceRecord>('start', {
      id: rec.id,
      ...(args.port ? { port: Number(args.port) } : {}),
    });
    if (args.json) {
      console.log(JSON.stringify(record, null, 2));
      return;
    }
    console.log(`✓ ${record.id}  running  pid ${record.pid ?? '-'}`);
    console.log(`  ${record.url ?? ''}`);
    console.log(`  日志：${logFileOf(record)}`);
  },
});

export const stop = defineCommand({
  meta: { name: 'stop', description: '停掉一个在跑的实例（只杀本实例 spawn 的进程；可疑 pid 默认拒杀）' },
  args: {
    target: { type: 'positional', required: true, description: '实例 id 或名字' },
    force: {
      type: 'boolean',
      default: false,
      description: '跳过「监听者不是本实例」的拒杀；记录缺 spawnPid 时仍拒杀，也仍不会杀 listenPid',
    },
    json: { type: 'boolean', default: false },
  },
  async run({ args }) {
    const rec = await coreCall<InstanceRecord>('stop', {
      id: requireTarget(args.target),
      ...(args.force ? { force: true } : {}),
    });
    if (args.json) {
      console.log(JSON.stringify(rec, null, 2));
      return;
    }
    console.log(`✓ 已停止 ${rec.id}`);
  },
});

export const restart = defineCommand({
  meta: { name: 'restart', description: '重起一个实例' },
  args: {
    target: { type: 'positional', required: true, description: '实例 id 或名字' },
    json: { type: 'boolean', default: false },
  },
  async run({ args }) {
    const rec = await coreCall<InstanceRecord>('restart', { id: requireTarget(args.target) });
    if (args.json) {
      console.log(JSON.stringify(rec, null, 2));
      return;
    }
    console.log(`✓ ${rec.id}  running  pid ${rec.pid ?? '-'}`);
    console.log(`  ${rec.url ?? ''}`);
  },
});

export const ps = defineCommand({
  meta: {
    name: 'ps',
    description:
      '并发账本：在跑的实例、端口、运行时长、端口冲突与已死的 pid。默认纯读（不写记录、不杀进程）；--refresh 先按 pid 探测刷新记录（会写盘）',
  },
  args: {
    refresh: {
      type: 'boolean',
      default: false,
      description: '先 refreshStatuses() 按 pid 探测并写回实例状态，再出账本；不带时只读',
    },
    json: { type: 'boolean', default: false },
  },
  run({ args }) {
    // 默认纯读；只有显式 --refresh 才写盘（原 status 的行为）
    if (args.refresh) refreshStatuses();
    const report = psReport();
    if (args.json) {
      // 结构只约定三段：坏记录不混进来，只在人读模式下单列。
      console.log(
        JSON.stringify(
          { instances: report.instances, conflicts: report.conflicts, total: report.total },
          null,
          2,
        ),
      );
      return;
    }
    if (report.instances.length === 0) console.log('没有在跑的实例');
    for (const item of report.instances) {
      const state = item.stale ? 'stale' : 'running';
      console.log(
        `${state}\t${item.id}\t${item.name}\t${item.harness}\tpid ${item.pid ?? '-'}\tport ${item.port ?? '-'}\t${item.uptime}`,
      );
      if (item.startedAt) console.log(`  启动于 ${item.startedAt}`);
      if (item.url) console.log(`  ${item.url}`);
      if (item.stale) console.log(`  ! pid ${item.pid} 已经不在了（记录没改，pal ps --refresh 才会刷新）`);
    }
    for (const conflict of report.conflicts) {
      console.log(`! 端口冲突 ${conflict.port}：${conflict.names.join(', ')}（${conflict.ids.join(', ')}）`);
    }
    for (const bad of report.broken) console.log(`! 坏记录 ${bad.dir}\t${bad.reason}`);
    console.log(
      `共 ${report.total.running} 条在跑（账本 ${report.total.instances} 条），占 ${report.total.ports} 个端口` +
        `${report.total.stale ? `，${report.total.stale} 条 pid 已死` : ''}` +
        `${report.total.conflicts ? `，${report.total.conflicts} 处端口冲突` : ''}`,
    );
  },
});

function hostDiscovery(): {
  runtime: { node: string; platform: string; arch: string; pal: string; home: string };
  hosts: ReturnType<typeof discoverAll>;
} {
  return {
    // A11：分发自带 node，PAL 只能报告自己跑在哪个运行时上，不能切换
    runtime: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      pal: pkg.version,
      home: palHomeInfo().home,
    },
    hosts: discoverAll({ probeVersion: true }),
  };
}

export const health = defineCommand({
  meta: {
    name: 'health',
    description: '体检：默认查实例（进程、端口、home、基线漂移、MCP 接线）；--hosts 先打宿主发现（node 版本、宿主在不在/版本/能否启动）',
  },
  args: {
    target: { type: 'positional', required: false, description: '实例 id 或名字；不写就全查' },
    hosts: {
      type: 'boolean',
      default: false,
      description: '先打宿主发现（原 pal doctor）：node 版本、宿主在不在、什么版本、能不能起；之后的实例体检照旧',
    },
    json: { type: 'boolean', default: false },
  },
  async run({ args }) {
    const discovered = args.hosts ? hostDiscovery() : undefined;
    const reports = args.target ? [await checkInstance(String(args.target))] : await checkAll();
    if (args.json) {
      console.log(
        JSON.stringify(discovered ? { ...discovered, instances: reports } : reports, null, 2),
      );
      return;
    }
    if (discovered) {
      console.log('宿主：');
      const { runtime, hosts } = discovered;
      console.log(`  运行时：node ${runtime.node} (${runtime.platform}-${runtime.arch})，pal ${runtime.pal}`);
      console.log(`  数据目录：${runtime.home}`);
      for (const info of hosts) {
        const state = !info.available ? '未安装' : info.startable ? '可启动' : '只装配 home';
        console.log(`  ${info.id}\t${state}\t${info.version ?? info.probeError ?? '-'}`);
        if (info.commandPath) console.log(`    ${info.commandPath}`);
        if (info.reason) console.log(`    ${info.reason}`);
      }
      console.log('');
      console.log('实例：');
    }
    if (reports.length === 0) {
      console.log('没有实例');
      return;
    }
    for (const report of reports) {
      console.log(`${report.ok ? '✓' : 'x'} ${report.name}\t${report.status}`);
      for (const check of report.checks) console.log(`  [${check.status}] ${check.name}: ${check.detail}`);
      if (report.drift && (report.drift.missing.length || report.drift.changed.length)) {
        for (const file of report.drift.missing) console.log(`    - 缺：${file}`);
        for (const file of report.drift.changed) console.log(`    ~ 改过：${file}`);
      }
    }
  },
});

export const logs = defineCommand({
  meta: { name: 'logs', description: '看启动日志（轮转、脱敏、尾部）' },
  args: {
    target: { type: 'positional', required: true, description: '实例 id 或名字' },
    file: { type: 'string', description: '看某一份归档日志（start.<时间>.log）' },
    events: { type: 'boolean', default: false, description: '看事件流而不是启动输出' },
    lines: { type: 'string', description: '只看最后几行' },
    json: { type: 'boolean', default: false },
  },
  run({ args }) {
    const rec = requireInstance(requireTarget(args.target));
    if (args.events) {
      const events = readEvents(rec.root, 100);
      console.log(args.json ? JSON.stringify(events, null, 2) : events.map((e) => JSON.stringify(e)).join('\n'));
      return;
    }
    const log = readLog(rec.root, args.file ? { file: String(args.file) } : {});
    if (args.json) {
      console.log(JSON.stringify({ ...log, files: listLogs(rec.root) }, null, 2));
      return;
    }
    if (args.lines) {
      const n = Number(args.lines);
      console.log(tailLog(rec.root, Number.isFinite(n) ? n : 20));
      return;
    }
    console.log(log.text || '还没有启动输出');
    if (log.files.length > 1) console.log(`\n归档：${log.files.map((f) => f.name).join(', ')}`);
  },
});
