// 由 cli.ts 拆分：resourceAdd / resource / slotSwap / slot
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { EXIT, command, issueError, problemRaw, say, stop } from '../emit.ts';
import { MANIFEST_FILE, loadPack, planFor, RESOURCE_TYPES, TARGET_IDS } from '@packhub/kernel';
import { addResource, setBinding } from '@packhub/runtime';
import { reportIssues } from './shared.ts';

export const resourceAdd = command({
  meta: { name: 'add', description: `往 ${MANIFEST_FILE} 追加一个资源（结构化编辑，保留注释）` },
  args: {
    type: {
      type: 'positional',
      required: true,
      description: `资源类型：${RESOURCE_TYPES.join(' / ')}`,
    },
    source: {
      type: 'positional',
      required: true,
      description: 'npm: pypi: github: https:// 或 ./相对路径',
    },
    dir: { type: 'string', default: '.', description: 'Pack 目录' },
    id: { type: 'string', description: '自定义资源 id（默认从 source 推断）' },
    target: { type: 'string', default: 'dir', description: `${TARGET_IDS.join(' | ')}` },
  },
  async run({ args }) {
    const type = String(args.type) as (typeof RESOURCE_TYPES)[number];
    if (!RESOURCE_TYPES.includes(type)) {
      problemRaw(`未知类型：${type}（可选：${RESOURCE_TYPES.join(' / ')}）`);
      stop(EXIT.USAGE);
    }
    const dir = resolve(String(args.dir));
    const file = join(dir, MANIFEST_FILE);
    if (!existsSync(file)) {
      problemRaw(`没有 ${MANIFEST_FILE}：${file}（先跑 packhub init）`);
      stop(EXIT.USAGE);
    }

    const { id } = addResource(file, {
      type,
      source: String(args.source),
      ...(args.id ? { id: String(args.id) } : {}),
    });
    say(`✓ 已追加资源 ${id}（${type}）→ ${file}`);

    // 加完立刻重算：格式对不对、能力图缺不缺，当场能看到
    const ctx = loadPack(dir);
    const errors = ctx.issues.filter((i) => i.severity === 'error');
    if (errors.length) {
      for (const e of errors) issueError(e.code, e.message);
      problemRaw('\n资源已写入，但清单还有错误，先修完再安装。');
      stop(EXIT.RUNTIME);
    }
    const { plan } = planFor(ctx, { target: String(args.target ?? 'dir') as never });
    say(`计划：${plan?.actions.length ?? 0} 个动作 · planHash ${plan?.planHash.slice(0, 22)}…`);
    say('下一步：packhub install . --dry-run 看会发生什么');
  },
});

export const resource = command({
  meta: { name: 'resource', description: '资源编辑' },
  subCommands: { add: resourceAdd },
});

export const slotSwap = command({
  meta: { name: 'swap', description: '换某个槽位的实现（只改 bindings 一行）' },
  args: {
    slot: { type: 'positional', required: true },
    resource: { type: 'positional', required: true, description: '占该槽位的资源 id' },
    dir: { type: 'string', default: '.' },
    target: { type: 'string', default: 'dir' },
  },
  async run({ args }) {
    const dir = resolve(String(args.dir));
    const file = join(dir, MANIFEST_FILE);
    if (!existsSync(file)) {
      problemRaw(`没有 ${MANIFEST_FILE}：${file}`);
      stop(EXIT.USAGE);
    }
    const before = planFor(loadPack(dir)).plan;

    setBinding(file, String(args.slot), String(args.resource));
    say(`✓ bindings.${String(args.slot)} → ${String(args.resource)}`);

    const ctx = loadPack(dir);
    const errors = ctx.issues.filter((i) => i.severity === 'error');
    if (errors.length) {
      for (const e of errors) issueError(e.code, e.message);
      stop(EXIT.RUNTIME);
    }
    const { plan, issues } = planFor(ctx, { target: String(args.target ?? 'dir') as never });
    if (!plan) {
      reportIssues(issues, 'packhub slot swap');
      stop(EXIT.RUNTIME);
    }
    const after = plan;
    // 换绑时 actionId（fetch#1）不变，必须按内容比，否则看不出换了什么
    const fp = (a: { op: string } & Record<string, unknown>): string =>
      JSON.stringify({ ...a, actionId: undefined, dependsOn: undefined });
    const beforeSet = new Set((before?.actions ?? []).map((a) => fp(a as never)));
    const afterSet = new Set((after?.actions ?? []).map((a) => fp(a as never)));
    const describe = (a: { op: string } & Record<string, unknown>): string => {
      const target = (a.to ?? a.dest ?? a.path ?? a.uri ?? a.resource ?? '') as string;
      return `${a.op} ${target}`.trim();
    };
    const removed = (before?.actions ?? []).filter((a) => !afterSet.has(fp(a as never)));
    const added = (after?.actions ?? []).filter((a) => !beforeSet.has(fp(a as never)));
    say(`计划：${after?.actions.length ?? 0} 个动作（+${added.length} / -${removed.length}）`);
    for (const a of removed) say(`  - ${describe(a as never)}`);
    for (const a of added) say(`  + ${describe(a as never)}`);
    for (const e of after?.excluded ?? []) say(`  · 跳过 ${e.resource}（槽位 ${e.slot} 未绑定）`);
    say(`planHash ${after?.planHash.slice(0, 22) ?? '—'}…`);
  },
});

export const slot = command({
  meta: { name: 'slot', description: '槽位操作（可替换的实现）' },
  subCommands: { swap: slotSwap },
});
