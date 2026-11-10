import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  instanceLock,
  readBaseline,
  requireInstance,
  scanInstances,
  type Baseline,
  type InstanceRecord,
} from './index.ts';
import { isPidAlive } from './process.ts';
import { isPortListening, portOwner } from './port.ts';
import { readMcpServers, DSH_PATCH_FILE } from './mcp.ts';
import { entryOf } from './entries.ts';

export type CheckStatus = 'ok' | 'warn' | 'fail';

export interface HealthCheck {
  name: string;
  status: CheckStatus;
  detail: string;
}

export interface BaselineDrift {
  checked: number;
  missing: string[];
  changed: string[];
  added: string[];
}

export interface InstanceHealth {
  id: string;
  name: string;
  status: InstanceRecord['status'];
  /** 这次运行用的入口；没跑过就没有 */
  entry?: InstanceRecord['entry'];
  ok: boolean;
  checks: HealthCheck[];
  drift?: BaselineDrift;
  mcp?: { servers: number; wired: boolean; file?: string };
}

export interface HealthOptions {
  /** 当前 node 版本；默认 process.version。测试可注入，PAL 只报告不切换 */
  runtime?: string;
}

function hashOf(file: string): string | undefined {
  try {
    return createHash('sha256').update(readFileSync(file)).digest('hex');
  } catch {
    return undefined;
  }
}

/** 基线漂移：Pack 装过的东西还在不在、有没有被本地改过。 */
export function baselineDrift(record: InstanceRecord): BaselineDrift | undefined {
  const baseline = readBaseline(record.root);
  if (!baseline) return undefined;
  return driftFrom(record, baseline);
}

function driftFrom(record: InstanceRecord, baseline: Baseline): BaselineDrift {
  const missing: string[] = [];
  const changed: string[] = [];
  for (const file of baseline.files) {
    const abs = resolve(record.root, file.path);
    if (!existsSync(abs)) {
      missing.push(file.path);
      continue;
    }
    const hash = hashOf(abs);
    if (hash && hash !== file.sha256) changed.push(file.path);
  }
  return { checked: baseline.files.length, missing, changed, added: [] };
}

/**
 * A11：运行时版本只做可见/可追踪。分发自带 node，PAL 不能切换，
 * 所以基线里的版本与当前不一致时只提醒，不阻断。
 */
export function runtimeCheck(baselineRuntime: string | undefined, current: string): HealthCheck {
  if (!baselineRuntime) {
    // 老基线没记版本：不能拿它当漂移，也不要每次体检都报一条 warn
    return { name: 'runtime', status: 'ok', detail: `老基线没记 node 版本，跳过对比（当前 ${current}）` };
  }
  if (baselineRuntime === current) {
    return { name: 'runtime', status: 'ok', detail: `运行时没换：node ${current}` };
  }
  return {
    name: 'runtime',
    status: 'warn',
    detail: `运行时换过：baseline ${baselineRuntime} / 当前 ${current}`,
  };
}

