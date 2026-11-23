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
import { discoverAll } from '../harness.ts';
import { PalError } from '../errors.ts';
import { assertExternalRoot } from '../validators.ts';
import { confirm, requireTarget } from './shared.ts';

function printRecord(rec: InstanceRecord): void {
  console.log(`${rec.id}\t${rec.status}\t${rec.harness}\t${rec.pack.name}@${rec.pack.version}`);
  console.log(`  ${rec.root}`);
  if (rec.url) console.log(`  ${rec.url}`);
}

function createKindOf(raw: unknown): InstanceRecord['harness'] {
  const value = String(raw ?? 'dsh');
  if (value === 'dir') {
    throw new PalError('invalid-input', 'pal create 不建目录形态实例：dir 是项目目录实例', {
      hint: '目录形态用 pal adopt 接管已有目录；装进已有目录用 pal install；新建宿主实例才用 pal create。',
    });
  }
  if (!isHarnessId(value)) {
    throw new PalError('invalid-input', `未知实例形态：${value}`, {
      hint: `可选 ${harnessIds().join(' / ')}；目录形态用 pal adopt / pal install。`,
    });
  }
  return value as InstanceRecord['harness'];
}

export const create = defineCommand({
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
      description: `实例形态：${harnessIds().join(' | ')}（只有宿主才建实例）。目录形态用 pal adopt；装进已有目录用 pal install`,
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
        `  新 home 里没有模型凭据：要沿用全局环境用 pal create --from-home <${
          rec.harness === 'dsh' ? '~/.dsh' : `~/.${rec.harness}`
        }>，或用 pal adopt 接管已有目录。`,
      );
    }
  },
});

export const adopt = defineCommand({
  meta: { name: 'adopt', description: '接管一个已经存在的环境（只写记录，不动目录）' },
  args: {
    dir: { type: 'positional', required: true, description: '已有环境目录' },
    name: { type: 'string', required: true, description: '实例名' },
    kind: {
      type: 'string',
      default: 'dsh',
      description: `实例形态：dir（项目目录实例，不是宿主）| ${harnessIds().join(' | ')}`,
    },
    json: { type: 'boolean', default: false },
  },
  run({ args }) {
    const rec = adoptInstance({
      dir: String(args.dir),
      name: String(args.name),
      harness: String(args.kind) as InstanceRecord['harness'],
    });
    console.log(args.json ? JSON.stringify(rec, null, 2) : `✓ 接管 ${rec.name} → ${rec.root}`);
  },
});

export const list = defineCommand({
  meta: { name: 'list', description: '列出实例（纯读：坏记录只列出来，不隔离、不移动）' },
  args: { json: { type: 'boolean', default: false } },
  run({ args }) {
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
