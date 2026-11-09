import { defineCommand } from 'citty';
import pkg from '../package.json' with { type: 'json' };
import { createInterface } from 'node:readline/promises';
import { spawn } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  adoptInstance,
  cloneInstance,
  exportTemplate,
  listInstances,
  migrateInstance,
  readInstance,
  rebaselineInstance,
  removeInstance,
  renameInstance,
  requireInstance,
  scanInstances,
  writeInstance,
  writeTemplate,
  type InstanceRecord,
} from './index.ts';
import { createFromRef, importFromFile, updateFromRef } from './service.ts';
import { cacheStats, cleanCache, formatBytes, planClean, scanCache } from './cache.ts';
import { DEFAULT_SCAN_DEPTH, scanDirectory, type ScanEntry } from './scan.ts';
import { backupInstance, restoreBackup } from './backup.ts';
import { refreshStatuses, restartInstance, startInstance, startInstanceDetailed, stopInstance } from './start.ts';
import { DEFAULT_WATCH_INTERVAL_MS, watchLoop } from './watch.ts';
import { psReport } from './ps.ts';
import { activeEntries, setActive } from './active.ts';
import { startPalServer } from './server.ts';
import { discoverAll } from './harness.ts';
import { checkAll, checkInstance } from './health.ts';
import { listLogs, readEvents, readLog, tailLog } from './logs.ts';
import { readSecrets } from './secrets.ts';
import { PalError } from './errors.ts';
import { CONFIG_VERSION, parseIsolationSpec, readPalConfig, writePalConfig } from './config.ts';
import { ISOLATION_LAYERS } from './isolation.ts';
import { quarantineRoot, archiveRoot, failedRoot, instancesRoot, palConfigFile } from './paths.ts';
import { assertExternalRoot } from './validators.ts';

function printRecord(rec: InstanceRecord): void {
  console.log(`${rec.id}\t${rec.status}\t${rec.harness}\t${rec.pack.name}@${rec.pack.version}`);
  console.log(`  ${rec.root}`);
  if (rec.url) console.log(`  ${rec.url}`);
}

/** scan 的一行：kind、path，然后是身份（name/version/harness/packs）或问题。 */
function scanLine(entry: ScanEntry): string {
  const head = `${entry.kind}\t${entry.dir}`;
  if (entry.broken) return `${head}\tbroken\t${entry.problem ?? '记录读不了'}`;
  if (entry.kind === 'environment') {
    const line = `${head}\t${entry.packs ?? 0} 个 pack`;
    return entry.problem ? `${line}\t! ${entry.problem}` : line;
  }
  const parts = [head];
  parts.push(entry.name ? (entry.version ? `${entry.name}@${entry.version}` : entry.name) : '-');
  if (entry.harness) parts.push(`harness=${entry.harness}`);
  if (entry.pack) parts.push(`pack=${entry.pack.name}@${entry.pack.version || '?'}`);
  if (entry.problem) parts.push(`! ${entry.problem}`);
  return parts.join('\t');
}

function requireTarget(value: unknown): string {
  const text = String(value ?? '').trim();
  if (!text) throw new PalError('invalid-input', '要指定实例 id 或名字');
  return text;
}