/** 一个实例的健康检查：进程、端口、home、基线、MCP 接线。只读，不改状态。 */
export async function checkInstance(
  nameOrId: string,
  options: HealthOptions = {},
): Promise<InstanceHealth> {
  const record = requireInstance(nameOrId);
  const checks: HealthCheck[] = [];

  const others = scanInstances().broken.filter((bad) => bad.dir === record.root);
  checks.push({
    name: 'record',
    status: others.length > 0 ? 'fail' : 'ok',
    detail: others.length > 0 ? (others[0]!.reason ?? 'instance.json 读不了') : 'instance.json 可读',
  });

  const lock = instanceLock(record.root);
  const lockBusy = Boolean(lock && lock.pid !== process.pid && isPidAlive(lock.pid));
  checks.push({
    name: 'lock',
    status: lockBusy ? 'warn' : 'ok',
    detail: lockBusy ? `另一个 PAL 进程正在操作（${lock!.op}，pid ${lock!.pid}）` : '没有并发写',
  });

  if (record.pid) {
    const alive = isPidAlive(record.pid);
    const who = record.spawnPid !== undefined ? `pid ${record.pid}（spawnPid）` : `pid ${record.pid}`;
    checks.push({
      name: 'process',
      status: alive ? 'ok' : 'fail',
      detail: alive ? `${who} 在` : `${who} 已经不在了`,
    });
  } else {
    checks.push({
      name: 'process',
      status: record.status === 'running' ? 'fail' : 'ok',
      detail: record.status === 'running' ? '记录说在跑，但没有 pid' : '没有托管进程',
    });
  }

  if (record.port) {
    const listening = await isPortListening(record.port);
    checks.push({
      name: 'port',
      status: listening ? 'ok' : record.status === 'running' ? 'fail' : 'warn',
      detail: listening ? `端口 ${record.port} 有人听` : `端口 ${record.port} 没有响应`,
    });
  }

  // 入口体检：web 看地址，app 看内部端点（没有就只承认进程在），tui 看终端，headless 看退出码
  if (record.entry) {
    const spec = entryOf(record.harness, record.entry);
    const label = spec?.label ?? record.entry;
    let status: CheckStatus = 'ok';
    let detail: string;
    if (record.entry === 'headless') {
      const code = record.exitCode;
      status = code === undefined ? 'warn' : code === 0 ? 'ok' : 'fail';
      detail = code === undefined ? '还没有跑过一次性入口' : `退出码 ${code}`;
    } else if (record.entry === 'web') {
      status = record.url ? 'ok' : 'warn';
      detail = record.url ? `地址 ${record.url}` : '还没拿到地址';
    } else if (record.entry === 'tui') {
      detail = `终端 ${record.endpoint?.value ?? '窗口'}`;
    } else {
      detail = record.endpoint
        ? `${record.endpoint.kind} ${record.endpoint.value}`
        : '只能确认进程在；窗口由宿主自己开';
    }
    checks.push({ name: 'entry', status, detail: `${label} · ${detail}` });
  }

  // B12：listenPid 只是证据。端口主人换了就提醒（不阻断），说明记录里的监听者已经不是它
  if (record.listenPid !== undefined && record.port !== undefined) {
    const owner = portOwner(record.port)?.pid;
    const changed = owner !== undefined && owner !== record.listenPid;
    checks.push({
      name: 'listen-pid',
      status: changed ? 'warn' : 'ok',
      detail: changed
        ? `端口 ${record.port} 的主人换了：记录是 listenPid ${record.listenPid}，现在是 ${owner}`
        : `端口 ${record.port} 的主人仍是 listenPid ${record.listenPid}`,
    });
  }

  if (record.home) {
    checks.push({
      name: 'home',
      status: existsSync(record.home) ? 'ok' : 'fail',
      detail: existsSync(record.home) ? `home 在：${record.home}` : `home 不存在：${record.home}`,
    });
  }

  const baseline = readBaseline(record.root);
  const drift = baseline ? driftFrom(record, baseline) : undefined;
  if (drift) {
    const problems = drift.missing.length + drift.changed.length;
    checks.push({
      name: 'baseline',
      status: problems > 0 ? 'warn' : 'ok',
      detail:
        problems > 0
          ? `${drift.checked} 个文件里缺 ${drift.missing.length}、改过 ${drift.changed.length}`
          : `${drift.checked} 个文件与基线一致`,
    });
  } else {
    checks.push({ name: 'baseline', status: 'warn', detail: '没有 baseline.json（老实例）；重新建一次才有基线' });
  }

  // A11：运行时版本可见/可追踪。换过只提醒，不阻断（PAL 不能切换 node）
  checks.push(runtimeCheck(baseline?.runtime, options.runtime ?? process.version));

  let mcp: InstanceHealth['mcp'];
  if (record.harness === 'dsh') {
    const servers = readMcpServers(record.root);
    const file = record.home ? join(record.home, DSH_PATCH_FILE) : undefined;
    const wired = Boolean(file && existsSync(file));
    mcp = { servers: servers.length, wired, ...(file ? { file } : {}) };
    checks.push({
      name: 'mcp',
      status: servers.length === 0 ? 'ok' : wired ? 'ok' : 'warn',
      detail:
        servers.length === 0
          ? '这个 Pack 没有声明 MCP 服务器'
          : wired
            ? `${servers.length} 个 MCP 服务器已写进 --patch 层`
            : `${servers.length} 个 MCP 服务器还没接线（启动时生成）`,
    });
  }

  const ok = checks.every((check) => check.status !== 'fail');
  return {
    id: record.id,
    name: record.name,
    status: record.status,
    ...(record.entry ? { entry: record.entry } : {}),
    ok,
    checks,
    ...(drift ? { drift } : {}),
    ...(mcp ? { mcp } : {}),
  };
}

export async function checkAll(options: HealthOptions = {}): Promise<InstanceHealth[]> {
  const { records } = scanInstances();
  return Promise.all(records.map((record) => checkInstance(record.id, options)));
}
