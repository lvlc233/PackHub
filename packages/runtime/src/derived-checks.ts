// 派生检查：计划里已经写明、不需要作者再抄一遍 verify 项的那些检查。
//
// 原则：能从计划推出来的交给程序（写入产物的哈希、MCP 能不能握手），
// 作者只写推不出来的（command / scenario / file-exists / config-key）。
// 去重口径是「同一个 resource + 同一份期望」：作者手写过的，派生时跳过。

import type { PlanShape, VerifyCheck } from '@packhub/kernel';

/** 去重键：资源 id 与期望值的组合；用 NUL 分隔，资源 id 里不会出现它。 */
const key = (resource: string, expected: string): string => `${resource}\u0000${expected}`;

/**
 * 带 integrity 的 `write` 动作 → `knowledge-integrity`。
 *
 * 清单里 knowledge / prompt / config 声明了 integrity，物化会把它带到 write 动作上；
 * 装完核对「落盘的字节」是否仍与声明一致，就是这条检查，作者不用手写。
 * `authorChecks` 里已有同一 `resource` + `integrity` 的项时不重复。
 */
export function derivedChecks(
  plan: PlanShape,
  authorChecks: readonly VerifyCheck[] = [],
): VerifyCheck[] {
  const seen = new Set<string>();
  for (const check of authorChecks) {
    if (check.type === 'knowledge-integrity' && check.integrity) {
      seen.add(key(check.resource, check.integrity));
    }
  }

  const out: VerifyCheck[] = [];
  for (const action of plan.actions) {
    if (action.op !== 'write' || !action.integrity || !action.resource) continue;
    const id = key(action.resource, action.integrity);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ type: 'knowledge-integrity', resource: action.resource, integrity: action.integrity });
  }
  return out;
}

/**
 * 每个 `register.mcp` 动作 → `mcp-ready`。
 *
 * 只在 `verify --probe-mcp` 时用：真起一次进程 / 发一次 HTTP initialize，会执行包里的命令，
 * 所以不能混进默认的只读检查。`authorChecks` 里已有同名资源的 mcp-ready 时不重复。
 */
export function mcpProbeChecks(
  plan: PlanShape,
  authorChecks: readonly VerifyCheck[] = [],
): VerifyCheck[] {
  const seen = new Set<string>();
  for (const check of authorChecks) {
    if (check.type === 'mcp-ready') seen.add(check.resource);
  }

  const out: VerifyCheck[] = [];
  for (const action of plan.actions) {
    if (action.op !== 'register.mcp' || !action.resource) continue;
    if (seen.has(action.resource)) continue;
    seen.add(action.resource);
    out.push({ type: 'mcp-ready', resource: action.resource });
  }
  return out;
}

/**
 * 作者 checks 后面接上派生段（`probeMcp` 时再接 MCP 探活）。
 * verifyAt 的两种模式与 install 后的自动复核共用这一处，避免各自拼一遍。
 */
export function checksWithDerived(
  plan: PlanShape,
  authorChecks: readonly VerifyCheck[],
  opts: { probeMcp?: boolean } = {},
): VerifyCheck[] {
  return [
    ...authorChecks,
    ...derivedChecks(plan, authorChecks),
    ...(opts.probeMcp ? mcpProbeChecks(plan, authorChecks) : []),
  ];
}
