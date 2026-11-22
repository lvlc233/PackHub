// 由 cli.ts 拆分：plan / verify / lock / init / rollback / uninstall / diff。
// install 在 install.ts：它要处理多种来源（目录 / .phub / registry / git+https），
// 比这几条「就地看一个目录」的命令重。
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { EXIT, command, json, problemRaw, say, sayUnless, stop, warn } from '../emit.ts';
import {
  loadPack,
  planFor,
  describeComposition,
  diffActions,
  describeAction,
  checkLockConsistency,
  LOCK_FILE,
  MANIFEST_FILE,
  PACK_NAME_PATTERN,
  STATE_DIR,
  TARGET_IDS,
  type TargetId,
} from '@packhub/kernel';
import {
  doctorPack,
  removePack,
  rollbackPack,
  verifyAt,
  loadLock,
  withLockPins,
  loadState,
  lockPack,
  probeHarness,
  probeSkill,
  type HarnessTarget,
} from '@packhub/runtime';
import { reportIssues, printPlan, loadPackWithPick } from './shared.ts';

export const plan = command({
  meta: { name: 'plan', description: '解析 Pack 并打印安装计划（不落盘）' },
  args: {
    dir: { type: 'positional', required: false, default: '.' },
    json: { type: 'boolean', default: false },
    target: { type: 'string', default: 'dir', description: `${TARGET_IDS.join(' | ')}` },
    pick: {
      type: 'string',
      description: '本次覆盖角色实现：role=resource[,role=resource]（只影响这次运行，不写回清单）',
    },
  },
  run({ args }) {
    const ctx = loadPackWithPick(String(args.dir), args.pick === undefined ? undefined : String(args.pick));
    if (reportIssues(ctx.issues)) stop(EXIT.USAGE);
    const { plan: p, issues } = planFor(ctx, { target: String(args.target ?? 'dir') as never });
    if (!p) {
      reportIssues(issues);
      stop(EXIT.USAGE);
    }
    // 接线从清单现算，不进计划、不落盘：plan 打印它，--json 原样带上
    const wiring = describeComposition(ctx);
    if (args.json) json({ ...p, wiring });
    else printPlan(p, wiring);
  },
});

/** 探针能跑的宿主；检查段另有 dir 这一项，两边取交集之外的要单独判。 */
const PROBE_TARGETS = ['dsh', 'claude-code', 'opencode', 'codex'] as const;

function isProbeTarget(value: string): value is HarnessTarget {
  return (PROBE_TARGETS as readonly string[]).includes(value);
}

