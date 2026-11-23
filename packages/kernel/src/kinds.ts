// 资源类型 → 安装动作 / 参数补丁面 / 能力形态的一张描述表。
//
// buildPlan 的循环只负责顺序、宿主裁剪与 push 编号；每种类型怎么物化都在这里的
// materialize 里。validateGraph 的参数补丁也按 paramPatch 分叉，不再自己按类型写 if。
// 加资源类型：这里补一条（Record<ResourceType, ResourceKind> 会逼着补），不要再往 buildPlan 里加 switch。

import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import type {
  Issue,
  PathBase,
  PlanAction,
  PlanActionInput,
  ResourceSpec,
  ResourceType,
  ToolRuntime,
} from './types.ts';
import type { CapabilityForm } from './capability.ts';
import type { Destination, DestinationKind } from './harness/contract.ts';
import { parseSource } from './ref.ts';
import { ISSUE_CODES } from './issueCodes.ts';
import { isPlainObject } from './util.ts';

/** 资源装到哪儿、本地来源在哪；文件类补丁要按这个落点算目标、按来源读上游内容。 */
export interface InstalledResource {
  type: ResourceType;
  kind: 'dir' | 'file';
  to: string;
  /** 目标落点的基准；缺省 root（与适配器 destination 的 base 同源） */
  base?: PathBase;
  from?: string;
}

/** materialize 需要的计划上下文：只放跨资源共享的手柄，单个资源本身跟着 res 传。 */
export interface KindContext {
  issues: Issue[];
  installed: Map<string, InstalledResource>;
  /** 目标宿主的落点回答：每类资源落在哪（路径相对安装根） */
  dest(kind: DestinationKind): Destination;
  /** 包目录的绝对路径：tool2 判断本地来源是文件还是目录时读它 */
  packBase: string;
  /** 目标平台（`platform-arch`）：只用来给平台警告，不读 process */
  platform: string;
  push(action: PlanActionInput): PlanAction;
  interp(value: unknown): unknown;
  /** route shim 每种运行时只写一次，返回它在安装根里的相对路径 */
  pushRouteShim(runtime: 'node' | 'python'): string;
}

export interface ResourceKind {
  id: ResourceType;
  /** 这个类型提供的能力属于哪种消费形态（能力令牌的 form 段） */
  form: CapabilityForm;
  /** 对象形式的 modify 并到哪儿：mcp → config，tool2 → env，其余没有参数面 */
  paramPatch: 'config' | 'env' | null;
  materialize(ctx: KindContext, res: ResourceSpec): void;
}

/** 把 destination 的 base 带到动作上：默认 root 不写字段（旧计划的 JSON 逐字节不变）。 */
function toBaseField(base: PathBase | undefined): { toBase?: PathBase } {
  return base && base !== 'root' ? { toBase: base } : {};
}

/** 同上的来源基准：只在适配器把缓存放到非 root 位置时出现。 */
function fromBaseField(base: PathBase | undefined): { fromBase?: PathBase } {
  return base && base !== 'root' ? { fromBase: base } : {};
}

/** fetch 的落点基准：默认 root，不写字段。 */
function destBaseField(base: PathBase | undefined): { destBase?: PathBase } {
  return base && base !== 'root' ? { destBase: base } : {};
}

/** link.exec 的 entry / module 基准：默认 root，不写字段。 */
function entryBaseField(base: PathBase | undefined): { entryBase?: PathBase } {
  return base && base !== 'root' ? { entryBase: base } : {};
}
function moduleBaseField(base: PathBase | undefined): { moduleBase?: PathBase } {
  return base && base !== 'root' ? { moduleBase: base } : {};
}

function materializeMcp(ctx: KindContext, res: ResourceSpec): void {
  // MCP 由目标环境自己用 npx/uvx 拉起，安装期只登记，不预先下载包体。
  // 登记到哪、条目什么形状由宿主 destination('mcp') 回答（方言随落点一起给）；
  // 缺省 = `.packhub/config.json` + JSON mcpServers + 原 spec。
  const target = ctx.dest('mcp');
  const dialect = target.mcp;
  const base = buildMcpSpec(res, ctx.interp(res.config ?? {}) as Record<string, unknown>);
  const entry = dialect?.entry ? (dialect.entry(base) as Record<string, unknown>) : base;
  ctx.push({
    op: 'register.mcp',
    spec: entry,
    path: dialect?.file ?? target.path,
    ...toBaseField(target.base),
    ...(dialect?.path ? { configPath: [...dialect.path] } : {}),
    ...(dialect?.format ? { format: dialect.format } : {}),
    resource: res.id,
  });
}

