// 由 cli.ts 拆分：audit / licenses。
// 原 doctor 已并入 verify（漂移段），全局漂移随 sync 一起删除（全局落点归 PAL 实例）。
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { EXIT, command, json, orStop, say, stop } from '../emit.ts';
import { loadPack } from '@packhub/kernel';
import {
  inspectLicenses,
  evaluateLicense,
  npmLicense,
  type LicensePolicy,
  auditPath,
  readAudit,
} from '@packhub/runtime';
import { reportIssues } from './shared.ts';

export const audit = command({
  meta: { name: 'audit', description: '看本机的安装审计（install / update）' },
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
