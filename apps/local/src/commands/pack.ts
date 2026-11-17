// 由 cli.ts 拆分：run / publish / probe / pack
import { join, resolve } from 'node:path';
import { EXIT, command, json, problemRaw, say, stop } from '../emit.ts';
import { runPack } from '@packhub/runner';
import { publishPack, writeIndex } from '@packhub/registry';
import { probeHarness, probeSkill, packArchive, LocalSourceNotVendoredError } from '@packhub/runtime';

export const run = command({
  meta: { name: 'run', description: '在干净目录里装一遍并校验（发布门禁的同一个执行者）' },
  args: {
    dir: { type: 'positional', required: false, default: '.' },
    out: { type: 'string', description: '报告写到哪，默认 <dir>/verify.json' },
    json: { type: 'boolean', default: false },
    'allow-exec': { type: 'boolean', default: false, description: '允许执行清单里的 install.exec' },
  },
  async run({ args }) {
    const dir = resolve(String(args.dir));
    const { report } = await runPack(dir, {
      out: args.out ? resolve(String(args.out)) : join(dir, 'verify.json'),
      allowExec: Boolean(args['allow-exec']),
      log: (line) => say(line),
    });
    if (args.json) json(report);
    stop(report.ok ? EXIT.OK : EXIT.RUNTIME);
  },
});

export const publish = command({
  meta: { name: 'publish', description: '发布一个包：先干净安装+校验，再写进 registry' },
  args: {
    dir: { type: 'positional', required: false, default: '.' },
    registry: { type: 'string', default: 'registry', description: 'registry 根目录' },
    out: { type: 'string', description: '写到别的目录（PR 模式）' },
    'dry-run': { type: 'boolean', default: false },
    force: { type: 'boolean', default: false, description: '允许覆盖已存在的版本目录' },
    offline: { type: 'boolean', default: false, description: '不联网解析引用' },
    'allow-exec': { type: 'boolean', default: false, description: '允许 runner 执行清单里的 install.exec' },
    'allow-non-public': { type: 'boolean', default: false, description: '允许发布 unlisted/internal（公共索引仍只收 public）' },
    json: { type: 'boolean', default: false, description: '输出结构化结果（脚本用）' },
  },
  async run({ args }) {
    const registry = resolve(String(args.registry));
    const res = await publishPack(resolve(String(args.dir)), {
      registry,
      ...(args.out ? { out: resolve(String(args.out)) } : {}),
      dryRun: Boolean(args['dry-run']),
      force: Boolean(args.force),
      offline: Boolean(args.offline),
      allowExec: Boolean(args['allow-exec']),
      allowNonPublic: Boolean(args['allow-non-public']),
      log: args.json ? () => {} : (line) => say(line),
    });
    if (args['dry-run']) {
      if (args.json) json({ ...res, dryRun: true });
      else say(`\n[dry-run] 将发布 ${res.name}@${res.version}，未写盘`);
      return;
    }
    if (!args.out) {
      const idx = writeIndex(registry);
      if (!idx.ok) {
        // 索引门禁失败：把刚写的版本目录/归档撤掉，别留下「版本在、索引没有」的半套
        res.rollback();
        if (args.json) {
          json({ ok: false, name: res.name, version: res.version, error: '索引门禁没过，已撤回版本目录' });
        } else {
          problemRaw('\n索引有错误，未写入；本次版本目录与归档已撤回。');
        }
        stop(EXIT.RUNTIME);
      }
      res.finalize();
      if (args.json) {
        json({ ok: true, ...res, indexed: true, packs: idx.packs });
      } else {
        say(`\n索引已更新：${idx.packs} 个包`);
        say(`发布完成：${res.name}@${res.version}`);
      }
    } else {
      res.finalize();
      if (args.json) json({ ok: true, ...res, indexed: false });
      else {
        say(`\n已写到 ${res.dir}；把${args.out} 下改动提交成 PR 即可`);
        say(`发布完成：${res.name}@${res.version}`);
      }
    }
  },
});

export const probe = command({
  meta: { name: 'probe', description: '真机探针：跑一次 harness，看它有没有读到包写进去的指令' },
  args: {
    dir: { type: 'positional', required: false, default: '.' },
    target: { type: 'string', default: 'dsh', description: 'dsh | claude-code | opencode | codex' },
    patch: { type: 'string', description: 'dsh 的 --patch 层（配置 provider / 模型）' },
    skill: { type: 'string', description: '改问技能选择器：断言这个 skill 名出现在可用列表里' },
    json: { type: 'boolean', default: false },
  },
  run({ args }) {
    const target = String(args.target) as 'dsh' | 'claude-code' | 'opencode' | 'codex';
    const result = args.skill
      ? probeSkill({ target, projectDir: resolve(String(args.dir)), skill: String(args.skill) })
      : probeHarness({
          target,
          projectDir: resolve(String(args.dir)),
          ...(args.patch ? { patchFile: resolve(String(args.patch)) } : {}),
        });
    if (args.json) {
      json(result);
      if (!result.ok) stop(EXIT.RUNTIME);
      return;
    }
    say(result.ok ? '✓ harness 读到了托管块' : 'x 没读到');
    say(`  命令：${result.command}`);
    if (result.marker) say(`  期望标记：${result.marker}`);
    if (result.answer) say(`  回答：${result.answer.replace(/\s+/g, ' ').slice(0, 200)}`);
    if (result.reason) say(`  原因：${result.reason}`);
    if (!result.ok) stop(EXIT.RUNTIME);
  },
});

export const pack = command({
  meta: {
    name: 'pack',
    description: '封装：把 Pack 目录打成 .phub 归档（不是整合，也不是发布）',
  },
  args: {
    dir: { type: 'positional', required: false, default: '.' },
    out: { type: 'string', description: '输出路径，默认 <dir>/pack.phub' },
    reference: {
      type: 'boolean',
      default: false,
      description: '只打清单与锁，安装时按 source 取内容（要求所有来源都可远程获取）',
    },
    json: { type: 'boolean', default: false, description: '输出结构化结果（脚本用）' },
  },
  async run({ args }) {
    const dir = resolve(String(args.dir));
    const vendored = !args.reference;
    const res = await packArchive(dir, {
      vendored,
      ...(args.out ? { out: resolve(String(args.out)) } : {}),
    });
    if (args.json) {
      json({ ...res, mode: vendored ? 'vendored' : 'reference' });
      return;
    }
    say(`✓ ${res.file}（${Math.max(1, Math.round(res.bytes / 1024))} KB）`);
    say(
      `包含：${res.entries.join('、')}${vendored ? '（自包含）' : '（reference 模式：安装时要能按 source 取到内容）'}`,
    );
  },
}, {
  // 本地来源没随包带上：是输入问题（2）；封装过程本身出错仍是运行失败（1）
  code: (err) => (err instanceof LocalSourceNotVendoredError ? EXIT.USAGE : EXIT.RUNTIME),
});
