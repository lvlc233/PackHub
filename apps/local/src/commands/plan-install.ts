// 由 cli.ts 拆分：plan / verify / lock / init。
//
// 装到项目里归 pal：packhub 只做「生产」（清单、锁、打包、发布、签名）。
// 所以 verify 在这里只验 Pack 目录（清单 + 计划派生检查），不碰已安装项目的 state 与漂移。
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { EXIT, command, json, problemRaw, say, sayUnless, stop, warn } from '../emit.ts';
import {
  loadPack,
  planFor,
  describeComposition,
  HARNESS_IDS,
  LOCK_FILE,
  MANIFEST_FILE,
  PACK_NAME_PATTERN,
  STATE_DIR,
} from '@packhub/kernel';
import { verifyAt, lockPack, probeHarness, probeSkill } from '@packhub/runtime';
import { parseHarness, reportIssues, printPlan } from './shared.ts';

export const plan = command({
  meta: { name: 'plan', description: '解析 Pack 并打印安装计划（不落盘）' },
  args: {
    dir: { type: 'positional', required: false, default: '.' },
    json: { type: 'boolean', default: false },
    harness: {
      type: 'string',
      description: `预览参数：按哪个宿主的落点表算计划（${HARNESS_IDS.join(' / ')}）；不写 = 平铺目录；真正安装用 pal install`,
    },
  },
  run({ args }) {
    const ctx = loadPack(String(args.dir));
    if (reportIssues(ctx.issues)) stop(EXIT.USAGE);
    const harness = parseHarness(args.harness === undefined ? undefined : String(args.harness));
    const { plan: p, issues } = planFor(ctx, harness ? { harness } : {});
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

export const verify = command({
  meta: {
    name: 'verify',
    description:
      '体检一个 Pack 目录：清单检查 + 从计划派生的检查（知识文件哈希等）；--probe 再跑一次真机，--probe-mcp 逐个握手 MCP；不碰已安装项目',
  },
  args: {
    dir: { type: 'positional', required: false, default: '.', description: '要体检的 Pack 目录（含清单）' },
    harness: {
      type: 'string',
      description: `检查参数：按哪个宿主的落点表算检查计划（${HARNESS_IDS.join(' / ')}）；不写 = 平铺目录，--probe 时探针默认 dsh`,
    },
    probe: {
      type: 'boolean',
      default: false,
      description: '再跑一次真机探针：看宿主有没有真读到包写进去的指令',
    },
    'probe-mcp': {
      type: 'boolean',
      default: false,
      description: '对计划里每个 MCP server 真发一次 initialize（会起进程 / 联网；不可达记 fail）',
    },
    patch: { type: 'string', description: 'dsh 的 --patch 层（配置 provider / 模型；配合 --probe）' },
    skill: {
      type: 'string',
      description: '改问技能选择器：断言这个 skill 名出现在可用列表里（配合 --probe）',
    },
    json: { type: 'boolean', default: false, description: '输出结构化结果（检查 + 探针两段）' },
  },
  async run({ args }) {
    const dir = resolve(String(args.dir));
    // 只验 Pack 目录：没有清单就直说是别的东西，别去猜「是不是装过包的项目」
    if (!existsSync(join(dir, MANIFEST_FILE))) {
      problemRaw(
        `verify 只验 Pack 目录：${dir} 里没有 ${MANIFEST_FILE}；已安装项目的检查归 pal`,
      );
      stop(EXIT.USAGE);
    }
    const harness = parseHarness(args.harness === undefined ? undefined : String(args.harness));
    const sayLine = sayUnless(Boolean(args.json));

    // 检查 = 清单 verify 项 + 从计划派生的项（知识文件哈希等）；MCP 握手要显式 --probe-mcp
    const res = await verifyAt(dir, {
      ...(harness ? { harness } : {}),
      ...(args['probe-mcp'] ? { probeMcp: true } : {}),
    });
    if (res.issues.length > 0) reportIssues(res.issues);
    sayLine('');
    sayLine('检查：清单 verify 项 + 从计划派生的项');
    if (!res.ready) {
      sayLine('  跳过（清单或计划有问题，见上面的错误）');
    } else {
      for (const r of res.results) {
        const mark = r.status === 'pass' ? '✓' : r.status === 'fail' ? 'x' : '-';
        sayLine(`  ${mark} [${r.index}] ${r.type.padEnd(18)} ${r.status.padEnd(8)} ${r.detail}`);
      }
      sayLine(
        `  ${res.results.length} 项：${res.results.length - res.failed - res.skipped} 通过 / ${res.failed} 失败 / ${res.skipped} 跳过`,
      );
    }

    // —— 探针：声明式检查证明不了「宿主真读过」，只有跑一次才知道 ——
    let probe: Awaited<ReturnType<typeof probeHarness>> | undefined;
    if (args.probe) {
      // 不写 --harness 时探针默认 dsh：平铺目录没有宿主指令面，探针只在宿主上才有意义
      const probeTarget = harness ?? 'dsh';
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
        checks: res.ready
          ? {
              mode: res.mode,
              planHash: res.planHash,
              results: res.results,
              failed: res.failed,
              skipped: res.skipped,
            }
          : { ready: false, issues: res.issues },
        ...(probe ? { probe } : {}),
      });
    }

    // 清单坏了 / 算不出计划是前置条件错（2）；检查、探针没过是运行失败（1）
    if (!res.ready) stop(EXIT.USAGE);
    if (res.failed > 0 || (probe && !probe.ok)) stop(EXIT.RUNTIME);
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
    say('下一步：packhub resource add <type> <source> 追加资源，然后 packhub lock 钉引用');
    say(
      '能力写进 provides / needs，令牌是 <form>/<name>@<major>（tool / skill / content / config）；安装顺序由 needs 派生，没有 dependsOn',
    );
    say('要发布到公共 registry 时，把 metadata.visibility 改成 public（或 unlisted 直链分发）');
    say('verify 不是必填：只写程序自己查不了的事——宿主真读到（scenario）、命令真跑通（command）；MCP 握手用 verify --probe-mcp 自动做');
  },
});