function materializeSkill(ctx: KindContext, res: ResourceSpec): void {
  const id = res.id;
  const at = `resources.${id}`;
  const parsed = parseSource(res.source);
  if (parsed.kind === 'http' && !looksLikeArchive(res.source)) {
    ctx.issues.push({
      code: ISSUE_CODES.sourceNotArchive,
      severity: 'error',
      message: `skill 的 https 来源必须是 .tar.gz（现在是单文件）：${res.source}`,
      path: at,
    });
    return;
  }
  if (parsed.kind === 'local') {
    const target = ctx.dest('skill');
    ctx.push({
      op: 'link.skill',
      from: parsed.locator,
      to: `${target.path}/${id}`,
      fromBase: 'pack',
      ...toBaseField(target.base),
      resource: id,
    });
    ctx.installed.set(id, {
      type: res.type,
      kind: 'dir',
      to: `${target.path}/${id}`,
      ...(target.base ? { base: target.base } : {}),
      from: parsed.locator,
    });
  } else {
    const cache = ctx.dest('cache');
    const target = ctx.dest('skill');
    ctx.push({
      op: 'fetch',
      uri: res.source,
      dest: `${cache.path}/${id}.tar.gz`,
      ...destBaseField(cache.base),
      ...(res.integrity ? { integrity: res.integrity } : {}),
      ...(res.auth ? { auth: res.auth } : {}),
      resource: id,
    });
    ctx.push({
      op: 'unpack',
      from: `${cache.path}/${id}.tar.gz`,
      to: `${cache.path}/skills/${id}`,
      strip: 1,
      fromBase: cache.base ?? 'root',
      ...toBaseField(cache.base),
      resource: id,
    });
    // github:owner/repo/sub/path@ref 的 sub/path 只在解包后的仓库里取
    const from = parsed.subpath
      ? `${cache.path}/skills/${id}/${parsed.subpath}`
      : `${cache.path}/skills/${id}`;
    ctx.push({
      op: 'link.skill',
      from,
      to: `${target.path}/${id}`,
      fromBase: cache.base ?? 'root',
      ...toBaseField(target.base),
      resource: id,
    });
    // 远程资源的正文要等安装时才取回：能做整文件替换与删除，做不了按锚点改
    ctx.installed.set(id, {
      type: res.type,
      kind: 'dir',
      to: `${target.path}/${id}`,
      ...(target.base ? { base: target.base } : {}),
    });
  }
}

/** knowledge 与 prompt 只有落点目录不同：都是单文件、原样写进对应目录。 */
function materializeContent(ctx: KindContext, res: ResourceSpec): void {
  const id = res.id;
  const parsed = parseSource(res.source);
  const target = ctx.dest(res.type === 'knowledge' ? 'knowledge' : 'prompt');
  const name = fileNameOf(parsed.locator);
  if (parsed.kind === 'local') {
    ctx.push({
      op: 'write',
      from: parsed.locator,
      to: `${target.path}/${name}`,
      ...toBaseField(target.base),
      // 声明了 integrity 就随 write 带上：verify 段据此派生知识文件的哈希校验
      ...(res.integrity ? { integrity: res.integrity } : {}),
      resource: id,
    });
    ctx.installed.set(id, {
      type: res.type,
      kind: 'file',
      to: `${target.path}/${name}`,
      ...(target.base ? { base: target.base } : {}),
      from: parsed.locator,
    });
  } else {
    ctx.push({
      op: 'fetch',
      uri: res.source,
      dest: `${target.path}/${name}`,
      ...destBaseField(target.base),
      ...(res.integrity ? { integrity: res.integrity } : {}),
      ...(res.auth ? { auth: res.auth } : {}),
      resource: id,
    });
    ctx.installed.set(id, {
      type: res.type,
      kind: 'file',
      to: `${target.path}/${name}`,
      ...(target.base ? { base: target.base } : {}),
    });
  }
}

function materializeConfig(ctx: KindContext, res: ResourceSpec): void {
  // config 就是一份配置文件，原样落进 config 落点；不合并、不碰 MCP 的配置文件
  const id = res.id;
  const parsed = parseSource(res.source);
  const target = ctx.dest('config');
  const name = fileNameOf(parsed.locator);
  if (parsed.kind === 'local') {
    ctx.push({
      op: 'write',
      from: parsed.locator,
      to: `${target.path}/${name}`,
      ...toBaseField(target.base),
      ...(res.integrity ? { integrity: res.integrity } : {}),
      resource: id,
    });
    ctx.installed.set(id, {
      type: res.type,
      kind: 'file',
      to: `${target.path}/${name}`,
      ...(target.base ? { base: target.base } : {}),
      from: parsed.locator,
    });
  } else {
    ctx.push({
      op: 'fetch',
      uri: res.source,
      dest: `${target.path}/${name}`,
      ...destBaseField(target.base),
      ...(res.integrity ? { integrity: res.integrity } : {}),
      ...(res.auth ? { auth: res.auth } : {}),
      resource: id,
    });
    ctx.installed.set(id, {
      type: res.type,
      kind: 'file',
      to: `${target.path}/${name}`,
      ...(target.base ? { base: target.base } : {}),
    });
  }
}

