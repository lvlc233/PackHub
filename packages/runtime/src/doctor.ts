import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadState } from './install.ts';

export interface DriftFinding {
  pack: string;
  /** 托管块被外部改写/删掉的文件 */
  blocksMissing: string[];
  /** 记录里写过、现在不在的文件 */
  filesMissing: string[];
  /** 记录里有、但文件里找不到我们自己块的（同 blocksMissing，按块 id） */
  blockIds: string[];
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
    const finding: DriftFinding = { pack, blocksMissing: [], filesMissing: [], blockIds: [] };

    for (const file of record.written) {
      if (!existsSync(join(root, file))) finding.filesMissing.push(file);
    }

    for (const action of record.actions ?? []) {
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

    if (finding.blocksMissing.length || finding.filesMissing.length) findings.push(finding);
  }

  return { packs, findings, ok: findings.length === 0 };
}
