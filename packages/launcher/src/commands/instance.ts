// pal adopt / list / show / remove：home 对象本身。
import { basename, resolve } from 'node:path';
import { defineCommand } from 'citty';
import { harnessIds } from '@packhub/kernel';
import {
  adoptInstance,
  removeInstance,
  requireInstance,
  scanInstances,
  type InstanceRecord,
} from '../index.ts';
import { DEFAULT_SCAN_DEPTH } from '../scan.ts';
import { PalError } from '../errors.ts';
import { assertHomeNameFree, assertNotAttached, hostArg } from '../validators.ts';
import { printScan } from './carry.ts';
import { printAudit } from './other.ts';
import { confirm, requireTarget } from './shared.ts';

function printRecord(rec: InstanceRecord): void {
  console.log(
    `${rec.id}\t${rec.name}\t${rec.status}\t${rec.harness}\t${rec.pack.name}@${rec.pack.version}\t${rec.attached ? 'attached' : 'managed'}`,
  );
  console.log(`  ${rec.root}`);
  if (rec.url) console.log(`  ${rec.url}`);
}

export const adopt = defineCommand({
  meta: {
    name: 'adopt',
    description:
      '把一个已有目录登记成 attached home（只写记录，不装包、不动文件）；--scan 只读扫描目录，找出已有实例 / Pack 目录 / 装过 Pack 的环境',
  },
  args: {
    dir: {
      type: 'positional',
      required: false,
      description: '已有目录（宿主的全局 home）；配 --scan 时是要扫的目录，不写就扫当前目录',
    },
    host: {
      type: 'string',
      description: `按哪个宿主登记（必填）：${harnessIds().join(' / ')}`,
    },
    name: { type: 'string', description: 'home 名；不写就用目录的 basename' },
    scan: {
      type: 'boolean',
      default: false,
      description:
        '--scan：只读扫目录（找出已有实例、Pack 目录与装过 Pack 的环境），不接管、不写记录；不需要 --host / --name',
    },
    depth: {
      type: 'string',
      default: String(DEFAULT_SCAN_DEPTH),
      description: '配 --scan：往下扫几层，目录本身算第 0 层，默认 2',
    },
    json: { type: 'boolean', default: false },
  },
  run({ args }) {
    if (args.scan) {
      // 只读：不要求 --host，也不写记录；目录不给就扫当前目录
      const dir = args.dir === undefined ? '.' : String(args.dir);
      printScan(dir, { depth: String(args.depth), json: Boolean(args.json) });
      return;
    }
    if (args.dir === undefined) {
      throw new PalError('invalid-input', '接管要指定目录：pal adopt <目录> --host <宿主> [--name <名字>]', {
        hint: '只看不接管用 pal adopt --scan；装进已有项目用 pal install --project。',
      });
    }
    const host = hostArg(args.host, 'adopt');
    const dir = resolve(String(args.dir));
    const name = args.name === undefined ? basename(dir) : String(args.name).trim();
    if (!name) {
      throw new PalError('invalid-input', '接管要给一个名字', {
        hint: '目录名不能当名字时用 --name <名字>；只看不接管用 pal adopt --scan。',
      });
    }
    assertHomeNameFree(name);
    const rec = adoptInstance({ dir, name, harness: host });
    console.log(args.json ? JSON.stringify(rec, null, 2) : `✓ 接管 ${rec.name}（attached）→ ${rec.root}`);
  },
});

export const list = defineCommand({
  meta: {
    name: 'list',
    description:
      '列出 home（纯读：坏记录只列出来，不隔离、不移动）；managed / attached 都标出来；--history 改成打印安装审计',
  },
  args: {
    history: {
      type: 'boolean',
      default: false,
      description:
        '打印本机的安装审计（pal install / update 等写的那份；与 packhub 共用同一文件），可与 --json 组合',
    },
    tail: {
      type: 'string',
      default: '20',
      description: '配 --history：只看最近 N 条，默认 20',
    },
    json: { type: 'boolean', default: false },
  },
  run({ args }) {
    if (args.history) {
      printAudit(Number(args.tail), Boolean(args.json));
      return;
    }
    // 纯读：坏记录留给人工处理；listInstances() 会顺手把坏记录挪进隔离区，不能在 list 里用
    const scan = scanInstances();
    const rows = scan.records;
    if (args.json) {
      console.log(JSON.stringify({ instances: rows, broken: scan.broken }, null, 2));
      return;
    }
    if (rows.length === 0) console.log('没有实例');
    for (const rec of rows) printRecord(rec);
    for (const bad of scan.broken) console.log(`! 坏记录 ${bad.dir}\t${bad.reason}`);
  },
});

export const show = defineCommand({
  meta: { name: 'show', description: '看一份 home（JSON 里有 attached 字段：true = attached，false = managed）' },
  args: {
    target: { type: 'positional', required: true, description: 'home id 或名字' },
    json: { type: 'boolean', default: false, description: '只输出记录 JSON（show 默认已是 JSON）' },
  },
  run({ args }) {
    const rec = requireInstance(requireTarget(args.target));
    // show 一直只输出记录 JSON；--json 只是给脚本一个显式开关，两种写法输出一致。
    console.log(JSON.stringify(rec, null, 2));
  },
});

export const remove = defineCommand({
  meta: {
    name: 'remove',
    description:
      '删一份 managed home（先停进程；默认直接删根，--keep-data 先卸包再归档）；attached home 不归 PAL，用 pal uninstall --home <路径>',
  },
  args: {
    target: { type: 'positional', required: true, description: 'home id 或名字' },
    'keep-data': {
      type: 'boolean',
      default: false,
      description: '先按 state 卸包，再把 home（会话 / 凭据）挪进归档区',
    },
    yes: { type: 'boolean', default: false, description: '跳过确认' },
    json: { type: 'boolean', default: false },
  },
  async run({ args }) {
    const rec = requireInstance(requireTarget(args.target));
    // 先挡 attached：别让人确认完才看到「不归 PAL」
    assertNotAttached(rec);
    const keep = Boolean(args['keep-data']);
    const what = keep
      ? '先按 state 卸掉 Pack 装进去的文件，再把 home（会话 / 凭据）挪进归档区'
      : '直接删掉整个 home 根（Pack 装进去的文件随根一起消失）';
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
