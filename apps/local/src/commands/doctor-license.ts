// 由 cli.ts 拆分：audit / doctor / licenses
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { EXIT, command, json, orStop, say, stop } from '../emit.ts';
import { loadPack } from '@packhub/kernel';
import {
  inspectLicenses,
  evaluateLicense,
  npmLicense,
  type LicensePolicy,
  doctorPack,
  doctorGlobal,
  auditPath,
  readAudit,
  resolveSyncTargets,
} from '@packhub/runtime';
import { reportIssues } from './shared.ts';

export const audit = command({
  meta: { name: 'audit', description: '看本机的安装审计（add / install / update）' },
  args: {
    tail: { type: 'string', default: '20', description: '只看最近 N 条' },
    json: { type: 'boolean', default: false },
  },
  run({ args }) {
    const entries = readAudit(Number(args.tail) || 20);
    if (args.json) {
      json(entries);
      return;
    }
    if (entries.length === 0) {
      say(`还没有审计记录：${auditPath()}`);
      return;
    }
    for (const e of entries) {
      say(
        `${e.at.slice(0, 19)}  ${e.action.padEnd(8)} ${`${e.pack ?? ''}@${e.version ?? ''}`.padEnd(34)} ${e.ok === false ? 'x' : '✓'}  ${e.planHash?.slice(0, 14) ?? ''}`,
      );
    }
    say(`\n${auditPath()}`);
  },
});

export const doctor = command({
  meta: { name: 'doctor', description: '检查已装的包有没有被外部改写（文件被删、托管块被吃）' },
  args: {
    dir: { type: 'positional', required: false, default: '.' },
    json: { type: 'boolean', default: false },
    global: { type: 'boolean', default: false, description: '检查全局 harness' },
    targets: {
      type: 'string',
      default: '.',
      description: '全局检查目标，逗号分隔；. 表示全部已注册',
    },
  },
  run({ args }) {
    if (args.global) {
      const targets = orStop(() => resolveSyncTargets(String(args.targets)));
      const results = doctorGlobal(targets);
      // skipped 是「这个 harness 没装」，不是失败；只有真读过状态却不 ok 才算失败
      const failed = results.some((r) => !r.skipped && (r.error !== undefined || !r.report?.ok));
      if (args.json) {
        json(results);
        if (failed) stop(EXIT.RUNTIME);
        return;
      }
      for (const r of results) {
        say(`\n${r.target} ${r.root}`);
        if (r.skipped) {
          say('  - 跳过：没有这个 harness 的 home');
          continue;
        }
        if (r.error) {
          say(`  x ${r.error}`);
          continue;
        }
        if (!r.report || r.report.packs.length === 0) {
          say('  没有同步过包');
          continue;
        }
        if (r.report.ok) {
          say(`  ✓ ${r.report.packs.length} 个包全部在位`);
          continue;
        }
        for (const f of r.report.findings) {
          say(`  x ${f.pack}`);
          for (const m of f.filesMissing) say(`      文件不见了：${m}`);
          for (const b of f.blocksMissing) say(`      托管块不见了：${b}`);
          for (const c of f.configDrift) say(`      配置被改：${c}`);
          for (const a of f.activeDrift) say(`      激活指针不一致：${a}`);
          for (const s of f.stateMissing) say(`      状态目录不见了：${s}`);
          for (const m of f.mcpMissing) say(`      MCP 不见了：${m}`);
        }
      }
      if (failed) stop(EXIT.RUNTIME);
      return;
    }
    const report = doctorPack(resolve(String(args.dir)));
    if (args.json) {
      json(report);
      if (!report.ok) stop(EXIT.RUNTIME);
      return;
    }
    if (report.packs.length === 0) {
      say('这个目录没有装任何包');
      return;
    }
    say(`检查 ${report.packs.length} 个包`);
    for (const f of report.findings) {
      say(`x ${f.pack}`);
      for (const b of f.blocksMissing) say(`    托管块不见了：${b}（可能被宿主工具重新生成覆盖）`);
      for (const m of f.filesMissing) say(`    文件不见了：${m}`);
      for (const c of f.configDrift) say(`    配置被改：${c}`);
      for (const a of f.activeDrift) say(`    激活指针不一致：${a}`);
      for (const s of f.stateMissing) say(`    状态目录不见了：${s}`);
      for (const m of f.mcpMissing) say(`    MCP 不见了：${m}`);
    }
    if (report.ok) {
      say('✓ 全部在位');
    } else {
      say('\n重新 install 可以补回缺失的块；如果宿主会自动重写指令文件，把 PackHub 的块当成"会被覆盖"的内容对待。');
      stop(EXIT.RUNTIME);
    }
  },
});