async function confirm(question: string, yes: boolean): Promise<boolean> {
  if (yes) return true;
  if (!process.stdin.isTTY) {
    throw new PalError('invalid-input', `${question}（非交互环境请加 --yes）`);
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(`${question} [y/N] `);
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

const create = defineCommand({
  meta: { name: 'create', description: '从 Pack 建一份实例' },
  args: {
    pack: {
      type: 'positional',
      required: true,
      description: 'Pack 目录、.phub、git+https，或配合 --index 用 registry 名',
    },
    name: { type: 'string', required: true, description: '实例名；同名拒绝' },
    harness: { type: 'string', default: 'dir', description: 'dir | dsh | claude-code | codex' },
    index: { type: 'string', description: 'registry 索引（路径或 URL；也可用 PACKHUB_INDEX）' },
    'from-home': {
      type: 'string',
      description: '沿用已有宿主 home 的模型凭据与指令（例如 ~/.dsh）；Pack 写好的文件不会被覆盖',
    },
    version: { type: 'string', description: 'registry 包的版本，默认 latest' },
    root: {
      type: 'string',
      description:
        '实例根：必须是绝对路径，不能是盘符根/文件系统根，也不能落在 PAL 的实例根里（默认根由系统分配）；相对路径直接拒绝，PAL 不解析 cwd',
    },
    isolation: {
      type: 'string',
      description:
        '这份实例的隔离策略 layer=mode,...（只覆盖给出的层，其余沿用 pal config 的默认）；不写就用默认',
    },
    json: { type: 'boolean', default: false },
  },
  async run({ args }) {
    const log = (line: string): void => {
      if (!args.json) console.error(line);
    };
    // 先把 --root 定下来：写错了不必去取包，也不会留下半份实例
    const root = args.root === undefined ? undefined : assertExternalRoot(String(args.root));
    // 先把 --isolation 定下来（以当前配置为底座，只改写出来的层）：写错就不用去取包了
    const isolation =
      args.isolation === undefined
        ? undefined
        : parseIsolationSpec(String(args.isolation), readPalConfig().isolation);
    const harness = String(args.harness ?? 'dir');
    // 版本信息只用于记录与下面的启动提示：先把宿主探测出来，再交给 service 一起建
    const info = discoverAll({ probeVersion: false }).find((h) => h.id === harness);
    const rec = await createFromRef({
      packRef: String(args.pack),
      ...(args.index ? { index: String(args.index) } : {}),
      ...(args.version ? { version: String(args.version) } : {}),
      name: String(args.name),
      harness: harness as InstanceRecord['harness'],
      ...(root ? { root } : {}),
      ...(args['from-home'] ? { seedFrom: String(args['from-home']) } : {}),
      ...(info?.version ? { harnessVersion: info.version } : {}),
      ...(isolation ? { isolation } : {}),
      // 取包进度与单个凭据文件没带过来都写 stderr；建实例不因此失败；--json 时 log 不输出
      log,
    });
    if (args.json) {
      console.log(JSON.stringify(rec, null, 2));
      return;
    }
    console.log(`✓ ${rec.id}`);
    printRecord(rec);
    if (!info?.startable) {
      console.log(`  这个宿主没有常驻服务：${info?.reason ?? '只能装配 home'}`);
    }
    if (rec.home && !args['from-home']) {
      console.log(
        `  新 home 里没有模型凭据：要沿用全局环境用 pal create --from-home <${
          rec.harness === 'dsh' ? '~/.dsh' : `~/.${rec.harness}`
        }>，或用 pal adopt 接管已有目录。`,
      );
    }
  },
});

const config = defineCommand({
  meta: {
    name: 'config',
    description:
      '新实例的默认隔离策略（<PACKHUB_HOME>/config.json）；只影响之后新建的实例，已有实例不变',
  },
  args: {
    'set-isolation': {
      type: 'string',
      description: '改成 layer=mode,...；只覆盖写出来的层，其余沿用当前值。只影响之后新建的实例',
    },
    json: { type: 'boolean', default: false },
  },
  run({ args }) {
    const file = palConfigFile();
    const spec = args['set-isolation'];
    const current = readPalConfig();
    const next =
      spec === undefined
        ? current
        : writePalConfig({
            version: CONFIG_VERSION,
            isolation: parseIsolationSpec(String(spec), current.isolation),
          });
    if (args.json) {
      console.log(JSON.stringify(next, null, 2));
      return;
    }
    if (spec !== undefined) console.log(`✓ 已写入 ${file}`);
    console.log(`${file}${existsSync(file) ? '' : '（还没有这个文件：现在用的是内置默认）'}`);
    for (const layer of ISOLATION_LAYERS) {
      console.log(`  ${layer.padEnd(12)}${next.isolation.layers[layer]}`);
    }
    console.log('· 这是新实例的默认策略：已有实例的隔离策略不变。');
  },
});

const list = defineCommand({
  meta: { name: 'list', description: '列出实例' },
  args: { json: { type: 'boolean', default: false } },
  run({ args }) {
    const rows = listInstances();
    const scan = scanInstances();
    if (args.json) {
      console.log(JSON.stringify({ instances: rows, broken: scan.broken }, null, 2));
      return;
    }
    if (rows.length === 0) console.log('没有实例');
    for (const rec of rows) printRecord(rec);
    for (const bad of scan.broken) console.log(`! ${bad.dir}\t${bad.reason}`);
  },
});

const cache = defineCommand({
  meta: {
    name: 'cache',
    description: '看取包缓存（ls，默认）或清缓存（clean --all|--ref|--older-than）',
  },
  args: {
    action: {
      type: 'positional',
      required: false,
      default: 'ls',
      description: 'ls（默认）| clean',
    },
    all: { type: 'boolean', default: false, description: 'clean：清掉全部缓存条目' },
    ref: { type: 'string', description: 'clean：只清这个 Pack 引用（按 meta.ref 或目录 slug 匹配）' },
    'older-than': {
      type: 'string',
      description: 'clean：只清目录 mtime 早于 N 天的条目',
    },
    yes: { type: 'boolean', default: false, description: 'clean：跳过确认' },
    json: { type: 'boolean', default: false },
  },
  async run({ args }) {
    const action = String(args.action ?? 'ls');
    if (action === 'ls') {
      const scan = scanCache();
      const stats = cacheStats(scan.entries);
      if (args.json) {
        console.log(
          JSON.stringify(
            {
              root: scan.root,
              count: stats.count,
              totalBytes: stats.totalBytes,
              entries: scan.entries,
              problems: scan.problems,
            },
            null,
            2,
          ),
        );
        return;
      }
      if (scan.entries.length === 0) console.log('缓存是空的');
      for (const entry of scan.entries) {
        const ref = entry.ref ?? `${entry.slug}/${entry.variant}`;
        const version = entry.version ?? '-';
        const fetched = entry.fetchedAt ? `${entry.fetchedAt.replace('T', ' ').slice(0, 19)}` : '（无 meta）';
        console.log(`${ref}\t${version}\t${formatBytes(entry.bytes)}\t${fetched}`);
        console.log(`  ${entry.dir}`);
        for (const problem of entry.problems) console.log(`  ! ${problem}`);
      }
      for (const problem of scan.problems) console.log(`! ${problem.dir}\t${problem.reason}`);
      console.log(`共 ${stats.count} 条，${formatBytes(stats.totalBytes)}`);
      return;
    }
    if (action !== 'clean') {
      throw new PalError('invalid-input', `cache 只有 ls 与 clean 两种动作：${action}`, {
        hint: 'pal cache [ls] | pal cache clean --all | --ref <引用> | --older-than <天数>',
      });
    }

    const opts = {
      ...(args.all ? { all: true } : {}),
      ...(args.ref !== undefined ? { ref: String(args.ref) } : {}),
      ...(args['older-than'] !== undefined ? { olderThanDays: Number(args['older-than']) } : {}),
    };
    // 先按选择器算出命中项：没给选择器在这里就报 invalid-input，也拿来做确认文案。
    const picked = planClean(opts);
    const pickedBytes = picked.reduce((sum, entry) => sum + entry.bytes, 0);
    // 没命中就不必让非交互调用方再补 --yes。
    const ok =
      picked.length === 0
        ? true
        : await confirm(`清掉 ${picked.length} 条取包缓存（${formatBytes(pickedBytes)}）？`, Boolean(args.yes));
    if (!ok) {
      console.log('已取消');
      return;
    }
    const result = cleanCache(opts);
    if (args.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    for (const dir of result.removed) console.log(`- ${dir}`);
    for (const error of result.errors) console.log(`! ${error}`);
    console.log(`已清 ${result.removed.length} 条，保留 ${result.kept} 条`);
  },
});

const show = defineCommand({
  meta: { name: 'show', description: '看一份实例' },
  args: {
    target: { type: 'positional', required: true, description: '实例 id 或名字' },
    json: { type: 'boolean', default: false, description: '只输出记录 JSON（show 默认已是 JSON）' },
  },
  run({ args }) {
    const rec = requireInstance(requireTarget(args.target));
    // show 一直只输出记录 JSON；--json 只是给脚本一个显式开关，两种写法输出一致。
    console.log(JSON.stringify(rec, null, 2));
  },
});

const remove = defineCommand({
  meta: { name: 'remove', description: '删一份实例（先停进程；默认直接删根，--keep-data 先卸包再归档）' },
  args: {
    target: { type: 'positional', required: true, description: '实例 id 或名字' },
    'keep-data': {
      type: 'boolean',
      default: false,
      description: '先按 state 卸包，再把实例根（home / 会话 / 凭据）挪进归档区',
    },
    yes: { type: 'boolean', default: false, description: '跳过确认' },
    json: { type: 'boolean', default: false },
  },
  async run({ args }) {
    const rec = requireInstance(requireTarget(args.target));
    const keep = Boolean(args['keep-data']);
    const what = rec.managed
      ? keep
        ? '先按 state 卸掉 Pack 装进去的文件，再把实例根（home / 会话 / 凭据）挪进归档区'
        : '直接删掉整个实例根（Pack 装进去的文件随根一起消失）'
      : '只摘掉记录，接管来的目录不动';
    const ok = await confirm(`删除 ${rec.name}：${what}？`, Boolean(args.yes));
    if (!ok) {
      console.log('已取消');
      return;
    }
    const result = await removeInstance(rec.id, { keepData: keep });
    if (args.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    if (result.stopped) console.log(`· 先停掉了 pid ${result.stopped}`);
    // 接管来的实例不按 state 卸包，只有摘记录，没有 Pack 可报告。
    if (!rec.managed) {
      console.log('✓ 已摘掉记录（接管目录未动）');
      return;
    }
    const packs = result.uninstalled.join(', ') || '（没有 Pack 记录）';
    if (keep) {
      console.log(`· 已卸包：${packs}`);
      console.log(
        result.archivedTo
          ? `✓ 已归档到 ${result.archivedTo}`
          : `✓ 已从列表移除：${rec.id}（归档去向未知）`,
      );
      return;
    }
    // 默认路径不逐个卸包：Pack 文件随根删除，或随根一起进归档目录。
    console.log(`· ${result.removed ? '随根删除的 Pack 记录' : '随根归档的 Pack 记录'}：${packs}`);
    if (result.removed) console.log(`✓ 已删除 ${rec.id}`);
    else if (result.archivedTo) console.log(`✓ 根删不掉，已改名归档到 ${result.archivedTo}`);
    else console.log(`✓ 已从列表移除：${rec.id}（根未确认删掉）`);
  },
});

const start = defineCommand({
  meta: { name: 'start', description: '起一个实例（现在能起 dsh web，端口自动分配）' },
  args: {
    target: { type: 'positional', required: false, description: '实例 id 或名字；不写就用当前实例' },
    port: { type: 'string', description: '指定端口；被占时报告占用者' },
    restart: { type: 'string', description: 'on-failure：崩了就让 PAL 重起（serve 时看护）' },
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
    const detail = await startInstanceDetailed(rec.id, {
      ...(args.port ? { port: Number(args.port) } : {}),
    });
    const record = detail.record;
    if (args.json) {
      console.log(JSON.stringify(record, null, 2));
      return;
    }
    console.log(`✓ ${record.id}  running  pid ${record.pid ?? '-'}`);
    console.log(`  ${record.url ?? ''}`);
    console.log(`  日志：${detail.logFile}`);
  },
});

const stop = defineCommand({
  meta: { name: 'stop', description: '停掉一个在跑的实例（只杀本实例 spawn 的进程；可疑 pid 默认拒杀）' },
  args: {
    target: { type: 'positional', required: true, description: '实例 id 或名字' },
    force: {
      type: 'boolean',
      default: false,
      description: '跳过「可疑 pid」拒杀检查；仍不会杀端口反查到的 listenPid',
    },
    json: { type: 'boolean', default: false },
  },
  async run({ args }) {
    const rec = await stopInstance(requireTarget(args.target), {
      ...(args.force ? { force: true } : {}),
    });
    if (args.json) {
      console.log(JSON.stringify(rec, null, 2));
      return;
    }
    console.log(`✓ 已停止 ${rec.id}`);
  },
});

const restart = defineCommand({
  meta: { name: 'restart', description: '重起一个实例' },
  args: {
    target: { type: 'positional', required: true, description: '实例 id 或名字' },
    json: { type: 'boolean', default: false },
  },
  async run({ args }) {
    const rec = await restartInstance(requireTarget(args.target));
    if (args.json) {
      console.log(JSON.stringify(rec, null, 2));
      return;
    }
    console.log(`✓ ${rec.id}  running  pid ${rec.pid ?? '-'}`);
    console.log(`  ${rec.url ?? ''}`);
  },
});

const status = defineCommand({
  meta: { name: 'status', description: '看哪些实例在跑' },
  args: { json: { type: 'boolean', default: false } },
  run({ args }) {
    const rows = refreshStatuses();
    if (args.json) {
      console.log(JSON.stringify(rows, null, 2));
      return;
    }
    if (rows.length === 0) {
      console.log('没有实例');
      return;
    }
    for (const rec of rows) {
      const where = rec.url ?? (rec.pid ? `pid ${rec.pid}` : '-');
      console.log(`${rec.id}\t${rec.status}\t${rec.harness}\t${where}`);
    }
  },
});

const ps = defineCommand({
  meta: {
    name: 'ps',
    description: '只读并发账本：在跑的实例、端口、运行时长、端口冲突与已死的 pid（不写记录、不杀进程）',
  },
  args: { json: { type: 'boolean', default: false } },
  run({ args }) {
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
      if (item.stale) console.log(`  ! pid ${item.pid} 已经不在了（记录没改，pal status 才会刷新）`);
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

const watch = defineCommand({
  meta: {
    name: 'watch',
    description:
      'headless 看护：崩掉的 on-failure 实例按预算重起，预算用完/never 的标 broken（不要和 pal serve 同时开）',
  },
  args: {
    interval: {
      type: 'string',
      default: String(DEFAULT_WATCH_INTERVAL_MS),
      description: `每轮检查间隔（毫秒），默认 ${DEFAULT_WATCH_INTERVAL_MS}`,
    },
  },
  async run({ args }) {
    const intervalMs = Number(args.interval);
    if (!Number.isInteger(intervalMs) || intervalMs <= 0) {
      throw new PalError('invalid-input', `--interval 要正整数的毫秒数，收到：${String(args.interval)}`, {
        hint: `默认 ${DEFAULT_WATCH_INTERVAL_MS}；例如 pal watch --interval 5000`,
      });
    }
    console.log('headless 看护已启动；不要和 pal serve 同时开');
    console.log(`  间隔 ${intervalMs}ms；Ctrl+C 退出`);
    const total = await watchLoop({
      intervalMs,
      onRound: (stats) => {
        if (stats.restarted > 0 || stats.broken > 0) {
          console.log(
            `  检查 ${stats.checked} 条：重起 ${stats.restarted}，标 broken ${stats.broken}，跳过 ${stats.skipped}`,
          );
        }
      },
    });
    console.log(
      `已停止（累计检查 ${total.checked} 条，重起 ${total.restarted}，标 broken ${total.broken}）`,
    );
  },
});

const health = defineCommand({
  meta: { name: 'health', description: '体检：进程、端口、home、基线漂移、MCP 接线' },
  args: {
    target: { type: 'positional', required: false, description: '实例 id 或名字；不写就全查' },
    json: { type: 'boolean', default: false },
  },
  async run({ args }) {
    const reports = args.target ? [await checkInstance(String(args.target))] : await checkAll();
    if (args.json) {
      console.log(JSON.stringify(reports, null, 2));
      return;
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

const doctor = defineCommand({
  meta: { name: 'doctor', description: '看宿主发现结果：装没装、什么版本、能不能起' },
  args: {
    probe: { type: 'boolean', default: true, description: '跑 --version 探测版本' },
    json: { type: 'boolean', default: false },
  },
  run({ args }) {
    const infos = discoverAll({ probeVersion: Boolean(args.probe) });
    if (args.json) {
      console.log(JSON.stringify(infos, null, 2));
      return;
    }
    for (const info of infos) {
      const state = !info.available ? '未安装' : info.startable ? '可启动' : '只装配 home';
      console.log(`${info.id}\t${state}\t${info.version ?? info.probeError ?? '-'}`);
      if (info.commandPath) console.log(`  ${info.commandPath}`);
      if (info.reason) console.log(`  ${info.reason}`);
    }
  },
});

const logs = defineCommand({
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

const use = defineCommand({
  meta: { name: 'use', description: '把某个实例设成它宿主的当前实例' },
  args: {
    target: { type: 'positional', required: true, description: '实例 id 或名字' },
    json: { type: 'boolean', default: false },
  },
  run({ args }) {
    const rec = setActive(requireTarget(args.target));
    if (args.json) {
      console.log(JSON.stringify(rec, null, 2));
      return;
    }
    console.log(`✓ ${rec.harness} → ${rec.id}`);
  },
});

const current = defineCommand({
  meta: { name: 'current', description: '看每个宿主当前选中哪份实例' },
  args: { json: { type: 'boolean', default: false } },
  run({ args }) {
    const entries = activeEntries();
    if (args.json) {
      // 只输出 JSON：不要给 console.log 传第二个参数，否则会多打一个 " null"。
      console.log(
        JSON.stringify(
          entries.map((entry) => ({ harness: entry.harness, id: entry.record?.id ?? null })),
          null,
          2,
        ),
      );
      return;
    }
    if (entries.length === 0) {
      console.log('没有当前实例');
      return;
    }
    for (const entry of entries) {
      console.log(`${entry.harness}\t${entry.record?.id ?? '(已删除)'}\t${entry.record?.name ?? ''}`);
    }
  },
});

/**
 * D7：侧车（桌面壳）的关闭入口。对端关掉 stdin 的写端后，这里关掉 HTTP server 再以 0 退出；
 * 桌面壳就不必直接 taskkill /F。'end' 与 'close' 可能先后都到，用一次性开关挡重复触发
 * （server.close 第二次会抛 ERR_SERVER_NOT_RUNNING）。不开启这个开关时完全不碰 stdin。
 */
function watchStdinClose(close: () => Promise<void>): void {
  let closing = false;
  const shutdown = (): void => {
    if (closing) return;
    closing = true;
    // 还有 keep-alive 连接时 server.close 会一直等，别让壳跟着卡住
    const timer = setTimeout(() => process.exit(0), 1500);
    timer.unref();
    close()
      .catch(() => {
        /* 关服务失败也照常退出：调用方只关心进程有没有走 */
      })
      .finally(() => {
        clearTimeout(timer);
        process.exit(0);
      });
  };
  process.stdin.on('end', shutdown);
  process.stdin.on('close', shutdown);
  // 管道对端关闭只有在读的时候才会变成 'end'：不 resume 就永远等不到
  process.stdin.resume();
}

const serve = defineCommand({
  meta: { name: 'serve', description: '起本地界面：实例列表、创建、启停、健康检查、日志' },
  args: {
    port: { type: 'string', default: '0', description: '端口；0 表示让系统挑' },
    host: { type: 'string', default: '127.0.0.1' },
    open: { type: 'boolean', default: false, description: '用 Edge 应用窗口打开' },
    insecure: { type: 'boolean', default: false, description: '关掉来源校验（只给调试用）' },
    'exit-on-stdin-close': {
      type: 'boolean',
      default: false,
      description: 'stdin 被对端关闭时关掉服务并正常退出 0（桌面壳收侧车用）；不开启时行为不变',
    },
    json: { type: 'boolean', default: false },
  },
  async run({ args }) {
    const server = await startPalServer({
      port: Number(args.port ?? 0),
      host: String(args.host ?? '127.0.0.1'),
      insecure: Boolean(args.insecure),
    });
    if (args.json) {
      console.log(JSON.stringify({ url: server.url }));
    } else {
      console.log(`PAL 界面：${server.url}`);
    }
    if (args.open) openAppWindow(server.url);
    if (args['exit-on-stdin-close']) watchStdinClose(server.close);
  },
});

/* ---------- 实例流转 ---------- */

/* ---------- 发现已有环境 ---------- */

const scan = defineCommand({
  meta: {
    name: 'scan',
    description: '只读扫描目录：找出已有实例、Pack 目录与装过 Pack 的环境（不写盘，不接管）',
  },
  args: {
    dir: { type: 'positional', required: true, description: '要扫的目录；相对路径按当前目录解析' },
    depth: {
      type: 'string',
      default: String(DEFAULT_SCAN_DEPTH),
      description: '往下扫几层：目录本身算第 0 层，默认 2',
    },
    json: { type: 'boolean', default: false },
  },
  run({ args }) {
    const depth = Number(args.depth);
    if (!Number.isInteger(depth) || depth < 0) {
      throw new PalError('invalid-input', `--depth 要 0 或正整数，收到：${String(args.depth)}`, {
        hint: '目录本身算第 0 层；默认 2，表示再看两层子目录',
      });
    }
    const dir = resolve(String(args.dir));
    if (!existsSync(dir)) {
      throw new PalError('not-found', `目录不存在：${dir}`, { hint: 'scan 只读，不会替你创建目录' });
    }
    if (!statSync(dir).isDirectory()) {
      throw new PalError('invalid-input', `不是目录：${dir}`);
    }
    const result = scanDirectory(dir, { depth });
    if (args.json) {
      // --json 只输出候选数组；目录读不了这类问题走 problems，不混进候选
      console.log(JSON.stringify(result.entries, null, 2));
      return;
    }
    if (result.entries.length === 0) console.log('没扫到实例、Pack 或环境');
    for (const entry of result.entries) console.log(scanLine(entry));
    for (const problem of result.problems) console.log(`! ${problem.dir}\t${problem.reason}`);
    console.log(`共 ${result.entries.length} 条候选（只读扫描，没有写盘）`);
  },
});

const adopt = defineCommand({
  meta: { name: 'adopt', description: '接管一个已经存在的环境（只写记录，不动目录）' },
  args: {
    dir: { type: 'positional', required: true, description: '已有环境目录' },
    name: { type: 'string', required: true, description: '实例名' },
    harness: { type: 'string', default: 'dsh' },
    json: { type: 'boolean', default: false },
  },
  run({ args }) {
    const rec = adoptInstance({
      dir: String(args.dir),
      name: String(args.name),
      harness: String(args.harness) as InstanceRecord['harness'],
    });
    console.log(args.json ? JSON.stringify(rec, null, 2) : `✓ 接管 ${rec.name} → ${rec.root}`);
  },
});

const clone = defineCommand({
  meta: { name: 'clone', description: '复制一份实例（连 home 一起拷，可独立改）' },
  args: {
    target: { type: 'positional', required: true, description: '源实例 id 或名字' },
    name: { type: 'string', required: true, description: '新实例名' },
    root: {
      type: 'string',
      description: '新实例根（绝对路径，不能落在 PAL 的实例根里）；不写就由系统分配；相对路径直接拒绝',
    },
    json: { type: 'boolean', default: false },
  },
  async run({ args }) {
    const root = args.root === undefined ? undefined : assertExternalRoot(String(args.root));
    const rec = await cloneInstance(requireTarget(args.target), {
      name: String(args.name),
      ...(root ? { root } : {}),
    });
    console.log(args.json ? JSON.stringify(rec, null, 2) : `✓ 复制成 ${rec.id}（${rec.root}）`);
  },
});

const rename = defineCommand({
  meta: { name: 'rename', description: '给实例改名' },
  args: {
    target: { type: 'positional', required: true, description: '实例 id 或名字' },
    name: { type: 'positional', required: true, description: '新名字' },
    json: { type: 'boolean', default: false },
  },
  run({ args }) {
    const rec = renameInstance(requireTarget(args.target), String(args.name));
    if (args.json) {
      console.log(JSON.stringify(rec, null, 2));
      return;
    }
    console.log(`✓ ${rec.id} → ${rec.name}`);
  },
});

const migrate = defineCommand({
  meta: { name: 'migrate', description: '把实例根挪到别的目录，记录路径一起改' },
  args: {
    target: { type: 'positional', required: true, description: '实例 id 或名字' },
    to: { type: 'positional', required: true, description: '新的实例根路径' },
    json: { type: 'boolean', default: false },
  },
  run({ args }) {
    const rec = migrateInstance(requireTarget(args.target), String(args.to));
    if (args.json) {
      console.log(JSON.stringify(rec, null, 2));
      return;
    }
    console.log(`✓ ${rec.id} → ${rec.root}`);
  },
});

const update = defineCommand({
  meta: { name: 'update', description: '把实例里的 Pack 换成另一个版本（要求实例已停）' },
  args: {
    target: { type: 'positional', required: true, description: '实例 id 或名字' },
    version: { type: 'string', description: 'registry 版本；不写用 latest' },
    index: { type: 'string', description: 'registry 索引' },
    force: {
      type: 'boolean',
      default: false,
      description: '覆盖本地改过的文件；不带时若 Pack 写过的文件被本地改过就拒绝更新',
    },
    json: { type: 'boolean', default: false },
  },
  async run({ args }) {
    const rec = requireInstance(requireTarget(args.target));
    const ref = rec.pack.ref ?? rec.pack.name;
    const log = (line: string): void => {
      if (!args.json) console.error(line);
    };
    const result = await updateFromRef({
      idOrName: rec.id,
      packRef: ref,
      ...(args.index ? { index: String(args.index) } : {}),
      ...(args.version ? { version: String(args.version) } : {}),
      ...(args.force ? { force: true } : {}),
      log,
    });
    if (args.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    console.log(`${result.changed ? '✓' : '·'} ${result.from} → ${result.to}`);
    if (result.addedFiles.length > 0) console.log(`  + ${result.addedFiles.length} 个文件`);
    if (result.removedFiles.length > 0) console.log(`  - ${result.removedFiles.length} 个旧文件已清掉`);
    for (const file of result.removedFiles.slice(0, 10)) console.log(`    ${file}`);
    if (result.localChanges.length > 0) {
      console.log(`  ! ${result.localChanges.length} 个文件在改之前被本地改过，现在是新版本的内容；要保留请先备份`);
    }
    if (result.warnings.length > 0) {
      console.log(`  ! ${result.warnings.length} 个旧文件没删掉（更新已完成，这些文件还留在实例里）`);
      for (const line of result.warnings.slice(0, 10)) console.log(`    ${line}`);
      if (result.warnings.length > 10) console.log(`    … 还有 ${result.warnings.length - 10} 条`);
    }
  },
});

const rebaseline = defineCommand({
  meta: { name: 'rebaseline', description: '把当前磁盘状态认作基线（接受本地改动）' },
  args: {
    target: { type: 'positional', required: true, description: '实例 id 或名字' },
    json: { type: 'boolean', default: false },
  },
  run({ args }) {
    const baseline = rebaselineInstance(requireTarget(args.target));
    console.log(
      args.json
        ? JSON.stringify(baseline, null, 2)
        : `✓ 基线已更新：${baseline.files.length} 个文件（${baseline.pack}@${baseline.version}）`,
    );
  },
});

const exportCmd = defineCommand({
  meta: { name: 'export', description: '把实例导出成模板（JSON），可在别处重建' },
  args: {
    target: { type: 'positional', required: true, description: '实例 id 或名字' },
    out: { type: 'string', description: '输出文件；默认 <名字>.pal.json' },
    json: { type: 'boolean', default: false },
  },
  run({ args }) {
    const template = exportTemplate(requireTarget(args.target));
    const out = String(args.out ?? `${template.name}.pal.json`);
    const file = writeTemplate(template, out);
    console.log(args.json ? JSON.stringify(template, null, 2) : `✓ 已导出 ${file}`);
  },
});

const importCmd = defineCommand({
  meta: { name: 'import', description: '从模板重建实例（按记录里的 Pack 引用重取）' },
  args: {
    file: { type: 'positional', required: true, description: '模板文件' },
    name: { type: 'string', description: '新实例名；默认用模板里的名字' },
    index: { type: 'string', description: 'registry 索引' },
    root: {
      type: 'string',
      description: '实例根（绝对路径，不能落在 PAL 的实例根里）；不写就由系统分配；相对路径直接拒绝',
    },
    json: { type: 'boolean', default: false },
  },
  async run({ args }) {
    const root = args.root === undefined ? undefined : assertExternalRoot(String(args.root));
    const log = (line: string): void => {
      if (!args.json) console.error(line);
    };
    const rec = await importFromFile({
      file: String(args.file),
      ...(args.name !== undefined ? { name: String(args.name) } : {}),
      ...(args.index ? { index: String(args.index) } : {}),
      ...(root ? { root } : {}),
      log,
    });
    console.log(args.json ? JSON.stringify(rec, null, 2) : `✓ ${rec.id}\n  ${rec.root}`);
  },
});

const backup = defineCommand({
  meta: {
    name: 'backup',
    description: '整实例快照（目录复制）：含 home 与数据，默认不含凭据；排除锁、停止标记与 logs/',
  },
  args: {
    target: { type: 'positional', required: true, description: '实例 id 或名字' },
    out: {
      type: 'string',
      description: '备份目录；默认 <PACKHUB_HOME>/backups/<名字>-<时间戳>（目标必须不存在）',
    },
    'include-secrets': {
      type: 'boolean',
      default: false,
      description: '连 secrets.json 一起备份；默认不带凭据',
    },
    json: { type: 'boolean', default: false },
  },
  run({ args }) {
    const result = backupInstance(requireTarget(args.target), {
      ...(args.out ? { out: String(args.out) } : {}),
      includeSecrets: Boolean(args['include-secrets']),
    });
    if (args.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    console.log(`✓ 已备份 ${result.meta.instance.name} → ${result.dir}`);
    console.log(
      `  ${result.meta.fileCount} 个文件${result.meta.includesSecrets ? '（含凭据）' : '（不含凭据）'}`,
    );
    if (!result.meta.includesSecrets) {
      console.log('· 默认不备份 secrets.json：要带凭据请显式加 --include-secrets。');
    }
  },
});

const restore = defineCommand({
  meta: { name: 'restore', description: '从备份恢复成一份新实例（新 id、新根，不覆盖已有实例）' },
  args: {
    dir: { type: 'positional', required: true, description: '备份目录（含 backup.json 的那一层）' },
    name: { type: 'string', description: '新实例名；默认沿用备份里的名字（重名时另给）' },
    root: {
      type: 'string',
      description: '新实例根（绝对路径，不能落在 PAL 的实例根里）；不写就由系统分配',
    },
    json: { type: 'boolean', default: false },
  },
  run({ args }) {
    const root = args.root === undefined ? undefined : assertExternalRoot(String(args.root));
    const rec = restoreBackup(String(args.dir), {
      ...(args.name ? { name: String(args.name) } : {}),
      ...(root ? { root } : {}),
    });
    if (args.json) {
      console.log(JSON.stringify(rec, null, 2));
      return;
    }
    console.log(`✓ 已恢复成 ${rec.id}（${rec.name}）`);
    console.log(`  ${rec.root}`);
    if (!rec.home) console.log('· 备份里没有 home 段：这份实例只有实例根内容。');
  },
});

const recover = defineCommand({
  meta: { name: 'recover', description: '看隔离区/失败现场/归档区里有什么' },
  args: { json: { type: 'boolean', default: false } },
  run({ args }) {
    const dirs = { quarantine: quarantineRoot(), failed: failedRoot(), archive: archiveRoot() };
    const out: Record<string, string[]> = {};
    for (const [key, dir] of Object.entries(dirs)) {
      out[key] = existsSync(dir) ? listDir(dir) : [];
    }
    if (args.json) {
      console.log(JSON.stringify({ root: instancesRoot(), ...out }, null, 2));
      return;
    }
    console.log(`实例根：${instancesRoot()}`);
    for (const [key, entries] of Object.entries(out)) {
      console.log(`${key}：${entries.length === 0 ? '（空）' : ''}`);
      for (const entry of entries) console.log(`  ${entry}`);
    }
    console.log('· 隔离区与归档区只是移动，没有被删；人工看过后可以搬回去或删掉。');
  },
});

function listDir(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

function openAppWindow(url: string): void {
  const child =
    process.platform === 'win32'
      ? spawn('msedge', [`--app=${url}`], { detached: true, stdio: 'ignore', windowsHide: false })
      : spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], { detached: true, stdio: 'ignore' });
  child.unref();
}

export const main = defineCommand({
  // 版本号只认 package.json 一份，别在这里手写第二份。
  meta: { name: 'pal', version: pkg.version, description: '实例内核：建、起、停、看护、迁移' },
  subCommands: {
    create,
    config,
    list,
    show,
    cache,
    remove,
    start,
    stop,
    restart,
    status,
    ps,
    watch,
    health,
    doctor,
    logs,
    use,
    current,
    serve,
    scan,
    adopt,
    clone,
    rename,
    migrate,
    update,
    rebaseline,
    export: exportCmd,
    import: importCmd,
    backup,
    restore,
    recover,
  },
});
