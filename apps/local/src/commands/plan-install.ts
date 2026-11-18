// 由 cli.ts 拆分：plan / install / verify / lock / init / rollback / versions / activate / uninstall / diff
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { EXIT, command, json, problem, problemRaw, say, stop, warn } from '../emit.ts';
import { parsePackRef } from '../ref.ts';
import {
  loadPack,
  planFor,
  diffActions,
  describeAction,
  checkLockConsistency,
  PACK_NAME_PATTERN,
  TARGET_IDS,
  type TargetId,
} from '@packhub/kernel';
import {
  doctorPack,
  removePack,
  rollbackPack,
  listVersions,
  activatePack,
  installPack,
  verifyAt,
  verifyInstalled,
  loadLock,
  withLockPins,
  loadState,
  lockPack,
  appendAudit,
} from '@packhub/runtime';
import { reportIssues, printPlan, SAFE_CHECKS } from './shared.ts';

export const plan = command({
  meta: { name: 'plan', description: '解析 Pack 并打印安装计划（不落盘）' },
  args: {
    dir: { type: 'positional', required: false, default: '.' },
    json: { type: 'boolean', default: false },
    target: { type: 'string', default: 'dir', description: `${TARGET_IDS.join(' | ')}` },
  },
  run({ args }) {
    const ctx = loadPack(String(args.dir));
    if (reportIssues(ctx.issues)) stop(EXIT.USAGE);
    const { plan: p, issues } = planFor(ctx, { target: String(args.target ?? 'dir') as never });
    if (!p) {
      reportIssues(issues);
      stop(EXIT.USAGE);
    }
    if (args.json) json(p);
    else printPlan(p);
  },
});

export const install = command({
  meta: {
    name: 'install',
    description: `执行计划（--target：${TARGET_IDS.join(' / ')}）`,
  },
  args: {
    dir: { type: 'positional', required: false, default: '.' },
    'dry-run': { type: 'boolean', default: false },
    'allow-exec': { type: 'boolean', default: false },
    overwrite: { type: 'boolean', default: false, description: '允许覆盖别的包写过的文件' },
    target: { type: 'string', default: 'dir', description: `${TARGET_IDS.join(' | ')}` },
    json: { type: 'boolean', default: false, description: '输出结构化结果（脚本用）' },
  },
  async run({ args }) {
    const ctx = loadPack(String(args.dir));
    if (reportIssues(ctx.issues)) stop(EXIT.USAGE);
    const target = String(args.target ?? 'dir');
    const { plan: p, issues } = planFor(ctx, { target: target as never });
    if (!p) {
      reportIssues(issues);
      stop(EXIT.USAGE);
    }
    const result = await installPack(ctx, p, {
      dryRun: Boolean(args['dry-run']),
      allowExec: Boolean(args['allow-exec']),
      overwrite: Boolean(args.overwrite),
    });
    if (!args.json) {
      for (const o of result.outcomes) {
        const mark = o.status === 'failed' ? 'x' : o.status === 'skipped' ? '-' : '✓';
        say(`${mark} ${o.actionId.padEnd(16)} ${o.status.padEnd(14)} ${o.message ?? o.target ?? ''}`);
      }
    }
    if (result.outcomes.some((o) => o.status === 'failed')) {
      if (args.json) {
        json({ planHash: p.planHash, outcomes: result.outcomes, rolledBack: result.rolledBack ?? false });
      } else if (result.rolledBack) {
        problemRaw('\n有动作失败，已按快照回滚：磁盘回到安装前，state 未写入。');
      }
      stop(EXIT.RUNTIME);
    }
    if (!args['dry-run']) {
      if (args.json) {
        json({ planHash: p.planHash, outcomes: result.outcomes, statePath: result.statePath });
      } else {
        say(`\nstate: ${result.statePath}`);
      }
      // 审计写入留在命令层，不搬进 runtime 的安装入口：
      // 1) installPack 还被 launcher（create / update）与 runner 调用，搬进
      //    applyPlan / installPack 会让它们凭空多出审计行，属于副作用扩展；
      // 2) action 标签（install / add / update）本来就是各命令自己的事，runtime 不知道；
      // 3) 这里只在「非 dry-run、没有失败、state 已落盘」之后写，dry-run 与回滚路径不写，
      //    写失败只 warn 不阻断（TRU-11）。
      try {
        appendAudit({
          action: 'install',
          pack: p.pack.name,
          version: p.pack.version,
          planHash: p.planHash,
          ok: true,
          root: resolve(String(args.dir)),
        });
      } catch (err) {
        warn(`审计写入失败：${(err as Error).message}`);
      }
    }
  },
});