function materializeTool(ctx: KindContext, res: ResourceSpec): void {
  const id = res.id;
  const at = `resources.${id}`;
  const parsed = parseSource(res.source);
  const commands = res.commands ?? [];
  if (commands.length === 0) {
    ctx.issues.push({
      code: ISSUE_CODES.toolNeedsCommands,
      severity: 'error',
      message: `tool2 要用 commands 声明暴露哪些命令：${res.source}`,
      path: at,
    });
    return;
  }

  // 执行体整份落地，按 commands 逐条建入口
  const cache = ctx.dest('cache');
  const bin = ctx.dest('bin');
  const toolRoot = `${cache.path}/tools/${id}`;
  const localPath = parsed.kind === 'local' ? resolve(ctx.packBase, parsed.locator) : undefined;
  const sourceIsFile = localPath ? existsSync(localPath) && !statSync(localPath).isDirectory() : false;
  if (parsed.kind === 'local') {
    ctx.push({
      op: 'copy',
      from: parsed.locator,
      to: toolRoot,
      ...toBaseField(cache.base),
      resource: id,
    });
    // 本地来源能读到正文：允许 modify 按锚点改执行体
    ctx.installed.set(id, {
      type: res.type,
      kind: 'dir',
      to: toolRoot,
      ...(cache.base ? { base: cache.base } : {}),
      from: parsed.locator,
    });
  } else {
    if (parsed.kind === 'http' && !looksLikeArchive(res.source)) {
      ctx.issues.push({
        code: ISSUE_CODES.sourceNotArchive,
        severity: 'error',
        message: `tool2 的 https 来源必须是 .tar.gz（现在是单文件）：${res.source}`,
        path: at,
      });
      return;
    }
    ctx.push({
      op: 'fetch',
      uri: res.source,
      dest: `${cache.path}/${id}.tar.gz`,
      ...destBaseField(cache.base),
      ...(res.integrity ? { integrity: res.integrity } : {}),
      ...(res.auth ? { auth: res.auth } : {}),
      resource: id,
    });
    ctx.push({
      op: 'unpack',
      from: `${cache.path}/${id}.tar.gz`,
      to: toolRoot,
      strip: 1,
      fromBase: cache.base ?? 'root',
      ...toBaseField(cache.base),
      resource: id,
    });
    ctx.installed.set(id, {
      type: res.type,
      kind: 'dir',
      to: toolRoot,
      ...(cache.base ? { base: cache.base } : {}),
    });
  }

  const names = new Set<string>();
  for (const [ci, cmd] of commands.entries()) {
    const label = `${at}.commands[${ci}]`;
    if (!cmd.name) {
      ctx.issues.push({ code: ISSUE_CODES.toolCommandInvalid, severity: 'error', message: `${label} 缺少 name`, path: label });
      continue;
    }
    if (names.has(cmd.name)) {
      ctx.issues.push({
        code: ISSUE_CODES.duplicateCommandName,
        severity: 'error',
        message: `${label}：命令名重复：${cmd.name}`,
        path: label,
      });
      continue;
    }
    names.add(cmd.name);

    const exec = cmd.exec ?? (sourceIsFile ? fileNameOf(parsed.locator) : undefined);
    if (!exec) {
      ctx.issues.push({
        code: ISSUE_CODES.toolCommandInvalid,
        severity: 'error',
        message: `${label}：source 是目录，必须写 exec 指明执行体`,
        path: label,
      });
      continue;
    }
    const runtime = cmd.runtime ?? inferRuntime(exec);
    const shim = cmd.shim ?? res.shim ?? 'auto';
    const mergedEnv = (() => {
      const merged = { ...(res.env ?? {}), ...(cmd.env ?? {}) };
      return Object.keys(merged).length > 0 ? merged : undefined;
    })();
    const platforms = cmd.platforms ?? res.platforms;
    // 平台裁剪改到执行期：计划保留全部动作，不匹配由执行器记 skipped。
    // 这里只用注入的平台给一条「跑不了」的警告，不删动作、不读 process。
    if (runtime === 'shell' && ctx.platform.startsWith('win32')) {
      ctx.issues.push({
        code: ISSUE_CODES.toolShellUnsupported,
        severity: 'warning',
        message: `${label}：runtime: shell 要 sh，Windows 上没有；执行器会拒绝这条命令，换 node / python 或用 platforms 限定平台`,
        path: label,
      });
    }
    if (runtime === 'binary' && !platforms) {
      ctx.issues.push({
        code: ISSUE_CODES.toolBinaryWithoutPlatforms,
        severity: 'warning',
        message: `${label}：binary 没写 platforms，装到别的平台要到运行时才失败`,
        path: label,
      });
    }
    const platformField = platforms && platforms.length > 0 ? { platforms } : {};
    if (shim === 'route') {
      if (!cmd.call) {
        ctx.issues.push({
          code: ISSUE_CODES.toolRouteNeedsCall,
          severity: 'error',
          message: `${label}：shim: route 要写 call（模块里的函数名）`,
          path: label,
        });
        continue;
      }
      if (runtime !== 'node' && runtime !== 'python') {
        ctx.issues.push({
          code: ISSUE_CODES.toolRouteUnsupported,
          severity: 'error',
          message: `${label}：route 只支持 node / python，现在是 ${runtime}`,
          path: label,
        });
        continue;
      }
      const shimPath = ctx.pushRouteShim(runtime);
      ctx.push({
        op: 'link.exec',
        to: `${bin.path}/${cmd.name}`,
        ...toBaseField(bin.base),
        runtime,
        entry: shimPath,
        module: `${toolRoot}/${exec}`,
        ...moduleBaseField(cache.base),
        args: [cmd.call, ...(cmd.args ?? [])],
        ...platformField,
        ...(mergedEnv ? { env: mergedEnv } : {}),
        resource: id,
      });
      continue;
    }
    ctx.push({
      op: 'link.exec',
      to: `${bin.path}/${cmd.name}`,
      ...toBaseField(bin.base),
      runtime,
      entry: `${toolRoot}/${exec}`,
      ...entryBaseField(cache.base),
      args: cmd.args ?? [],
      ...platformField,
      ...(mergedEnv ? { env: mergedEnv } : {}),
      resource: id,
    });
  }
}

