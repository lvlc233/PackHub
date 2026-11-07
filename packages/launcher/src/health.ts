import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  instanceLock,
  readBaseline,
  requireInstance,
  scanInstances,
  type InstanceRecord,
} from './index.ts';
import { isPidAlive } from './process.ts';
import { isPortListening } from './port.ts';
import { readMcpServers, DSH_PATCH_FILE } from './mcp.ts';

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
  ok: boolean;
  checks: HealthCheck[];
  drift?: BaselineDrift;
  mcp?: { servers: number; wired: boolean; file?: string };
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

/** 一个实例的健康检查：进程、端口、home、基线、MCP 接线。只读，不改状态。 */
export async function checkInstance(nameOrId: string): Promise<InstanceHealth> {
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
    checks.push({
      name: 'process',
      status: alive ? 'ok' : 'fail',
      detail: alive ? `pid ${record.pid} 在` : `pid ${record.pid} 已经不在了`,
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

  if (record.home) {
    checks.push({
      name: 'home',
      status: existsSync(record.home) ? 'ok' : 'fail',
      detail: existsSync(record.home) ? `home 在：${record.home}` : `home 不存在：${record.home}`,
    });
  }

  const drift = baselineDrift(record);
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
    ok,
    checks,
    ...(drift ? { drift } : {}),
    ...(mcp ? { mcp } : {}),
  };
}

export async function checkAll(): Promise<InstanceHealth[]> {
  const { records } = scanInstances();
  return Promise.all(records.map((record) => checkInstance(record.id)));
}
