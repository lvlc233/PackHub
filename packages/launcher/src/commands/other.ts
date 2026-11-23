// pal config / use / current：配置、当前实例，以及并进 flag 的诊断输出（审计）。
import { defineCommand } from 'citty';
import { auditPath, readAudit } from '@packhub/runtime';
import { existsSync } from 'node:fs';
import { rebaselineInstance, renameInstance, type Baseline } from '../index.ts';
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
import { requireTarget } from './shared.ts';

/**
 * 读安装审计并打印（原 pal audit 的实现；现在是 `pal list --history`）。
 * 默认 20 条，`--tail` 改条数；--json 只输出审计数组。
 */
export function printAudit(tail: number, json: boolean): void {
  const entries = readAudit(Number.isFinite(tail) && tail > 0 ? tail : 20);
  if (json) {
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
}

/** 把当前磁盘状态认作基线（原 pal rebaseline 的实现；现在是 `pal verify --accept`）。 */
export function acceptBaseline(target: string): Baseline {
  return rebaselineInstance(requireTarget(target));
}

/** `config <环境> --name <新名字>`：只改这一份环境的名字，不碰全局配置。 */
function renameEnv(args: {
  target: unknown;
  name: unknown;
  home: unknown;
  'set-isolation': unknown;
  force: unknown;
  json: boolean;
}): void {
  const target = String(args.target ?? '').trim();
  if (!target) {
    throw new PalError('invalid-input', '--name 要给环境：pal config <环境> --name <新名字>', {
      hint: '地名参数写在 --name 前：pal config demo --name demo-2；只看全局配置就别写环境名。',
    });
  }
  if (args.name === undefined) {
    throw new PalError('invalid-input', `给环境 ${target} 时要 --name`, {
      hint: 'pal config <环境> --name <新名字>；只看全局配置就别写环境名。',
    });
  }
  if (args.home !== undefined || args['set-isolation'] !== undefined || args.force === true) {
    throw new PalError('invalid-input', '给环境改名时不能同时改全局配置', {
      hint: '--home / --set-isolation / --force 只用于不带环境名的 pal config；改名只写 instance.json 里的 name。',
    });
  }
  const rec = renameInstance(target, String(args.name));
  if (args.json) {
    console.log(JSON.stringify(rec, null, 2));
    return;
  }
  console.log(`✓ ${rec.id} → ${rec.name}`);
}

export const config = defineCommand({
  meta: {
    name: 'config',
    description:
      'PAL 数据目录与新建实例的默认隔离策略（<数据目录>/pal.json）；给环境名 + --name 只给那个环境改名',
  },
  args: {
    target: {
      type: 'positional',
      required: false,
      description: '环境 id 或名字：只改这一份环境的名字（配 --name）；不写就是看/改全局配置',
    },
    name: { type: 'string', description: '配环境名用：这个环境的新名字（与已有环境重名时拒绝）' },
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
    if (args.target !== undefined || args.name !== undefined) {
      renameEnv(args);
      return;
    }
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
