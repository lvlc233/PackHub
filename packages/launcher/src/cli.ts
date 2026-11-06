import { defineCommand } from 'citty';
import { createInstance, listInstances, readInstance, removeInstance, type InstanceRecord } from './index.ts';
import { materializePack } from './materialize.ts';
import { refreshStatuses, startInstance, stopInstance } from './start.ts';
import { activeEntries, setActive } from './active.ts';

function printRecord(rec: InstanceRecord): void {
  console.log(`${rec.id}\t${rec.status}\t${rec.harness}\t${rec.pack.name}@${rec.pack.version}`);
  console.log(`  ${rec.root}`);
}

const create = defineCommand({
  meta: { name: 'create', description: '从 Pack 建一份实例配置' },
  args: {
    pack: {
      type: 'positional',
      required: true,
      description: 'Pack 目录、.phub、git+https，或配合 --index 用 registry 名',
    },
    name: { type: 'string', required: true, description: '实例名；同名拒绝' },
    harness: { type: 'string', default: 'dir', description: 'dir | dsh | claude-code | codex' },
    index: { type: 'string', description: 'registry 索引（路径或 URL；也可用 PACKHUB_INDEX）' },
    version: { type: 'string', description: 'registry 包的版本，默认 latest' },
    json: { type: 'boolean', default: false },
  },
  async run({ args }) {
    const log = (line: string): void => {
      if (!args.json) console.error(line);
    };
    const packDir = await materializePack(String(args.pack), {
      ...(args.index ? { index: String(args.index) } : {}),
      ...(args.version ? { version: String(args.version) } : {}),
      log,
    });
    const rec = await createInstance({
      name: String(args.name),
      harness: String(args.harness ?? 'dir') as InstanceRecord['harness'],
      packDir,
    });
    if (args.json) {
      console.log(JSON.stringify(rec, null, 2));
      return;
    }
    console.log(`✓ ${rec.id}`);
    printRecord(rec);
  },
});

const list = defineCommand({
  meta: { name: 'list', description: '列出实例配置' },
  args: { json: { type: 'boolean', default: false } },
  run({ args }) {
    const rows = listInstances();
    if (args.json) {
      console.log(JSON.stringify(rows, null, 2));
      return;
    }
    if (rows.length === 0) {
      console.log('没有实例配置');
      return;
    }
    for (const rec of rows) printRecord(rec);
  },
});

const show = defineCommand({
  meta: { name: 'show', description: '看一份实例配置' },
  args: { target: { type: 'positional', required: true, description: '实例 id 或名字' } },
  run({ args }) {
    const rec = readInstance(String(args.target));
    if (!rec) {
      console.error(`没有这个实例：${String(args.target)}`);
      process.exit(1);
    }
    console.log(JSON.stringify(rec, null, 2));
  },
});

const remove = defineCommand({
  meta: { name: 'remove', description: '删一份实例配置（先卸包，再删实例根）' },
  args: {
    target: { type: 'positional', required: true, description: '实例 id 或名字' },
    json: { type: 'boolean', default: false },
  },
  run({ args }) {
    const rec = removeInstance(String(args.target));
    if (args.json) {
      console.log(JSON.stringify({ id: rec.id, removed: true }, null, 2));
      return;
    }
    console.log(`✓ 已删除 ${rec.id}`);
  },
});

const start = defineCommand({
  meta: { name: 'start', description: '起一个实例（现在支持 dsh web，端口自动分配）' },
  args: {
    target: { type: 'positional', required: false, description: '实例 id 或名字；不写就用当前实例' },
    json: { type: 'boolean', default: false },
  },
  async run({ args }) {
    let id = args.target ? String(args.target) : undefined;
    if (!id) {
      const actives = activeEntries().filter((entry) => entry.record);
      if (actives.length === 0) {
        console.error('没有指定实例，也没有当前实例；先 pal use <id>');
        process.exit(2);
      }
      if (actives.length > 1) {
        console.error(
          `当前有 ${actives.length} 个宿主的实例：${actives.map((e) => `${e.harness}=${e.record!.id}`).join(', ')}；指定一个`,
        );
        process.exit(2);
      }
      id = actives[0]!.record!.id;
    }
    const rec = await startInstance(id);
    if (args.json) {
      console.log(JSON.stringify(rec, null, 2));
      return;
    }
    console.log(`✓ ${rec.id}  running  pid ${rec.pid ?? '-'}`);
    console.log(`  ${rec.url ?? ''}`);
  },
});

const stop = defineCommand({
  meta: { name: 'stop', description: '停掉一个在跑的实例' },
  args: {
    target: { type: 'positional', required: true, description: '实例 id 或名字' },
    json: { type: 'boolean', default: false },
  },
  run({ args }) {
    const rec = stopInstance(String(args.target));
    if (args.json) {
      console.log(JSON.stringify(rec, null, 2));
      return;
    }
    console.log(`✓ 已停止 ${rec.id}`);
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
      console.log('没有实例配置');
      return;
    }
    for (const rec of rows) {
      const where = rec.url ?? (rec.pid ? `pid ${rec.pid}` : '-');
      console.log(`${rec.id}\t${rec.status}\t${rec.harness}\t${where}`);
    }
  },
});

const use = defineCommand({
  meta: { name: 'use', description: '把某个实例设成它宿主的当前实例' },
  args: { target: { type: 'positional', required: true, description: '实例 id 或名字' } },
  run({ args }) {
    const rec = setActive(String(args.target));
    console.log(`✓ ${rec.harness} → ${rec.id}`);
  },
});

const current = defineCommand({
  meta: { name: 'current', description: '看每个宿主当前选中哪份实例' },
  args: { json: { type: 'boolean', default: false } },
  run({ args }) {
    const entries = activeEntries();
    if (args.json) {
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

export const main = defineCommand({
  meta: { name: 'pal', version: '0.0.1', description: '实例配置内核' },
  subCommands: { create, list, show, remove, start, stop, status, use, current },
});
