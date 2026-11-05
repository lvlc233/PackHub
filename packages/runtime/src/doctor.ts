import { existsSync, readFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { loadState } from './install.ts';

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

  for (const pack of packs) {
    const record = state.packs[pack]!;
    const finding: DriftFinding = { pack, blocksMissing: [], filesMissing: [], blockIds: [], configDrift: [] };

    for (const file of record.written) {
      if (!existsSync(join(root, file))) finding.filesMissing.push(file);
    }

    for (const action of record.actions ?? []) {
      if (action.op === 'merge.config' && action.target && action.undo?.applied?.length) {
        const file = join(root, action.target);
        if (existsSync(file)) {
          const data = readConfigFile(file);
          for (const item of action.undo.applied) {
            const actual = getPath(data, item.path);
            if (JSON.stringify(actual) !== JSON.stringify(item.value)) {
              finding.configDrift.push(`${action.target}:${item.path.join('.')}`);
            }
          }
        }
      }
      if (action.op === 'register.mcp' && action.target && action.resource) {
        const file = join(root, action.target);
        if (existsSync(file)) {
          const text = readFileSync(file, 'utf8');
          const present = file.endsWith('.toml')
            ? text.includes(`[mcp_servers.${action.resource}]`)
            : Boolean((JSON.parse(text) as { mcpServers?: Record<string, unknown> }).mcpServers?.[action.resource]);
          if (!present) finding.configDrift.push(`${action.target}:mcpServers.${action.resource}`);
        }
      }
      if (action.op !== 'instruction' || !action.target || !action.blockId) continue;
      const abs = join(root, action.target);
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

    if (finding.blocksMissing.length || finding.filesMissing.length || finding.configDrift.length) {
      findings.push(finding);
    }
  }

  return { packs, findings, ok: findings.length === 0 };
}

function readConfigFile(file: string): unknown {
  const text = readFileSync(file, 'utf8');
  return extname(file).toLowerCase() === '.json' ? JSON.parse(text) : (parseYaml(text) ?? {});
}

function getPath(data: unknown, path: string[]): unknown {
  let cur: unknown = data;
  for (const part of path) {
    if (!cur || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}
