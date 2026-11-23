import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PLAN_OPS, STATE_DIR, actionUndoPayload, undoSharedPaths, type PathBase } from '@packhub/kernel';
import { loadState, mcpLayoutOfAction, ownedLabel, resolveOwnedPath } from './install.ts';
import { mcpFileHasEntry } from './mcp-file.ts';
import { claudeHasMcp } from './host-mcp.ts';

export interface DriftFinding {
  pack: string;
  /** 托管块被外部改写/删掉的文件 */
  blocksMissing: string[];
  /** 记录里写过、现在不在的文件 */
  filesMissing: string[];
  /** 记录里有、但文件里找不到我们自己块的（同 blocksMissing，按块 id） */
  blockIds: string[];
  /** 配置值/MCP 条目被外部改掉 */
  configDrift: string[];
  /** active.json 与 state 不一致（版本或 planHash 对不上、条目多/少） */
  activeDrift: string[];
  /** 声明的持久状态目录不见了（数据可能被误删） */
  stateMissing: string[];
  /** 由宿主 CLI 管理的 MCP 不见了（例如用户在 Claude 里手工删掉） */
  mcpMissing: string[];
}

export interface DoctorReport {
  packs: string[];
  findings: DriftFinding[];
  ok: boolean;
}

/**
 * 检查已装的包有没有被外部改动：写过的文件还在不在、托管块还在不在。
 * 宿主工具重新生成 AGENTS.md / CLAUDE.md 时会把我们的块吃掉——这是最容易静默失效的地方。
 */
export function doctorPack(root: string): DoctorReport {
  const state = loadState(root);
  const packs = Object.keys(state.packs);
  const findings: DriftFinding[] = [];
  const active = readActiveFile(root);
  const activeNames = new Set<string>();

  for (const pack of packs) {
    const record = state.packs[pack]!;
    const finding: DriftFinding = {
      pack,
      blocksMissing: [],
      filesMissing: [],
      blockIds: [],
      configDrift: [],
      activeDrift: [],
      stateMissing: [],
      mcpMissing: [],
    };
    const name = pack.split('@')[0] ?? pack;
    const recordVersion = record.version;
    activeNames.add(name);
    const pointer = active[name];
    if (!pointer) {
      finding.activeDrift.push(`active.json 没有 ${name}`);
    } else {
      if (pointer.version !== recordVersion) {
        finding.activeDrift.push(`${name}: active=${pointer.version} state=${recordVersion}`);
      }
      if (pointer.planHash !== record.planHash) {
        finding.activeDrift.push(`${name}: active planHash 与 state 不一致`);
      }
    }

    for (const file of record.written) {
      let abs: string;
      try {
        abs = resolveOwnedPath(root, record.home, file);
      } catch (err) {
        // home 基准但 state 没记 home：记录不完整，按缺文件报出来，别把整次体检打崩
        finding.filesMissing.push(`${file.path}（${(err as Error).message}）`);
        continue;
      }
      if (!existsSync(abs)) finding.filesMissing.push(ownedLabel(root, abs));
    }
    for (const spec of record.stateDirs ?? []) {
      if (!existsSync(join(root, spec.path))) finding.stateMissing.push(spec.path);
    }
    for (const name of record.hostMcp ?? []) {
      if (!claudeHasMcp(name)) finding.mcpMissing.push(name);
    }

    for (const action of record.actions ?? []) {
      // 撤销方式决定「怎么检查」：共享配置查登记的条目，托管块查标记
      const undo = PLAN_OPS[action.op]?.undo;
      const planAction = record.plan?.actions.find((a) => a.actionId === action.actionId);
      if (undo === 'restore-shared' && (planAction || (action.target && action.resource))) {
        // 撤销载荷由 PLAN_OPS 表给出：一个动作可能对应多个文件（dsh attached 的每个 profile patch）
        const payload = planAction ? actionUndoPayload(planAction) : null;
        const shared =
          payload?.undo === 'restore-shared'
            ? { targets: undoSharedPaths(payload), key: payload.key, layout: mcpLayoutOfAction(planAction!) }
            : {
                targets: [{ path: action.target!, base: 'root' as PathBase }],
                key: action.resource ?? 'mcp',
                layout: { configPath: ['mcpServers'], format: 'json' as const },
              };
        for (const target of shared.targets) {
          let file: string;
          try {
            file = resolveOwnedPath(root, record.home, target);
          } catch {
            finding.configDrift.push(`${target.path}:${shared.key}`);
            continue;
          }
          if (!existsSync(file)) continue; // 文件不见了由 written 报 filesMissing
          const text = readFileSync(file, 'utf8');
          const present = file.endsWith('.toml')
            ? text.includes(`[mcp_servers.${shared.key}]`)
            : mcpFileHasEntry(text, shared.layout, shared.key);
          if (!present) {
            const where = shared.layout.list ? shared.key : `${shared.layout.configPath.join('.')}.${shared.key}`;
            finding.configDrift.push(`${target.path}:${where}`);
          }
        }
      }
      if (undo !== 'strip-block' || !action.target || !action.blockId) continue;
      const planBase: PathBase =
        planAction?.op === 'instruction' ? planAction.toBase ?? 'root' : 'root';
      let abs: string;
      try {
        abs = resolveOwnedPath(root, record.home, { path: action.target, base: planBase });
      } catch {
        finding.blocksMissing.push(action.target);
        continue;
      }
      if (!existsSync(abs)) {
        if (!finding.blocksMissing.includes(action.target)) finding.blocksMissing.push(action.target);
        continue;
      }
      const text = readFileSync(abs, 'utf8');
      const marker = `<!-- packhub:begin ${action.blockId} -->`;
      if (!text.includes(marker)) {
        finding.blocksMissing.push(action.target);
        finding.blockIds.push(action.blockId);
      }
    }

    if (
      finding.blocksMissing.length ||
      finding.filesMissing.length ||
      finding.configDrift.length ||
      finding.activeDrift.length ||
      finding.stateMissing.length ||
      finding.mcpMissing.length
    ) {
      findings.push(finding);
    }
  }

  // active.json 里还挂着、state 里已经没有的包：切换/卸载没清干净
  for (const [name, pointer] of Object.entries(active)) {
    if (activeNames.has(name)) continue;
    findings.push({
      pack: `${name}@${pointer.version}`,
      blocksMissing: [],
      filesMissing: [],
      blockIds: [],
      configDrift: [],
      activeDrift: [`active.json 有 ${name}，但 state 里没有这个包`],
      stateMissing: [],
      mcpMissing: [],
    });
  }

  return { packs, findings, ok: findings.length === 0 };
}

interface ActivePointer {
  version: string;
  planHash: string;
  /** 其余字段（harness / 旧 target / at）漂移检查不看；旧 active.json 里有 target 也照样读 */
}

function readActiveFile(root: string): Record<string, ActivePointer> {
  const file = join(root, STATE_DIR, 'active.json');
  if (!existsSync(file)) return {};
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as {
      packs?: Record<string, ActivePointer>;
    };
    return parsed.packs ?? {};
  } catch {
    return {};
  }
}
