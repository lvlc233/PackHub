import { defineCommand } from 'citty';
import pkg from '../package.json' with { type: 'json' };
import { createInterface } from 'node:readline/promises';
import { spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import {
  adoptInstance,
  cloneInstance,
  createInstance,
  exportTemplate,
  listInstances,
  migrateInstance,
  readInstance,
  readTemplate,
  rebaselineInstance,
  removeInstance,
  renameInstance,
  requireInstance,
  scanInstances,
  updateInstance,
  writeInstance,
  writeTemplate,
  type InstanceRecord,
} from './index.ts';
import { materializePack } from './materialize.ts';
import { cacheStats, cleanCache, formatBytes, planClean, scanCache } from './cache.ts';
import { refreshStatuses, restartInstance, startInstance, startInstanceDetailed, stopInstance } from './start.ts';
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
    const packDir = await materializePack(String(args.pack), {
      ...(args.index ? { index: String(args.index) } : {}),
      ...(args.version ? { version: String(args.version) } : {}),
      log,
    });
    const harness = String(args.harness ?? 'dir');
    const info = discoverAll({ probeVersion: false }).find((h) => h.id === harness);
    const rec = await createInstance({
      name: String(args.name),
      harness: harness as InstanceRecord['harness'],
      packDir,
      packRef: String(args.pack),
      ...(root ? { root } : {}),
      ...(args['from-home'] ? { seedFrom: String(args['from-home']) } : {}),
      ...(info?.version ? { harnessVersion: info.version } : {}),
      ...(isolation ? { isolation } : {}),
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
  meta: { name: 'stop', description: '停掉一个在跑的实例' },
  args: {
    target: { type: 'positional', required: true, description: '实例 id 或名字' },
    json: { type: 'boolean', default: false },
  },
  async run({ args }) {
    const rec = await stopInstance(requireTarget(args.target));
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

const serve = defineCommand({
  meta: { name: 'serve', description: '起本地界面：实例列表、创建、启停、健康检查、日志' },
  args: {
    port: { type: 'string', default: '0', description: '端口；0 表示让系统挑' },
    host: { type: 'string', default: '127.0.0.1' },
    open: { type: 'boolean', default: false, description: '用 Edge 应用窗口打开' },
    insecure: { type: 'boolean', default: false, description: '关掉来源校验（只给调试用）' },
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
  },
});

/* ---------- 实例流转 ---------- */

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
    const packDir = await materializePack(ref, {
      ...(args.index ? { index: String(args.index) } : {}),
      ...(args.version ? { version: String(args.version) } : {}),
      log,
    });
    const result = await updateInstance(rec.id, {
      packDir,
      packRef: ref,
      ...(args.force ? { force: true } : {}),
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
    const template = readTemplate(String(args.file));
    const ref = template.origin?.ref;
    if (!ref) throw new PalError('invalid-input', '模板里没有 Pack 引用，重建不了', { hint: '用 pal create 重新建' });
    const root = args.root === undefined ? undefined : assertExternalRoot(String(args.root));
    const log = (line: string): void => {
      if (!args.json) console.error(line);
    };
    const packDir = await materializePack(ref, {
      ...(args.index ? { index: String(args.index) } : {}),
      version: template.pack.version,
      log,
    });
    const rec = await createInstance({
      name: String(args.name ?? template.name),
      harness: template.harness,
      packDir,
      packRef: ref,
      ...(root ? { root } : {}),
    });
    console.log(args.json ? JSON.stringify(rec, null, 2) : `✓ ${rec.id}\n  ${rec.root}`);
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
    health,
    doctor,
    logs,
    use,
    current,
    serve,
    adopt,
    clone,
    rename,
    migrate,
    update,
    rebaseline,
    export: exportCmd,
    import: importCmd,
    recover,
  },
});
