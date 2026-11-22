import pkg from '../../../package.json' with { type: 'json' };
import type { LockFile, Manifest, ResolvedRef } from './types.ts';
import { canonicalize, sha256 } from './util.ts';

export interface LockOptions {
  resolvedAt?: string;
  /** 解析后的引用（pin 到 commit / 版本 / sha256）；缺省时按清单原样记录 */
  resolved?: { id: string; source: string; integrity: string | null }[];
}

/**
 * contentHash 的规范化口径（唯一来源：lock 写端与所有校验端都调它，别各算一份）。
 *
 * - 只哈希两样东西：**清单 + `resolved` 引用**。宿主、计划、平台一律不进哈希：
 *   同一份内容平铺装、或装到 dsh / claude-code / codex 上算出的 contentHash 相同——
 *   装到哪个宿主是安装期参数，不是内容。
 * - 清单先去掉 `signatures`：签名本身不是内容，而且签名载荷就是这个哈希，含进来会自指。
 * - 清单里的资源来源先按 `resolved` 归一（有解析结果就用 pin 过的 source / integrity，
 *   与 `withLockPins` 同口径）：于是「作者清单 + 锁」和「pin 过的清单 + 锁」算出同一个哈希，
 *   校验端传哪一份都对；被 pin 覆盖掉的声明来源（tag / range）本身不算内容，真正的引用在 resolved 里。
 * - `resolved` 每项只取 `{id, type, source, integrity}`，**丢掉 `resolvedAt`**：
 *   那是生成时刻，不是内容；否则同一份内容重跑一次 lock 就换一个哈希。
 * - `resolved` 按 `id` 升序排列：锁里条目的顺序不改变「钉住了什么」。
 * - 序列化用 `canonicalize`（递归键排序、丢弃 undefined），sha256 取 utf8 明文，
 *   写成 `sha256-<base64>`，与仓库里其它哈希同形。
 */
export function contentHashOf(manifest: Manifest, resolved: readonly ResolvedRef[]): string {
  const { signatures: _signatures, ...content } = manifest;
  const refs = resolved
    .map(({ id, type, source, integrity }) => ({ id, type, source, integrity }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const byId = new Map(refs.map((r) => [r.id, r]));
  const resources = content.resources.map((res) => {
    const hit = byId.get(res.id);
    return hit
      ? { ...res, source: hit.source, ...(hit.integrity ? { integrity: hit.integrity } : {}) }
      : res;
  });
  return sha256(canonicalize({ manifest: { ...content, resources }, resolved: refs }));
}

/**
 * 生成锁：只记录引用与完整性，不含任何安装形态的计划。
 *
 * 装到哪个宿主、计划长什么样，都由调用方在用到时用 `planFor(ctx, { harness })` 现算。
 * `manifest` 与 `resolved` 一起进 contentHash；来源是否已被 pin 过不影响结果，
 * 但 `pack` / `resolved` 的 id 与类型取自传入的这份清单。
 */
export function buildLock(manifest: Manifest, opts: LockOptions = {}): LockFile {
  const resolvedAt = opts.resolvedAt ?? new Date().toISOString();
  const byId = new Map((opts.resolved ?? []).map((r) => [r.id, r]));

  const resolved: ResolvedRef[] = manifest.resources.map((res) => {
    const hit = byId.get(res.id);
    return {
      id: res.id,
      type: res.type,
      // 有解析结果就用解析后的（github tag → commit、npm range → 具体版本）
      source: hit?.source ?? res.source,
      // 没有 integrity 就显式写 null，不假装锁住了字节
      integrity: hit ? hit.integrity : res.integrity ?? null,
      resolvedAt,
    };
  });

  return {
    apiVersion: 'packhub.dev/lock/v0',
    pack: `${manifest.metadata.name}@${manifest.metadata.version}`,
    resolved,
    contentHash: contentHashOf(manifest, resolved),
    generatedBy: `packhub/${pkg.version}`,
  };
}