export const verify = command({
  meta: { name: 'verify', description: '跑 manifest 的检查；在项目根跑时用 state 里的计划快照' },
  args: {
    dir: { type: 'positional', required: false, default: '.' },
    target: { type: 'string', default: 'dir', description: `${TARGET_IDS.join(' | ')}` },
    pack: { type: 'string', description: '只验某个已装的包（name@version）' },
    json: { type: 'boolean', default: false, description: '输出结构化结果（脚本用）' },
  },
  async run({ args }) {
    // 走项目模式还是 Pack 模式、各自调用什么、失败怎么计数，都在 runtime 的 verifyAt 里判
    const res = await verifyAt(String(args.dir), {
      ...(args.pack ? { pack: String(args.pack) } : {}),
      target: String(args.target ?? 'dir') as TargetId,
    });
    if (res.issues.length > 0) reportIssues(res.issues);
    // 清单坏了 / 算不出计划：前置条件错，落到退出码 2
    if (!res.ready) stop(EXIT.USAGE);

    if (res.mode === 'installed') {
      if (!args.json) {
        for (const report of res.installed) {
          say(`\n${report.pack}`);
          say(`  planHash ${report.planHash}`);
          for (const r of report.results) {
            const mark = r.status === 'pass' ? '✓' : r.status === 'fail' ? 'x' : '-';
            say(`  ${mark} [${r.index}] ${r.type.padEnd(18)} ${r.status.padEnd(8)} ${r.detail}`);
          }
        }
        say(`\n${res.installed.length} 个包：${res.failed} 项失败 / ${res.skipped} 项跳过`);
      } else {
        json({ installed: res.installed, results: res.results, failed: res.failed, skipped: res.skipped });
      }
      if (res.failed) stop(EXIT.RUNTIME);
      return;
    }

    if (args.json) {
      json({ planHash: res.planHash, results: res.results, failed: res.failed, skipped: res.skipped });
    } else {
      for (const r of res.results) {
        const mark = r.status === 'pass' ? '✓' : r.status === 'fail' ? 'x' : '-';
        say(`${mark} [${r.index}] ${r.type.padEnd(18)} ${r.status.padEnd(8)} ${r.detail}`);
      }
      say(
        `\n${res.results.length} 项：${res.results.length - res.failed - res.skipped} 通过 / ${res.failed} 失败 / ${res.skipped} 跳过`,
      );
    }
    if (res.failed) stop(EXIT.RUNTIME);
  },
});

export const lock = command({
  meta: { name: 'lock', description: '解析引用（npm/github/https/pypi）并生成 packhub.lock.json（只记引用与完整性）' },
  args: {
    dir: { type: 'positional', required: false, default: '.' },
    offline: { type: 'boolean', default: false, description: '不联网：只解析本地引用，其余原样写进锁并给 warning' },
    json: { type: 'boolean', default: false, description: '输出锁与 contentHash（脚本用）' },
  },
  async run({ args }) {
    const dir = resolve(String(args.dir));
    const ctx = loadPack(dir);
    if (reportIssues(ctx.issues)) stop(EXIT.USAGE);
    const res = await lockPack(ctx, {
      offline: Boolean(args.offline),
    });
    const out = join(ctx.dir, 'packhub.lock.json');
    writeFileSync(out, JSON.stringify(res.lock, null, 2) + '\n', 'utf8');
    if (args.json) {
      json({ out, lock: res.lock, contentHash: res.lock.contentHash, warnings: res.warnings });
    } else {
      for (const w of res.warnings) warn(w);
      const withHash = res.lock.resolved.filter((r) => r.integrity).length;
      say(`written ${out}`);
      say(`contentHash ${res.lock.contentHash.slice(0, 26)}…`);
      say(`${res.lock.resolved.length} 个引用，${withHash} 个带 integrity`);
    }
  },
}, { code: EXIT.USAGE });

