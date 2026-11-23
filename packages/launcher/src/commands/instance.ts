// pal create / adopt / list / show / remove：实例对象本身。
import { defineCommand } from 'citty';
import { PACKHUB_ENV, harnessIds, isHarnessId } from '@packhub/kernel';
import {
  adoptInstance,
  removeInstance,
  requireInstance,
  scanInstances,
  type InstanceRecord,
} from '../index.ts';
import { createFromRef } from '../service.ts';
import { parseIsolationSpec, readPalConfig } from '../config.ts';
import { DEFAULT_SCAN_DEPTH } from '../scan.ts';
import { discoverAll } from '../harness.ts';
import { PalError } from '../errors.ts';
import { assertExternalRoot } from '../validators.ts';
import { printScan } from './carry.ts';
import { printAudit } from './other.ts';
import { confirm, requireTarget } from './shared.ts';

function printRecord(rec: InstanceRecord): void {
  console.log(`${rec.id}\t${rec.status}\t${rec.harness}\t${rec.pack.name}@${rec.pack.version}`);
  console.log(`  ${rec.root}`);
  if (rec.url) console.log(`  ${rec.url}`);
}

function createKindOf(raw: unknown): InstanceRecord['harness'] {
  const value = String(raw ?? 'dsh');
  if (value === 'dir') {
    throw new PalError('invalid-input', '--kind 不收 dir：dir 是项目目录实例形态', {
      hint: '目录形态用 pal adopt 接管已有目录；装进已有项目用 pal install --project；新建环境用 pal install --new。',
    });
  }
  if (!isHarnessId(value)) {
    throw new PalError('invalid-input', `未知实例形态：${value}`, {
      hint: `可选 ${harnessIds().join(' / ')}；目录形态用 pal adopt / pal install --project。`,
    });
  }
  return value as InstanceRecord['harness'];
}

// 原顶层 create 命令的流程；现在只作为 `pal install --new` 的内部实现，不再单独暴露。
export const createCmd = defineCommand({
  meta: { name: 'create', description: '从 Pack 建一份实例' },
  args: {
    pack: {
      type: 'positional',
      required: true,
      description: 'Pack 目录、.phub、git+https，或配合 --index 用 registry 名',
    },
    name: { type: 'string', required: true, description: '实例名；同名拒绝' },
    kind: {
      type: 'string',
      default: 'dsh',
      description: `实例形态：${harnessIds().join(' | ')}（只有宿主才建实例）。目录形态用 pal adopt；装进已有项目用 pal install --project`,
    },
    index: { type: 'string', description: `registry 索引（路径或 URL；也可用 ${PACKHUB_ENV.index}）` },
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
    const kind = createKindOf(args.kind);
    // 版本信息只用于记录与下面的启动提示：先把该形态探测出来，再交给 service 一起建
    const info = discoverAll({ probeVersion: false }).find((h) => h.id === kind);
    const rec = await createFromRef({
      packRef: String(args.pack),
      ...(args.index ? { index: String(args.index) } : {}),
      ...(args.version ? { version: String(args.version) } : {}),
      name: String(args.name),
      harness: kind as InstanceRecord['harness'],
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
      console.log(`  这个形态没有常驻服务：${info?.reason ?? '只能装配 home'}`);
    }
    if (rec.home && !args['from-home']) {
      console.log(
        `  新 home 里没有模型凭据：要沿用全局环境用 pal install --new --from-home <${
          rec.harness === 'dsh' ? '~/.dsh' : `~/.${rec.harness}`
        }>，或用 pal adopt 接管已有目录。`,
      );
    }
  },
});

export const adopt = defineCommand({
  meta: {
    name: 'adopt',
    description:
      '接管一个已经存在的环境（只写记录，不动目录）；--scan 只读扫描目录，找出已有实例 / Pack 目录 / 装过 Pack 的环境',
  },
  args: {
    dir: {
      type: 'positional',
      required: false,
      description: '已有环境目录；配 --scan 时是要扫的目录，不写就扫当前目录',
    },
    name: { type: 'string', description: '实例名（接管时必填；--scan 不需要）' },
    kind: {
      type: 'string',
      default: 'dsh',
      description: `实例形态：dir（项目目录实例，不是宿主）| ${harnessIds().join(' | ')}`,
    },
    scan: {
      type: 'boolean',
      default: false,
      description:
        '--scan：只读扫目录（找出已有实例、Pack 目录与装过 Pack 的环境），不接管、不写记录；不需要 --name',
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
      // 只读：不要求 --name，也不写记录；目录不给就扫当前目录
      const dir = args.dir === undefined ? '.' : String(args.dir);
      printScan(dir, { depth: String(args.depth), json: Boolean(args.json) });
      return;
    }
    if (args.dir === undefined) {
      throw new PalError('invalid-input', '接管要指定目录：pal adopt <目录> --name <名字>', {
        hint: '只看不接管用 pal adopt --scan；装进已有项目用 pal install --project。',
      });
    }
    if (args.name === undefined) {
      throw new PalError('invalid-input', '接管要给 --name', {
        hint: 'pal adopt <目录> --name <名字>；只看不接管用 pal adopt --scan。',
      });
    }
    const rec = adoptInstance({
      dir: String(args.dir),
      name: String(args.name),
      harness: String(args.kind) as InstanceRecord['harness'],
    });
    console.log(args.json ? JSON.stringify(rec, null, 2) : `✓ 接管 ${rec.name} → ${rec.root}`);
  },
});

export const list = defineCommand({
  meta: {
    name: 'list',
    description:
      '列出实例（纯读：坏记录只列出来，不隔离、不移动）；--history 改成打印安装审计',
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

export const remove = defineCommand({
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