export const verify = command({
  meta: {
    name: 'verify',
    description: '体检一个目录：已装文件有没有被外部改写（漂移）+ 清单里的检查；--probe 再跑一次真机',
  },
  args: {
    dir: { type: 'positional', required: false, default: '.', description: '要体检的目录（项目根或 Pack 目录）' },
    target: {
      type: 'string',
      default: 'dir',
      description: `${TARGET_IDS.join(' | ')}（检查段用；--probe 时按宿主名，dir 视为 dsh）`,
    },
    pack: { type: 'string', description: '检查段只验某个已装的包（name@version）' },
    probe: {
      type: 'boolean',
      default: false,
      description: '再跑一次真机探针：看宿主有没有真读到包写进去的指令',
    },
    patch: { type: 'string', description: 'dsh 的 --patch 层（配置 provider / 模型；配合 --probe）' },
    skill: {
      type: 'string',
      description: '改问技能选择器：断言这个 skill 名出现在可用列表里（配合 --probe）',
    },
    json: { type: 'boolean', default: false, description: '输出结构化结果（漂移与检查两段都在）' },
  },
  async run({ args }) {
    const dir = resolve(String(args.dir));
    const rawTarget = String(args.target ?? 'dir');
    const checksTarget = (TARGET_IDS as readonly string[]).includes(rawTarget)
      ? (rawTarget as TargetId)
      : undefined;
    // 检查段只认 TARGET_IDS；探针段只认宿主名。两边都不认的 target 直接当参数错。
    if (!checksTarget && !isProbeTarget(rawTarget)) {
      problemRaw(`未知 target：${rawTarget}（检查段可选 ${TARGET_IDS.join(' / ')}；探针还可以是 ${PROBE_TARGETS.join(' / ')}）`);
      stop(EXIT.USAGE);
    }
    if (!checksTarget && !args.probe) {
      problemRaw(`${rawTarget} 只能给探针用：加 --probe，或把 --target 换成 ${TARGET_IDS.join(' / ')}`);
      stop(EXIT.USAGE);
    }
    const sayLine = sayUnless(Boolean(args.json));

    // —— 段一：漂移。state 里记下的已装产物 vs 磁盘现状（原 doctor 的目录模式）——
    const drift = doctorPack(dir);
    sayLine('漂移：已装记录 vs 磁盘');
    if (drift.packs.length === 0) {
      sayLine('  这个目录没有装任何包');
    } else if (drift.ok) {
      sayLine(`  ✓ ${drift.packs.length} 个包全部在位`);
    } else {
      for (const f of drift.findings) {
        sayLine(`  x ${f.pack}`);
        for (const b of f.blocksMissing) sayLine(`      托管块不见了：${b}（可能被宿主工具重新生成覆盖）`);
        for (const m of f.filesMissing) sayLine(`      文件不见了：${m}`);
        for (const c of f.configDrift) sayLine(`      配置被改：${c}`);
        for (const a of f.activeDrift) sayLine(`      激活指针不一致：${a}`);
        for (const s of f.stateMissing) sayLine(`      状态目录不见了：${s}`);
        for (const m of f.mcpMissing) sayLine(`      MCP 不见了：${m}`);
      }
      sayLine('  重新 install 可以补回缺失的块；宿主会自动重写的指令文件，把 PackHub 的块当成「会被覆盖」的内容对待。');
    }

    // —— 段二：检查。走项目模式还是 Pack 模式、失败怎么计数，都在 runtime 的 verifyAt 里判 ——
    const res = await verifyAt(dir, {
      ...(args.pack ? { pack: String(args.pack) } : {}),
      ...(checksTarget ? { target: checksTarget } : {}),
    });
    if (res.issues.length > 0) reportIssues(res.issues);
    sayLine('');
    sayLine('检查：清单里的 verify 项');
    if (!res.ready) {
      sayLine('  跳过（清单或计划有问题，见上面的错误）');
    } else if (res.mode === 'installed') {
      for (const report of res.installed) {
        sayLine(`  ${report.pack}`);
        sayLine(`    planHash ${report.planHash}`);
        for (const r of report.results) {
          const mark = r.status === 'pass' ? '✓' : r.status === 'fail' ? 'x' : '-';
          sayLine(`    ${mark} [${r.index}] ${r.type.padEnd(18)} ${r.status.padEnd(8)} ${r.detail}`);
        }
      }
      sayLine(`  ${res.installed.length} 个包：${res.failed} 项失败 / ${res.skipped} 项跳过`);
    } else {
      for (const r of res.results) {
        const mark = r.status === 'pass' ? '✓' : r.status === 'fail' ? 'x' : '-';
        sayLine(`  ${mark} [${r.index}] ${r.type.padEnd(18)} ${r.status.padEnd(8)} ${r.detail}`);
      }
      sayLine(
        `  ${res.results.length} 项：${res.results.length - res.failed - res.skipped} 通过 / ${res.failed} 失败 / ${res.skipped} 跳过`,
      );
    }

    // —— 段三：真机探针。声明式检查证明不了「宿主真读过」，只有跑一次才知道 ——
    let probe: Awaited<ReturnType<typeof probeHarness>> | undefined;
    if (args.probe) {
      const probeTarget = rawTarget === 'dir' ? 'dsh' : rawTarget;
      if (!isProbeTarget(probeTarget)) {
        problemRaw(`未知探针 target：${probeTarget}（可选 ${PROBE_TARGETS.join(' / ')}）`);
        stop(EXIT.USAGE);
      }
      probe = args.skill
        ? probeSkill({ target: probeTarget, projectDir: dir, skill: String(args.skill) })
        : probeHarness({
            target: probeTarget,
            projectDir: dir,
            ...(args.patch ? { patchFile: resolve(String(args.patch)) } : {}),
          });
      sayLine('');
      sayLine(`探针：${probeTarget}`);
      sayLine(probe.ok ? '  ✓ 宿主读到了托管块' : '  x 没读到');
      sayLine(`  命令：${probe.command}`);
      if (probe.marker) sayLine(`  期望标记：${probe.marker}`);
      if (probe.answer) sayLine(`  回答：${probe.answer.replace(/\s+/g, ' ').slice(0, 200)}`);
      if (probe.reason) sayLine(`  原因：${probe.reason}`);
    }

    if (args.json) {
      json({
        drift,
        checks: res.ready
          ? {
              mode: res.mode,
              planHash: res.planHash,
              installed: res.installed,
              results: res.results,
              failed: res.failed,
              skipped: res.skipped,
            }
          : { ready: false, issues: res.issues },
        ...(probe ? { probe } : {}),
      });
    }

    // 清单坏了 / 算不出计划是前置条件错（2）；漂移、检查、探针没过都是运行失败（1）
    if (!res.ready) stop(EXIT.USAGE);
    if (!drift.ok || res.failed > 0 || (probe && !probe.ok)) stop(EXIT.RUNTIME);
  },
});

export const lock = command({
  meta: { name: 'lock', description: `解析引用（npm/github/https/pypi）并生成 ${LOCK_FILE}（只记引用与完整性）` },
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
    const out = join(ctx.dir, LOCK_FILE);
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
    const file = join(dir, MANIFEST_FILE);
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
  # public 才能进公共 registry；unlisted 可直链分发，internal/private 不发布
  visibility: private

requires:
  packhub: ">=0.0.1 <0.1"

resources:
  - id: example-knowledge
    type: knowledge
    source: ./resources/example.md
    # provides: [content/example@1]   # 能力令牌 <form>/<name>@<major>；只有要提供给别人时才写
`;
    writeFileSync(file, template, 'utf8');
    writeFileSync(join(dir, 'resources', 'example.md'), '# 示例知识\n\n替换成真实内容。\n', 'utf8');
    const gitignore = join(dir, '.gitignore');
    if (!existsSync(gitignore)) {
      writeFileSync(gitignore, `${STATE_DIR}/\npack.phub\npackhub.key\n*.tar.gz\n`, 'utf8');
    }
    say(`created ${file}`);
    say('下一步：packhub resource add <type> <source> 追加资源，然后 packhub plan 看动作');
    say(
      '能力写进 provides / needs，令牌是 <form>/<name>@<major>（tool / skill / content / config）；安装顺序由 needs 派生，没有 dependsOn',
    );
    say('要发布到公共 registry 时，把 metadata.visibility 改成 public（或 unlisted 直链分发）');
    say('verify 不是必填：只写程序自己查不了的事——宿主真读到、MCP 真起来、命令真跑通');
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
        problemRaw(`没有 ${LOCK_FILE}：先跑 packhub lock`);
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
      problemRaw(`这个包还没装：state 里没有 ${pack} 的安装计划快照；先 packhub install 装上再 diff`);
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
