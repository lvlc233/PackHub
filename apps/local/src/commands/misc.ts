// 由 cli.ts 拆分：resourceAdd / resource
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { EXIT, command, issueError, problemRaw, say, stop } from '../emit.ts';
import { MANIFEST_FILE, loadPack, planFor, RESOURCE_TYPES } from '@packhub/kernel';
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

    // 加完立刻重算：格式、能力图、计划三层的错当场能看到。
    // 这里只是作者侧自检，按中性 dir 算，不暴露安装期参数（target 只在 install / plan / verify 里选）。
    const ctx = loadPack(dir);
    const errors = ctx.issues.filter((i) => i.severity === 'error');
    if (errors.length) {
      for (const e of errors) issueError(e.code, e.message);
      problemRaw('\n资源已写入，但清单还有错误，先修完再打包。');
      stop(EXIT.RUNTIME);
    }
    const { plan, issues } = planFor(ctx);
    if (!plan) {
      for (const i of issues.filter((i) => i.severity === 'error')) issueError(i.code, i.message);
      problemRaw('\n资源已写入，但算不出安装计划，先修清单。');
      stop(EXIT.RUNTIME);
    }
    say('清单校验通过（schema / 能力图 / 计划）');
    say('要提供 / 需要能力时在清单里写 provides / needs，令牌形如 tool/repo-search@1');
    say('下一步：packhub lock 钉引用，然后 packhub pack 出归档');
  },
});

export const resource = command({
  meta: { name: 'resource', description: '资源编辑' },
  subCommands: { add: resourceAdd },
});
