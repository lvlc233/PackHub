// 启动模式的解析：`--mode` > 记录里的模式 > 适配器默认。
//
// 模式本身由 kernel 的宿主模块声明（`LaunchMode`），这里只做三件事：查表、把记录里的事实
// 交给 `available` 判断、把用法错翻译成退出 2 的 invalid-input。执行路径（core / 前台 / app）
// 由命令层按 `mode.kind` 分派。
import type { LaunchAvailability, LaunchMode } from '@packhub/kernel';
import { PalError } from './errors.ts';
import { requireAdapter, type HarnessAdapter, type InstanceKind } from './layout.ts';
import type { InstanceRecord } from './records.ts';

/** 解析出来的模式与来源：显式 `--mode`，或适配器默认。 */
export interface LaunchChoice {
  mode: LaunchMode;
  source: 'flag' | 'default';
}

/** 记录里能回答「这个模式能不能用」的事实。 */
export function availabilityOf(
  record: Pick<InstanceRecord, 'attached' | 'home' | 'profile'>,
): LaunchAvailability {
  return {
    attached: record.attached === true,
    ...(record.home ? { home: record.home } : {}),
    ...(record.profile ? { profile: record.profile } : {}),
  };
}

/** 适配器的默认模式：`defaultMode` 指的那条，不写就是第一条。 */
function defaultModeOf(adapter: HarnessAdapter): LaunchMode | undefined {
  if (adapter.defaultMode === undefined) return adapter.modes[0];
  return adapter.modes.find((mode) => mode.id === adapter.defaultMode);
}

/** 不可用原因；能用时 undefined（模式没声明 `available` 就是能用）。 */
export function unavailableReason(mode: LaunchMode, ctx: LaunchAvailability): string | undefined {
  const state = mode.available ? mode.available(ctx) : true;
  return state === true ? undefined : state;
}

/** 未知模式的统一报错：列出可选值，退出 2。 */
function unknownMode(harness: string, requested: string, adapter: HarnessAdapter): PalError {
  const choices = adapter.modes.map((mode) => mode.id);
  return new PalError('invalid-input', `宿主 ${harness} 没有启动模式「${requested}」`, {
    hint: choices.length
      ? `可选：${choices.join(' / ')}；pal start <home> --list-modes 看每个模式能不能用`
      : `${adapter.label} 没有声明任何启动模式${adapter.noStartReason ? `：${adapter.noStartReason}` : ''}`,
    details: { harness, mode: requested, choices },
  });
}

/** 选中一条模式：显式 id 必须存在；不写就用适配器默认。只查表，不判断可用性。 */
export function resolveLaunchMode(
  record: Pick<InstanceRecord, 'harness'>,
  requested?: string,
): LaunchChoice {
  const adapter = requireAdapter(record.harness);
  if (requested !== undefined) {
    const mode = adapter.modes.find((item) => item.id === requested);
    if (!mode) throw unknownMode(record.harness, requested, adapter);
    return { mode, source: 'flag' };
  }
  const mode = defaultModeOf(adapter);
  if (!mode) {
    throw new PalError('not-startable', `${adapter.label} 没有可启动的模式`, {
      hint: adapter.noStartReason ?? '这个宿主只支持装配 home，PAL 不托管它的进程',
      details: { harness: record.harness },
    });
  }
  return { mode, source: 'default' };
}

/** 模式在当前 home 上不可用就退 2（`--mode` 指了一条这条 home 用不了的产品能力），并列出可选值。 */
export function assertModeAvailable(
  record: Pick<InstanceRecord, 'harness' | 'attached' | 'home' | 'profile'>,
  mode: LaunchMode,
): void {
  const reason = unavailableReason(mode, availabilityOf(record));
  if (reason === undefined) return;
  const choices = requireAdapter(record.harness).modes.map((item) => item.id);
  throw new PalError('invalid-input', `宿主 ${record.harness} 的 ${mode.id} 模式不可用：${reason}`, {
    hint: `可选：${choices.join(' / ')}；pal start <home> --list-modes 看每个模式在这份 home 上能不能用`,
    details: { harness: record.harness, mode: mode.id, reason, choices },
  });
}

/**
 * core 托管的启动只能用 `server` 模式：显式给的 > 记录里上次用的（只认 server）> 宿主第一条 server 模式。
 *
 * 记录里存 `launchMode` 是为了重启 / 看护重起回到同一条模式：opencode 的默认模式是 tui，
 * 用户用 `--mode web` 起的实例若按默认重起会变成前台命令。记录里是前台 / app 模式时不套用
 * （`pal restart` 回到 server 启动，不会把窗口重起成网页），只有显式要一条非 server 模式才报错。
 */
export function resolveServerMode(
  record: Pick<InstanceRecord, 'harness' | 'launchMode'>,
  requested?: string,
): LaunchMode {
  const adapter = requireAdapter(record.harness);
  const explicit = requested === undefined ? undefined : adapter.modes.find((mode) => mode.id === requested);
  if (requested !== undefined && !explicit) throw unknownMode(record.harness, requested, adapter);
  const recorded =
    record.launchMode === undefined
      ? undefined
      : adapter.modes.find((mode) => mode.id === record.launchMode && mode.kind === 'server');
  const mode = explicit ?? recorded ?? adapter.modes.find((item) => item.kind === 'server');
  if (!mode) {
    throw new PalError('not-startable', `${adapter.label} 没有 server 模式：PAL 没有可托管的常驻服务`, {
      hint: 'server 模式才会交给 core 等地址；前台 / app 模式用 pal start --mode <模式> 直接起',
      details: { harness: record.harness },
    });
  }
  if (mode.kind !== 'server') {
    throw new PalError(
      'not-startable',
      `${adapter.label} 的 ${mode.id} 模式是 ${mode.kind}，不是 core 托管的 server`,
      {
        hint: 'core 只托管 server 模式；前台 / app 模式在命令行这一层直接起，不进 core',
        details: { harness: record.harness, mode: mode.id, kind: mode.kind },
      },
    );
  }
  return mode;
}

/** 适配器里第一条前台模式（`pal run` 的糖用它）；没有 = 这个宿主不能前台跑。 */
export function defaultForegroundMode(kind: InstanceKind): LaunchMode | undefined {
  return requireAdapter(kind).modes.find((mode) => mode.kind === 'foreground');
}

/** 适配器里第一条 app 模式（直接调启动层、没传模式时用）；没有 = 这个宿主没有桌面 app。 */
export function defaultAppMode(kind: InstanceKind): LaunchMode | undefined {
  return requireAdapter(kind).modes.find((mode) => mode.kind === 'app');
}