export const init = command({
  meta: { name: 'init', description: '脚手架一个空 Pack' },
  args: {
    dir: { type: 'positional', required: false, default: '.' },
    name: { type: 'string', required: true },
  },
  run({ args }) {
    const dir = resolve(String(args.dir));
    const file = join(dir, 'packhub.yaml');
    const name = String(args.name);
    if (!PACK_NAME_PATTERN.test(name)) {
      problemRaw(`--name 要写成 owner/name（小写字母、数字、连字符，两段各至少一个字符）：收到 ${name}`);
      stop(EXIT.USAGE);
    }
    if (existsSync(file)) {
      problemRaw(`已存在：${file}`);
      stop(EXIT.RUNTIME);
    }
    mkdirSync(join(dir, 'resources'), { recursive: true });
    const template = `# yaml-language-server: $schema=https://raw.githubusercontent.com/lvlc233/PackHub/main/schema/packhub.v0.schema.json
apiVersion: packhub.dev/v0
kind: Pack

metadata:
  name: ${name}
  version: 0.0.1
  title: 未命名整合包
  description: 一句话说清这个 Pack 替使用者完成了哪些整合工作。
  targets: [dir]
  # public 才能进公共 registry；unlisted 可直链分发，internal/private 不发布
  visibility: private

requires:
  packhub: ">=0.0.1 <0.1"

resources:
  - id: example-knowledge
    type: knowledge
    source: ./resources/example.md
    # provides: [knowledge:your_thing]   # 只有需要被别的资源依赖时才写

verify:
  - type: file-exists
    path: "\${target.knowledgeDir}/example.md"
`;
    writeFileSync(file, template, 'utf8');
    writeFileSync(join(dir, 'resources', 'example.md'), '# 示例知识\n\n替换成真实内容。\n', 'utf8');
    const gitignore = join(dir, '.gitignore');
    if (!existsSync(gitignore)) {
      writeFileSync(gitignore, '.packhub/\npack.phub\npackhub.key\n*.tar.gz\n', 'utf8');
    }
    say(`created ${file}`);
    say('下一步：packhub resource add <type> <source> 追加资源，然后 packhub plan 看动作');
    say('要发布到公共 registry 时，把 metadata.visibility 改成 public（或 unlisted 直链分发）');
  },
});

export const rollback = command({
  meta: { name: 'rollback', description: '退回上一次安装之前的状态' },
  args: {
    dir: { type: 'positional', required: false, default: '.' },
    generation: { type: 'string', description: '指定 generation（默认最近一次）' },
    json: { type: 'boolean', default: false },
  },
  run({ args }) {
    const dir = resolve(String(args.dir));
    const res = rollbackPack(dir, args.generation ? String(args.generation) : undefined);
    if (args.json) {
      json(res);
      return;
    }
    say(`回退 ${res.generation}`);
    for (const r of res.restored) say(`  ↩ ${r}`);
    for (const r of res.removed) say(`  × ${r}`);
    say(`\n恢复 ${res.restored.length} 个文件，删除 ${res.removed.length} 个新建文件`);
  },
});

export const versions = command({
  meta: { name: 'versions', description: '列出已装版本目录与当前激活版本' },
  args: {
    dir: { type: 'positional', required: false, default: '.' },
    pack: { type: 'positional', required: false, description: '只看这个包（name）' },
    json: { type: 'boolean', default: false },
  },
  run({ args }) {
    const list = listVersions(resolve(String(args.dir)), args.pack ? String(args.pack) : undefined);
    if (args.json) {
      json(list);
      return;
    }
    if (list.length === 0) {
      say('没有已暂存的版本');
      return;
    }
    for (const v of list) {
      const mark = v.active ? '●' : '○';
      const health = v.failed > 0 ? ` · ${v.failed} 个失败动作` : '';
      say(
        `${mark} ${`${v.pack}@${v.version}`.padEnd(40)} ${v.target.padEnd(12)} ${String(v.files).padStart(3)} 文件 · ${v.actions} 动作${health}  ${v.installedAt.slice(0, 19)}`,
      );
    }
    say('\n● 表示当前激活；用 packhub activate <name>@<version> 切换');
  },
});

export const activate = command({
  meta: { name: 'activate', description: '把同一个包已暂存的某个版本挂到项目上' },
  args: {
    ref: { type: 'positional', required: true, description: 'name@version' },
    dir: { type: 'positional', required: false, default: '.' },
    json: { type: 'boolean', default: false },
    'no-verify': { type: 'boolean', default: false, description: '切换后不跑 doctor / verify' },
  },
  async run({ args }) {
    const parsed = parsePackRef(String(args.ref));
    if (!parsed) {
      problemRaw('用法：packhub activate <name>@<version>');
      stop(EXIT.USAGE);
    }
    const { name: pack, version } = parsed;
    const dir = resolve(String(args.dir));
    const res = await activatePack(dir, pack, version);
    if (!args.json) {
      say(`激活 ${res.to}${res.from ? `（原 ${res.from}）` : ''}`);
      for (const r of res.removed) say(`  × ${r}`);
      say(`\n铺开 ${res.written.length} 个路径；配置与指令块已按这个版本重放`);
    }

    // 切换完立刻复核：state/active/文件是否一致，只读校验有没有失败
    let doctor: ReturnType<typeof doctorPack> | undefined;
    let reports: Awaited<ReturnType<typeof verifyInstalled>> = [];
    if (!args['no-verify']) {
      doctor = doctorPack(dir);
      reports = await verifyInstalled(dir, {
        pack: `${pack}@${version}`,
        types: [...SAFE_CHECKS],
      });
      const bad = reports.filter((r) => !r.ok);
      if (!args.json) {
        say(`\n检查：${doctor.ok ? '✓ 文件与激活指针一致' : `x ${doctor.findings.length} 个漂移`}`);
        for (const r of reports) {
          const fails = r.results.filter((x) => x.status === 'fail').length;
          say(`校验 ${r.pack}：${r.ok ? '通过' : `${fails} 项失败`}`);
        }
      }
      if (!doctor.ok || bad.length > 0) {
        if (args.json) json({ ...res, doctor, verify: reports });
        problemRaw('切换完成，但检查没过；可用 packhub rollback 退回，或修完再试。');
        stop(EXIT.RUNTIME);
      }
    }
    if (args.json) {
      json(doctor ? { ...res, doctor, verify: reports } : res);
    }
  },
});

