// pal config / cache / rebaseline / audit / use / current：配置、缓存与“当前实例”这类杂项。
import { defineCommand } from 'citty';
import { auditPath, readAudit } from '@packhub/runtime';
import { existsSync } from 'node:fs';
import { rebaselineInstance } from '../index.ts';
import { cacheStats, cleanCache, formatBytes, planClean, scanCache } from '../cache.ts';
import { activeEntries, setActive } from '../active.ts';
import { CONFIG_VERSION, parseIsolationSpec, readPalConfig, writePalConfig } from '../config.ts';
import { ISOLATION_LAYERS } from '../isolation.ts';
import {
  HOME_SOURCE_LABEL,
  homeHasData,
  instancesRoot,
  locationFile,
  palConfigFile,
  palHomeInfo,
  writeHomePointer,
} from '../paths.ts';
import { assertAbsolutePath } from '../validators.ts';
import { PalError } from '../errors.ts';
import { confirm, requireTarget } from './shared.ts';

export const config = defineCommand({
  meta: {
    name: 'config',
    description:
      'PAL 数据目录与新建实例的默认隔离策略（<数据目录>/pal.json）；隔离策略只影响之后新建的实例',
  },
  args: {
    'set-isolation': {
      type: 'string',
      description: '改成 layer=mode,...；只覆盖写出来的层，其余沿用当前值。只影响之后新建的实例',
    },
    home: {
      type: 'string',
      description:
        '把数据目录改到某个绝对路径（写 location.json）。不搬已有数据；下次启动沿用这次选择',
    },
    force: {
      type: 'boolean',
      default: false,
      description: '当前数据目录里还有数据（实例/缓存/备份/配置）时也允许改数据目录（旧数据仍在原处）',
    },
    json: { type: 'boolean', default: false },
  },
  run({ args }) {
    const homeArg = args.home === undefined ? undefined : assertAbsolutePath(args.home, '数据目录', 'home');
    if (homeArg !== undefined) {
      const before = palHomeInfo();
      if (homeArg === before.home) {
        console.log(`数据目录没变：${homeArg}`);
      } else if (homeHasData() && !args.force) {
        throw new PalError('invalid-input', '当前数据目录里还有数据（实例、缓存、备份或配置），先处理掉再改数据目录', {
          hint:
            '用 pal backup / pal restore 或手动搬整个数据目录；确认旧目录不再使用可加 --force。' +
            '改只影响之后写入的位置，不会替你搬数据',
          details: { current: before.home, next: homeArg },
        });
      } else {
        const target = writeHomePointer(homeArg);
        console.log(`✓ 数据目录已切到 ${target}`);
        console.log('· 旧目录里的实例、缓存与备份仍在原处，不会自动搬；新数据从这里开始。');
        const after = palHomeInfo();
        if (after.home !== target) {
          console.log(
            `! 当前进程仍被 ${HOME_SOURCE_LABEL[after.source]} 指向 ${after.home}，优先级高于这次选择；` +
              '要让选择生效，先取消那个覆盖。',
          );
        }
      }
    }
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
    const info = palHomeInfo();
    if (args.json) {
      console.log(
        JSON.stringify(
          {
            version: next.version,
            isolation: next.isolation,
            home: info.home,
            homeSource: info.source,
            instancesRoot: instancesRoot(),
            configFile: file,
            locationFile: locationFile(),
          },
          null,
          2,
        ),
      );
      return;
    }
    console.log(`数据目录  ${info.home}（${HOME_SOURCE_LABEL[info.source]}）`);
    console.log(`实例根    ${instancesRoot()}`);
    console.log(`配置文件  ${file}${existsSync(file) ? '' : '（还没有这个文件：现在用的是内置默认）'}`);
    if (spec !== undefined) console.log(`✓ 已写入 ${file}`);
    for (const layer of ISOLATION_LAYERS) {
      console.log(`  ${layer.padEnd(12)}${next.isolation.layers[layer]}`);
    }
    console.log('· 这是新实例的默认策略：已有实例的隔离策略不变。');
  },
});

export const cache = defineCommand({
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

export const audit = defineCommand({
  meta: {
    name: 'audit',
    description: '看本机的安装审计（pal install（--new/--project/--environment）/ update 等写的那份；与 packhub 共用同一文件）',
  },
  args: {
    tail: { type: 'string', default: '20', description: '只看最近 N 条' },
    json: { type: 'boolean', default: false },
  },
  run({ args }) {
    const entries = readAudit(Number(args.tail) || 20);
    if (args.json) {
      console.log(JSON.stringify(entries, null, 2));
      return;
    }
    if (entries.length === 0) {
      console.log(`还没有审计记录：${auditPath()}`);
      return;
    }
    for (const entry of entries) {
      console.log(
        `${entry.at.slice(0, 19)}  ${entry.action.padEnd(8)} ${`${entry.pack ?? ''}@${entry.version ?? ''}`.padEnd(34)} ${entry.ok === false ? 'x' : '✓'}  ${entry.planHash?.slice(0, 14) ?? ''}`,
      );
    }
    console.log(`\n${auditPath()}`);
  },
});

export const use = defineCommand({
  meta: {
    name: 'use',
    description:
      '把某个实例设成它宿主的当前实例（install --new / adopt 建完默认已经设过；pal start 不写目标时用的就是它）',
  },
  args: {
    target: { type: 'positional', required: true, description: '实例 id 或名字；设成它宿主的当前实例' },
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

export const current = defineCommand({
  meta: {
    name: 'current',
    description:
      '看每个宿主当前选中哪份实例（每个宿主各有一份当前；pal start 不写目标时要求当前唯一）',
  },
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

export const rebaseline = defineCommand({
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