/** 每种资源类型只在这里声明一次；Record 的键强制覆盖 ResourceType 全集。 */
export const RESOURCE_KINDS: Record<ResourceType, ResourceKind> = {
  mcp: { id: 'mcp', form: 'tool', paramPatch: 'config', materialize: materializeMcp },
  skill: { id: 'skill', form: 'skill', paramPatch: null, materialize: materializeSkill },
  prompt: { id: 'prompt', form: 'content', paramPatch: null, materialize: materializeContent },
  knowledge: { id: 'knowledge', form: 'content', paramPatch: null, materialize: materializeContent },
  config: { id: 'config', form: 'config', paramPatch: null, materialize: materializeConfig },
  tool2: { id: 'tool2', form: 'tool', paramPatch: 'env', materialize: materializeTool },
};

export function buildMcpSpec(res: ResourceSpec, raw: Record<string, unknown>): Record<string, unknown> {
  const parsed = parseSource(res.source);
  const config = isPlainObject(raw) ? raw : {};
  const env = isPlainObject(config.env) ? config.env : undefined;
  const spec: Record<string, unknown> = {
    transport: res.transport ?? 'stdio',
    ...(env ? { env } : {}),
  };
  if (parsed.kind === 'npm') {
    spec.command = config.command ?? 'npx';
    spec.args = config.args ?? ['-y', res.source.replace(/^npm:/, '')];
  } else if (parsed.kind === 'pypi') {
    spec.command = config.command ?? 'uvx';
    spec.args = config.args ?? [parsed.locator.replace(/^pypi:/, '')];
  } else if (parsed.kind === 'http') {
    spec.url = parsed.locator;
  } else if (isPlainObject(config) && config.command) {
    spec.command = config.command;
    spec.args = config.args ?? [];
  } else {
    spec.command = undefined;
  }
  return spec;
}

function slug(id: string): string {
  return id.replace(/[^a-z0-9.-]+/gi, '-');
}

/** 目标文件名：取定位符最后一段；https 取路径末段。 */
export function fileNameOf(locator: string): string {
  const withoutScheme = locator.replace(/^[a-z]+:\/\//, '');
  const last = withoutScheme.split('/').filter(Boolean).pop() ?? 'resource';
  return last.includes('.') ? last : `${slug(last)}.md`;
}

/** https 来源能不能当归档解包（目前只认 tar 系）。 */
function looksLikeArchive(url: string): boolean {
  const path = url.split('?')[0] ?? url;
  return /\.(tar\.gz|tgz|tar)$/i.test(path);
}

/** 入口后缀推运行时；推不出就当二进制直接执行。 */
function inferRuntime(exec: string): ToolRuntime {
  if (/\.(c|m)?js$/i.test(exec)) return 'node';
  if (/\.py$/i.test(exec)) return 'python';
  if (/\.(sh|bash)$/i.test(exec)) return 'shell';
  return 'binary';
}
