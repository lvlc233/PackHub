// pal core：常驻核心及其子命令。
import { defineCommand } from 'citty';
import { PACKHUB_ENV } from '@packhub/kernel';
import { isAbsolute, resolve } from 'node:path';
import { PalError, isPalError } from '../errors.ts';
import { ensureCore, probeCore, stopCore } from '../coreClient.ts';
import { DEFAULT_CORE_INTERVAL_MS, startCore } from '../core.ts';
import { coreTaskInstalled, installCoreTask, uninstallCoreTask } from '../coreTask.ts';

function applyHomeArg(value: unknown): void {
  const text = String(value ?? '').trim();
  if (!text) return;
  if (!isAbsolute(text)) {
    throw new PalError('invalid-input', '--home 要绝对路径', { hint: '例如 D:\\PackHubData' });
  }
  process.env[PACKHUB_ENV.home] = resolve(text);
}

export const core = defineCommand({
  meta: {
    name: 'core',
    description: '常驻核心：实例的启停与看护都在它这里；CLI 只是它的客户端',
  },
  subCommands: {
    run: defineCommand({
      meta: { name: 'run', description: '前台跑 core（客户端发现没有 core 会自己拉起，一般不手动跑）' },
      args: {
        port: { type: 'string', default: '0', description: 'core 的接口端口；0 表示让系统挑' },
        interval: {
          type: 'string',
          default: String(DEFAULT_CORE_INTERVAL_MS),
          description: `看护间隔（毫秒），默认 ${DEFAULT_CORE_INTERVAL_MS}`,
        },
        home: { type: 'string', description: '数据目录（计划任务用；不写就按环境变量/location.json）' },
        json: { type: 'boolean', default: false },
      },
      async run({ args }) {
        applyHomeArg(args.home);
        const intervalMs = Number(args.interval);
        if (!Number.isInteger(intervalMs) || intervalMs <= 0) {
          throw new PalError('invalid-input', `--interval 要正整数的毫秒数，收到：${String(args.interval)}`, {
            hint: `默认 ${DEFAULT_CORE_INTERVAL_MS}；例如 pal core run --interval 5000`,
          });
        }
        const started = await startCore({ port: Number(args.port ?? 0), intervalMs }).catch((err: unknown) => {
          // 已经有 core 在跑是正常结局（计划任务与手动启动撞车）：别报错，否则会被反复重起
          if (isPalError(err) && err.code === 'busy') return undefined;
          throw err;
        });
        if (!started) {
          console.log(args.json ? JSON.stringify({ running: true }) : 'PAL core 已经在运行');
          return;
        }
        console.log(
          args.json
            ? JSON.stringify({ url: started.url, pid: process.pid })
            : `PAL core：${started.url}（pid ${process.pid}）`,
        );
        const shutdown = (): void => {
          void started.close().finally(() => process.exit(0));
        };
        process.once('SIGINT', shutdown);
        process.once('SIGTERM', shutdown);
      },
    }),
    start: defineCommand({
      meta: { name: 'start', description: '拉起 core（已经在跑就什么都不做）' },
      args: {
        home: { type: 'string', description: '数据目录（计划任务用；不写就按环境变量/location.json）' },
        json: { type: 'boolean', default: false },
      },
      async run({ args }) {
        applyHomeArg(args.home);
        const info = await ensureCore();
        console.log(
          args.json
            ? JSON.stringify({ pid: info.pid, url: info.url })
            : `PAL core：${info.url}（pid ${info.pid}）`,
        );
      },
    }),
    status: defineCommand({
      meta: { name: 'status', description: 'core 在不在：pid、接口地址、启动时间' },
      args: { json: { type: 'boolean', default: false } },
      async run({ args }) {
        const info = await probeCore();
        const task = process.platform === 'win32' ? coreTaskInstalled() : false;
        if (args.json) {
          console.log(
            JSON.stringify(
              info
                ? { running: true, pid: info.pid, url: info.url, startedAt: info.startedAt, version: info.version, task }
                : { running: false, task },
              null,
              2,
            ),
          );
          return;
        }
        if (!info) {
          console.log('PAL core 没在运行；下一条 pal start / pal stop 会按需拉起它');
        } else {
          console.log(`PAL core  pid ${info.pid}  ${info.url}`);
          console.log(`  起于 ${info.startedAt}  v${info.version}`);
        }
        if (process.platform === 'win32') console.log(`  登录任务：${task ? '已注册' : '未注册（pal core install）'}`);
      },
    }),
    stop: defineCommand({
      meta: {
        name: 'stop',
        description: '停掉 core（实例继续跑，下一次命令会拉起新 core 接管；不动实例进程）',
      },
      async run() {
        await stopCore();
        console.log('✓ 已停掉 PAL core');
      },
    }),
    install: defineCommand({
      meta: { name: 'install', description: '注册登录任务：登录时拉起 core，异常退出由系统任务重起' },
      async run() {
        const task = installCoreTask();
        const info = await ensureCore();
        console.log(`✓ 已注册计划任务：${task.name}`);
        console.log(`  PAL core：${info.url}（pid ${info.pid}）`);
      },
    }),
    uninstall: defineCommand({
      meta: { name: 'uninstall', description: '删掉登录任务（core 本身还在跑，要停用 pal core stop）' },
      async run() {
        const result = uninstallCoreTask();
        console.log(result.removed ? '✓ 已删除计划任务' : '· 计划任务本来就不存在');
      },
    }),
  },
});