export const licenses = command({
  meta: { name: 'licenses', description: '列出每个资源的许可证情况，并可按策略判定' },
  args: {
    dir: { type: 'positional', required: false, default: '.' },
    strict: { type: 'boolean', default: false, description: '缺许可证就以非零码退出' },
    deny: { type: 'string', description: '拒绝的 SPDX 列表（逗号分隔），命中就失败' },
    online: { type: 'boolean', default: false, description: '远程 npm 资源也查 registry 的 license 字段' },
    policy: { type: 'string', description: '许可策略 JSON：{allow,deny,allowCopyleft,allowNC,allowND,requireSpdx}' },
    json: { type: 'boolean', default: false, description: '输出结构化结果（脚本用）' },
  },
  async run({ args }) {
    const dir = resolve(String(args.dir));
    const ctx = loadPack(dir);
    if (reportIssues(ctx.issues)) stop(EXIT.USAGE);
    const findings = inspectLicenses(dir, ctx.manifest);

    if (args.online) {
      for (const f of findings) {
        if (f.vendored || !f.source.startsWith('npm:')) continue;
        try {
          const license = await npmLicense(f.source);
          if (license) {
            f.spdx = license;
            f.file = 'npm registry license';
          }
        } catch {
          /* 查不到就保持未知，策略决定是否拦 */
        }
      }
    }

    let policy: LicensePolicy | undefined;
    if (args.policy) {
      policy = orStop(
        () => JSON.parse(readFileSync(resolve(String(args.policy)), 'utf8')) as LicensePolicy,
        { line: (err) => `许可策略读不了：${(err as Error).message}` },
      );
    }
    const denied = new Set(
      String(args.deny ?? '')
        .split(',')
        .map((s) => s.trim().toUpperCase())
        .filter(Boolean),
    );

    let missing = 0;
    let blocked = 0;
    const rows: {
      resource: string;
      source: string;
      vendored: boolean;
      spdx: string | undefined;
      file: string | undefined;
      ok: boolean;
      reason?: string;
    }[] = [];
    for (const f of findings) {
      if (!f.vendored && !f.spdx) {
        rows.push({
          resource: f.resource,
          source: f.source,
          vendored: f.vendored,
          spdx: f.spdx,
          file: f.file,
          ok: true,
          reason: '远程来源，加 --online 可查 npm license',
        });
        continue;
      }
      const verdict = policy
        ? evaluateLicense(f.spdx, policy)
        : evaluateLicense(f.spdx, {
            allowCopyleft: true,
            allowNC: true,
            allowND: true,
            ...(denied.size ? { deny: [...denied] } : {}),
          });
      if (f.vendored && !f.file) {
        missing++;
        rows.push({
          resource: f.resource,
          source: f.source,
          vendored: f.vendored,
          spdx: f.spdx,
          file: f.file,
          ok: false,
          reason: '没有 LICENSE/COPYING',
        });
        continue;
      }
      if (!verdict.ok) blocked++;
      rows.push({
        resource: f.resource,
        source: f.source,
        vendored: f.vendored,
        spdx: f.spdx,
        file: f.file,
        ok: verdict.ok,
        ...(verdict.ok ? {} : { reason: verdict.reason }),
      });
    }
    if (args.json) {
      json({ findings: rows, missing, blocked, ok: blocked === 0 });
    } else {
      for (const f of rows) {
        if (!f.vendored && !f.spdx) {
          say(`- ${f.resource.padEnd(20)} 远程（加 --online 可查 npm license）`);
        } else if (!f.ok) {
          say(`x ${f.resource.padEnd(20)} ${f.spdx ?? '未知'} · ${f.file ?? f.source}（${f.reason ?? ''}）`);
        } else {
          say(`✓ ${f.resource.padEnd(20)} ${f.spdx ?? '未知'} · ${f.file ?? f.source}`);
        }
      }
      if (missing > 0) {
        say(`\n${missing} 个 vendored 资源缺少许可证文件；不确定能不能再分发时先去上游确认`);
      }
      if (blocked > 0) say(`\n${blocked} 个资源未通过许可策略`);
    }
    if (blocked > 0) stop(EXIT.RUNTIME);
    if (missing > 0 && args.strict) stop(EXIT.RUNTIME);
  },
});