export const uninstall = command({
  meta: { name: 'uninstall', description: '按 state 反向删除已装的文件' },
  args: {
    dir: { type: 'positional', required: false, default: '.' },
    pack: { type: 'string', description: '只卸载这个包（name@version）' },
    json: { type: 'boolean', default: false },
  },
  run({ args }) {
    const dir = resolve(String(args.dir));
    const key = args.pack ? String(args.pack) : undefined;
    const res = removePack(dir, key);
    if (args.json) {
      json(res);
      return;
    }
    if (res.removed.length === 0 && res.kept.length === 0) {
      say('没有可卸载的记录（state 里没有这个包）');
      return;
    }
    for (const r of res.removed) say(`  - ${r}`);
    for (const r of res.kept) say(`  = 保留 ${r}（还有别的包在用）`);
    say(`\n移除 ${res.removed.length} 个路径，涉及 ${res.packs.length} 个包`);
  },
});

export const diff = command({
  meta: { name: 'diff', description: '对比已安装的计划快照与当前清单现算的计划' },
  args: {
    dir: { type: 'positional', required: false, default: '.' },
    check: { type: 'boolean', default: false, description: '有差异就以非零码退出（CI 用）' },
    target: { type: 'string', description: '默认沿用安装时记录的 target' },
  },
  async run({ args }) {
    const dir = resolve(String(args.dir));
    const read = loadLock(dir);
    if (!read.lock) {
      if (read.problem) {
        reportIssues([read.problem]);
      } else {
        problemRaw('没有 packhub.lock.json：先跑 packhub lock');
      }
      stop(EXIT.USAGE);
    }
    const lock = read.lock;
    const ctx = withLockPins(loadPack(dir), lock);
    if (reportIssues(ctx.issues)) stop(EXIT.USAGE);
    // 旧计划快照只在 state 里（锁只描述内容，不存任何 target 的计划）。
    // 没有安装记录就直说没装——作者还没安装时想看计划应该用 packhub plan。
    const pack = ctx.manifest.metadata.name;
    const state = loadState(dir);
    const key = Object.keys(state.packs).find((k) => (k.split('@')[0] ?? '') === pack);
    const snapshot = key ? state.packs[key]?.plan : undefined;
    if (!snapshot) {
      problemRaw(
        `这个包还没装：state 里没有 ${pack} 的安装计划快照；先 packhub add 装上再 diff`,
      );
      stop(EXIT.USAGE);
    }
    // 按安装时的 target 现算计划；显式 --target 可以看别的 target 会多/少什么
    const target = String(args.target ?? snapshot.target);
    const { plan, issues } = planFor(ctx, { target: target as never });
    if (!plan) {
      reportIssues(issues, 'packhub diff');
      stop(EXIT.USAGE);
    }
    // 「锁 ↔ 清单」是否一致仍走 kernel 的单点判定；它回答的是内容有没有被改过
    const lockCheck = checkLockConsistency(lock, ctx.manifest);
    const { added, removed } = diffActions(snapshot.actions, plan.actions);
    const actionsSame = added.length === 0 && removed.length === 0;
    if (actionsSame && snapshot.planHash === plan.planHash && lockCheck.status === 'ok') {
      say('计划无变化');
      return;
    }

    say(
      `planHash ${snapshot.planHash.slice(0, 22)}… → ${plan.planHash.slice(0, 22)}…（已装 ${snapshot.target} / 现算 ${plan.target}）`,
    );
    for (const a of removed) say(`  - ${describeAction(a)}`);
    for (const a of added) say(`  + ${describeAction(a)}`);
    if (actionsSame && snapshot.planHash !== plan.planHash) {
      say('动作没变，但计划里的 verify / excluded 变了（planHash 随之变）');
    }
    if (lockCheck.status !== 'ok') warn(lockCheck.message);
    say(`\n${added.length} 条新增 / ${removed.length} 条移除；锁过期就重跑 packhub lock，内容变了要重新安装`);
    if (args.check) stop(EXIT.RUNTIME);
  },
});
