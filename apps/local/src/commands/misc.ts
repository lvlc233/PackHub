// 由 cli.ts 拆分：resourceAdd / resource
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { EXIT, command, issueError, problemRaw, say, stop } from '../emit.ts';
import { MANIFEST_FILE, loadPack, planFor, RESOURCE_TYPES, TARGET_IDS } from '@packhub/kernel';
import { addResource } from '@packhub/runtime';

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
    say('要提供 / 需要能力时在清单里写 provides / needs，令牌形如 tool/repo-search@1');
    say('下一步：packhub install . --dry-run 看会发生什么');
  },
});

export const resource = command({
  meta: { name: 'resource', description: '资源编辑' },
  subCommands: { add: resourceAdd },
});
