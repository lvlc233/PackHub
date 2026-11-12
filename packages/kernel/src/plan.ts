import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type {
  Issue,
  Manifest,
  Plan,
  PlanAction,
  PlanActionInput,
  ResourceSpec,
  ResourceType,
  TargetId,
  ToolRuntime,
  VerifyCheck,
} from './types.ts';
import { interpolate, isPlainObject, canonicalize, sha256 } from './util.ts';
import { parseSource } from './ref.ts';
import { TARGET_VARS, type TargetVars } from './targets.ts';
import type { Graph } from './graph.ts';

export interface PlanOptions {
  target: TargetId;
  /** 覆盖落点变量（全局同步用不同的 skillsDir 等）；只允许 TargetVars 里的键 */
  targetVars: Partial<TargetVars>;
  packDir?: string;
  /** 这些类型的资源交给宿主/外部适配器处理，不进计划（例如全局同步时的 MCP） */
  skipResourceTypes?: ResourceType[];
}

export function buildPlan(
  manifest: Manifest,
  graph: Graph,
  opts: PlanOptions,
): { plan?: Plan; issues: Issue[] } {
  const issues: Issue[] = [];
  const targetVars: TargetVars = { ...TARGET_VARS[opts.target], ...opts.targetVars };
  const scope: Record<string, unknown> = {
    vars: manifest.vars ?? {},
    target: targetVars,
  };

  const missing: string[] = [];
  const interp = (value: unknown): unknown => interpolate(value, scope, missing);

  // 持久状态目录先算出来：resources 与 verify 都可能用 ${state.<id>}
  const statePaths: Record<string, string> = {};
  const stateIds = new Set<string>();
  for (const [i, spec] of (manifest.state ?? []).entries()) {
    if (stateIds.has(spec.id)) {
      issues.push({
        code: 'duplicate-state-id',
        severity: 'error',
        message: `state.id 重复：${spec.id}`,
      });
      continue;
    }
    stateIds.add(spec.id);
    const rawPath = spec.path ?? `${targetVars.root}/state/${spec.id}`;
    const resolvedPath = interp(rawPath);
    const rel = typeof resolvedPath === 'string' ? resolvedPath : String(rawPath);
    const normalized = normalizeStatePath(rel);
    if (!normalized) {
      issues.push({
        code: 'bad-state-path',
        severity: 'error',
        message: `state[${i}].path 必须是安装根内的相对路径：${rel}`,
      });
      continue;
    }
    statePaths[spec.id] = normalized;
  }
  scope.state = statePaths;

  const actions: PlanAction[] = [];
  const counters = new Map<string, number>();
  const push = (action: PlanActionInput): PlanAction => {
    const n = (counters.get(action.op) ?? 0) + 1;
    counters.set(action.op, n);
    const next = { ...action, actionId: action.actionId ?? `${action.op}#${n}` } as PlanAction;
    actions.push(next);
    return next;
  };

  // 资源装到哪儿、本地来源在哪；文件类补丁要按这个落点算目标、按来源读上游内容
  type InstalledResource = { type: ResourceType; kind: 'dir' | 'file'; to: string; from?: string };
  const installed = new Map<string, InstalledResource>();

  const packBase = resolve(opts.packDir ?? '.');
  const shimEmitted = new Map<string, string>();
  /** route 用的通用 shim：导入模块、按名字取函数、把后面的参数原样传过去。每种运行时一份。 */
  const pushRouteShim = (runtime: 'node' | 'python'): string => {
    const existing = shimEmitted.get(runtime);
    if (existing) return existing;
    const rel = `${targetVars.root}/shim/route.${runtime === 'node' ? 'mjs' : 'py'}`;
    push({ op: 'write', to: rel, content: ROUTE_SHIM[runtime], resource: `shim:${runtime}` });
    shimEmitted.set(runtime, rel);
    return rel;
  };

  // 状态目录：建目录，不写文件。放在最前面，后续动作引用 ${state.x} 时目录已经存在。
  for (const spec of manifest.state ?? []) {
    const to = statePaths[spec.id];
    if (!to) continue;
    push({
      op: 'state.dir',
      to,
      retain: spec.retain ?? 'keep',
      resource: `state:${spec.id}`,
    });
  }

  const excluded = [...graph.excluded];
  for (const id of graph.order) {
    const res = graph.resources.get(id);
    if (!res) continue;
    if (opts.skipResourceTypes?.includes(res.type)) {
      excluded.push({ resource: id, slot: res.slot ?? '', reason: 'host-managed' });
      continue;
    }
    // 资源级 target 裁剪：同一个 Pack 在 server 上可以不带 client-only 的资源
    if (res.targets && res.targets.length > 0 && !res.targets.includes(opts.target)) {
      excluded.push({ resource: id, slot: res.slot ?? '', reason: 'target-mismatch' });
      continue;
    }
    const parsed = parseSource(res.source);
    const at = `resources.${id}`;

    switch (res.type) {
      case 'mcp': {
        // MCP 由目标环境自己用 npx/uvx 拉起，安装期只登记，不预先下载包体
        push({
          op: 'register.mcp',
          spec: buildMcpSpec(res, interp(res.config ?? {}) as Record<string, unknown>),
          path: targetVars.configFile,
          resource: id,
        });
        break;
      }
      case 'skill': {
        if (parsed.kind === 'http' && !looksLikeArchive(res.source)) {
          issues.push({
            code: 'source-not-archive',
            severity: 'error',
            message: `skill 的 https 来源必须是 .tar.gz（现在是单文件）：${res.source}`,
            path: at,
          });
          break;
        }
        if (parsed.kind === 'local') {
          push({ op: 'link.skill', from: parsed.locator, to: `${targetVars.skillsDir}/${id}`, resource: id });
          installed.set(id, { type: res.type, kind: 'dir', to: `${targetVars.skillsDir}/${id}`, from: parsed.locator });
        } else {
          const fetched = push({
            op: 'fetch',
            uri: res.source,
            dest: `${targetVars.cacheDir}/${id}.tar.gz`,
            ...(res.integrity ? { integrity: res.integrity } : {}),
            ...(res.auth ? { auth: res.auth } : {}),
            resource: id,
          });
          const unpacked = push({
            op: 'unpack',
            from: `${targetVars.cacheDir}/${id}.tar.gz`,
            to: `${targetVars.cacheDir}/skills/${id}`,
            strip: 1,
            resource: id,
            dependsOn: [fetched.actionId],
          });
          // github:owner/repo/sub/path@ref 的 sub/path 只在解包后的仓库里取
          const from = parsed.subpath
            ? `${targetVars.cacheDir}/skills/${id}/${parsed.subpath}`
            : `${targetVars.cacheDir}/skills/${id}`;
          push({
            op: 'link.skill',
            from,
            to: `${targetVars.skillsDir}/${id}`,
            resource: id,
            dependsOn: [unpacked.actionId],
          });
          // 远程资源的正文要等安装时才取回：能做整文件替换与删除，做不了按锚点改
          installed.set(id, { type: res.type, kind: 'dir', to: `${targetVars.skillsDir}/${id}` });
        }
        break;
      }
      case 'knowledge':
      case 'prompt': {
        const dir = res.type === 'knowledge' ? targetVars.knowledgeDir : targetVars.promptsDir;
        const name = fileNameOf(parsed.locator);
        if (parsed.kind === 'local') {
          push({ op: 'write', from: parsed.locator, to: `${dir}/${name}`, resource: id });
          installed.set(id, { type: res.type, kind: 'file', to: `${dir}/${name}`, from: parsed.locator });
        } else {
          push({
            op: 'fetch',
            uri: res.source,
            dest: `${dir}/${name}`,
            ...(res.integrity ? { integrity: res.integrity } : {}),
            ...(res.auth ? { auth: res.auth } : {}),
            resource: id,
          });
          installed.set(id, { type: res.type, kind: 'file', to: `${dir}/${name}` });
        }
        break;
      }
      case 'config': {
        if (parsed.kind !== 'local') {
          // 远程片段没法在安装期安全读取；以前会静默合并一个空对象，看起来成功其实什么都没做
          issues.push({
            code: 'config-source-unsupported',
            severity: 'error',
            message: `config 资源只支持本地片段（./fragments/…），现在是 ${res.source}`,
            path: at,
          });
          break;
        }
        push({
          op: 'merge.config',
          path: targetVars.configFile,
          strategy: strategyFor(res.source),
          patchFrom: parsed.locator,
          resource: id,
        });
        break;
      }
      case 'tool': {
        const commands = res.commands ?? [];
        if (commands.length === 0) {
          // 老路径：npm / 归档，按 package.json 的 bin 建一个入口
          if (parsed.kind === 'local') {
            issues.push({
              code: 'tool-source-unsupported',
              severity: 'error',
              message: `tool 只支持 npm: / github: / .tar.gz 归档（现在是本地路径）：${res.source}；本地目录请写 commands`,
              path: at,
            });
            break;
          }
          if (parsed.kind === 'http' && !looksLikeArchive(res.source)) {
            issues.push({
              code: 'source-not-archive',
              severity: 'error',
              message: `tool 的 https 来源必须是 .tar.gz（现在是单文件）：${res.source}`,
              path: at,
            });
            break;
          }
          const fetched = push({
            op: 'fetch',
            uri: res.source,
            dest: `${targetVars.cacheDir}/${id}.tar.gz`,
            ...(res.integrity ? { integrity: res.integrity } : {}),
            ...(res.auth ? { auth: res.auth } : {}),
            resource: id,
          });
          const unpacked = push({
            op: 'unpack',
            from: `${targetVars.cacheDir}/${id}.tar.gz`,
            to: `${targetVars.cacheDir}/tools/${id}`,
            strip: 1,
            resource: id,
            dependsOn: [fetched.actionId],
          });
          {
            const configured = res.config?.bin;
            const command = typeof configured === 'string' ? configured : id;
            push({
              op: 'link.bin',
              from: `${targetVars.cacheDir}/tools/${id}`,
              to: `${targetVars.binDir}/${command}`,
              command,
              resource: id,
              dependsOn: [unpacked.actionId],
            });
          }
          break;
        }

        // 新路径：执行体整份落地，按 commands 逐条建入口
        const toolRoot = `${targetVars.cacheDir}/tools/${id}`;
        const localPath = parsed.kind === 'local' ? resolve(packBase, parsed.locator) : undefined;
        const sourceIsFile = localPath ? existsSync(localPath) && !statSync(localPath).isDirectory() : false;
        if (parsed.kind === 'local') {
          push({ op: 'copy', from: parsed.locator, to: toolRoot, resource: id });
        } else {
          if (parsed.kind === 'http' && !looksLikeArchive(res.source)) {
            issues.push({
              code: 'source-not-archive',
              severity: 'error',
              message: `tool 的 https 来源必须是 .tar.gz（现在是单文件）：${res.source}`,
              path: at,
            });
            break;
          }
          const fetched = push({
            op: 'fetch',
            uri: res.source,
            dest: `${targetVars.cacheDir}/${id}.tar.gz`,
            ...(res.integrity ? { integrity: res.integrity } : {}),
            ...(res.auth ? { auth: res.auth } : {}),
            resource: id,
          });
          push({
            op: 'unpack',
            from: `${targetVars.cacheDir}/${id}.tar.gz`,
            to: toolRoot,
            strip: 1,
            resource: id,
            dependsOn: [fetched.actionId],
          });
        }

        const names = new Set<string>();
        for (const [ci, cmd] of commands.entries()) {
          const label = `${at}.commands[${ci}]`;
          if (!cmd.name) {
            issues.push({ code: 'tool-command-invalid', severity: 'error', message: `${label} 缺少 name`, path: label });
            continue;
          }
          if (names.has(cmd.name)) {
            issues.push({
              code: 'duplicate-command-name',
              severity: 'error',
              message: `${label}：命令名重复：${cmd.name}`,
              path: label,
            });
            continue;
          }
          names.add(cmd.name);

          const exec = cmd.exec ?? (sourceIsFile ? fileNameOf(parsed.locator) : undefined);
          if (!exec) {
            issues.push({
              code: 'tool-command-invalid',
              severity: 'error',
              message: `${label}：source 是目录，必须写 exec 指明执行体`,
              path: label,
            });
            continue;
          }
          const runtime = cmd.runtime ?? inferRuntime(exec);
          const shim = cmd.shim ?? res.shim ?? 'auto';
          if (shim === 'route') {
            if (!cmd.call) {
              issues.push({
                code: 'tool-route-needs-call',
                severity: 'error',
                message: `${label}：shim: route 要写 call（模块里的函数名）`,
                path: label,
              });
              continue;
            }
            if (runtime !== 'node' && runtime !== 'python') {
              issues.push({
                code: 'tool-route-unsupported',
                severity: 'error',
                message: `${label}：route 只支持 node / python，现在是 ${runtime}`,
                path: label,
              });
              continue;
            }
            const shimPath = pushRouteShim(runtime);
            push({
              op: 'link.exec',
              to: `${targetVars.binDir}/${cmd.name}`,
              runtime,
              entry: shimPath,
              module: `${toolRoot}/${exec}`,
              args: [cmd.call, ...(cmd.args ?? [])],
              resource: id,
            });
            continue;
          }
          push({
            op: 'link.exec',
            to: `${targetVars.binDir}/${cmd.name}`,
            runtime,
            entry: `${toolRoot}/${exec}`,
            args: cmd.args ?? [],
            resource: id,
          });
        }
        break;
      }
      default: {
        // 加资源类型时这里会编译失败：逼着同时补安装动作，别让新类型静默进不了计划
        const unhandled: never = res.type;
        issues.push({
          code: 'unknown-resource-type',
          severity: 'error',
          message: `未知资源类型：${String(unhandled)}`,
          path: at,
        });
      }
    }
  }

  // 二次修改：按资源定位到文件或段落，排在资源动作之后，才盖得住刚装好的东西。
  const claimed = new Map<string, string>();
  const claim = (path: string, label: string): boolean => {
    const prev = claimed.get(path);
    if (prev) {
      issues.push({
        code: 'modify-conflict',
        severity: 'error',
        message: `${path} 被两条补丁同时改：${prev}、${label}`,
      });
      return false;
    }
    claimed.set(path, label);
    return true;
  };
  const insidePack = (abs: string): boolean => abs === packBase || abs.startsWith(packBase + sep);

  for (const [i, m] of (manifest.modify ?? []).entries()) {
    const label = `modify[${i}]`;
    const resourceId = `modify#${i + 1}`;
    const info = installed.get(m.resource);
    if (!info) {
      // 未知资源由 graph 报；这里只补「资源在、但没有文件可改」这一类（mcp / config / tool）
      const res = manifest.resources.find((r) => r.id === m.resource);
      if (res && !isPlainObject(m.with)) {
        issues.push({
          code: 'modify-not-file',
          severity: 'error',
          message: `${label}：${m.resource} 是 ${res.type}，没有可改的文件`,
        });
      }
      continue; // 参数补丁由 graph 合并
    }
    if (isPlainObject(m.with)) continue;

    const value = m.with;
    const where = m.where ?? 'replace';
    const isPath = typeof value === 'string' && PACK_PATH_RE.test(value);
    const fileRel = m.file ? normalizeRel(m.file) : undefined;
    if (m.file && !fileRel) {
      issues.push({ code: 'modify-invalid', severity: 'error', message: `${label}：file 必须是包内的相对路径：${m.file}` });
      continue;
    }
    if (info.kind === 'file' && fileRel && fileRel !== fileNameOf(info.to)) {
      issues.push({
        code: 'modify-invalid',
        severity: 'error',
        message: `${label}：${m.resource} 是单文件资源，file 只能是 ${fileNameOf(info.to)}`,
      });
      continue;
    }

    const absWith = isPath ? resolve(packBase, value) : undefined;
    if (absWith) {
      if (!insidePack(absWith)) {
        issues.push({ code: 'modify-outside-pack', severity: 'error', message: `${label}：指向包目录之外：${value}` });
        continue;
      }
      if (!existsSync(absWith)) {
        issues.push({ code: 'modify-source-missing', severity: 'error', message: `${label}：找不到 ${value}` });
        continue;
      }
    }
    const withIsDir = absWith ? statSync(absWith).isDirectory() : false;

    // 目标文件（相对安装根）：目录资源必须写 file，单文件资源就是它自己
    const targetPath = info.kind === 'file' ? info.to : fileRel ? `${info.to}/${fileRel}` : undefined;

    if (withIsDir) {
      if (m.file || m.at || where !== 'replace') {
        issues.push({
          code: 'modify-invalid',
          severity: 'error',
          message: `${label}：目录补丁不带 file / at / where——整目录逐个文件叠上去`,
        });
        continue;
      }
      const relDir = String(value).replace(/^\.\//, '').replace(/\/+$/, '');
      const files = walkFiles(absWith!);
      if (files.length === 0) {
        issues.push({ code: 'modify-empty', severity: 'warning', message: `${label}：目录是空的：${value}` });
      }
      for (const rel of files) {
        const to = `${info.to}/${rel}`;
        if (!claim(to, label)) continue;
        push({ op: 'write', from: `${relDir}/${rel}`, to, resource: resourceId });
      }
      continue;
    }

    if (!targetPath) {
      issues.push({
        code: 'modify-needs-file',
        severity: 'error',
        message: `${label}：${m.resource} 是目录资源，要写 file 指明改哪个文件`,
      });
      continue;
    }

    // 按锚点改一段 / 删一段：要读上游正文，只有本地来源读得到
    if (m.at) {
      if (info.from === undefined) {
        issues.push({
          code: 'modify-remote-unsupported',
          severity: 'error',
          message: `${label}：${m.resource} 是远程资源，正文要等安装时才取回；只能整文件替换或删除`,
        });
        continue;
      }
      const upstreamAbs = info.kind === 'file' ? resolve(packBase, info.from) : resolve(packBase, info.from, fileRel ?? '');
      if (!existsSync(upstreamAbs)) {
        issues.push({
          code: 'modify-file-missing',
          severity: 'error',
          message: `${label}：上游没有这个文件：${m.file ?? info.from}`,
        });
        continue;
      }
      const upstream = readFileSync(upstreamAbs, 'utf8');
      const replacement = value === null ? null : isPath ? readFileSync(absWith!, 'utf8') : value;
      const applied = applyAnchor(upstream, m.at, where, replacement, m.nth);
      if (!applied.ok) {
        if (applied.reason === 'missing') {
          issues.push({
            code: 'modify-anchor-missing',
            severity: 'error',
            message: `${label}：找不到锚点「${m.at}」`,
          });
        } else if (applied.reason === 'out-of-range') {
          issues.push({
            code: 'modify-nth-out-of-range',
            severity: 'error',
            message: `${label}：锚点「${m.at}」只有 ${applied.count} 处，nth: ${m.nth} 超出范围（1..${applied.count}）`,
          });
        } else {
          const list = applied.candidates
            .map((c, i) => `  ${i + 1}. 第 ${c.line} 行${c.parent ? `（上面最近的标题：${c.parent}）` : ''}`)
            .join('\n');
          issues.push({
            code: 'modify-anchor-ambiguous',
            severity: 'error',
            message: `${label}：锚点「${m.at}」命中 ${applied.candidates.length} 处，补丁不知道改哪个：\n${list}\n用 nth 指定第几个：at: '${m.at}', nth: 1`,
          });
        }
        continue;
      }
      if (applied.text === upstream) {
        issues.push({ code: 'modify-noop', severity: 'warning', message: `${label}：改完和原文一样，这条补丁可能过期了` });
        continue;
      }
      if (!claim(targetPath, label)) continue;
      push({ op: 'write', to: targetPath, content: applied.text, resource: resourceId });
      continue;
    }

    if (where !== 'replace') {
      issues.push({ code: 'modify-invalid', severity: 'error', message: `${label}：where 要配合 at 用` });
      continue;
    }
    if (!claim(targetPath, label)) continue;
    if (value === null) {
      push({ op: 'delete', to: targetPath, resource: resourceId });
    } else if (isPath) {
      push({ op: 'write', from: value.replace(/^\.\//, ''), to: targetPath, resource: resourceId });
    } else {
      push({ op: 'write', to: targetPath, content: value, resource: resourceId });
    }
  }

  // 宿主的指令面：把"这个包提供什么、文件在哪"写进 AGENTS.md / CLAUDE.md 的托管块。
  // 这不是行为编排，只是指路——真正怎么用由 skill 与 agent 决定。
  const instructionFile = targetVars.instructionFile;
  if (instructionFile) {
    push({
      op: 'instruction',
      file: instructionFile,
      blockId: manifest.metadata.name,
      content: instructionBlock(manifest, graph, targetVars, statePaths),
    });
  }

  for (const [i, spec] of (manifest.install?.exec ?? []).entries()) {
    push({
      op: 'exec',
      command: interp(spec.command) as string,
      args: interpolate(spec.args ?? [], scope, []) as string[],
      ...(spec.cwd ? { cwd: interp(spec.cwd) as string } : {}),
      ...(spec.env ? { env: interp(spec.env) as Record<string, string> } : {}),
      ...(spec.timeout ? { timeout: spec.timeout } : {}),
      approval: 'required',
      actionId: `exec#${i + 1}`,
    });
  }

  const verify = (manifest.verify ?? []).map((check) => {
    const resolved = interp(check) as VerifyCheck;
    if (resolved.type === 'knowledge-integrity') {
      // 计划里带上期望哈希，校验时才能核对「装进来的字节」而不是只看文件在不在
      const integrity =
        graph.resources.get(resolved.resource)?.integrity ??
        manifest.resources.find((r) => r.id === resolved.resource)?.integrity;
      if (integrity) resolved.integrity = integrity;
    }
    return resolved;
  });
  for (const key of new Set(missing)) {
    issues.push({
      code: 'undefined-variable',
      severity: 'error',
      message: `模板变量未定义：\${${key}}`,
    });
  }

  issues.push(...detectConflicts(actions, packBase, manifest));

  if (issues.some((i) => i.severity === 'error')) return { issues };

  const plan: Omit<Plan, 'planHash'> = {
    apiVersion: 'packhub.dev/plan/v0',
    pack: { name: manifest.metadata.name, version: manifest.metadata.version },
    target: opts.target,
    actions,
    excluded,
    verify,
  };
  return { plan: { ...plan, planHash: sha256(canonicalize(plan)) }, issues };
}

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

function strategyFor(source: string): 'json-merge' | 'yaml-merge' {
  return /\.json$/i.test(source) ? 'json-merge' : 'yaml-merge';
}

function slug(id: string): string {
  return id.replace(/[^a-z0-9.-]+/gi, '-');
}

/** 目标文件名：取定位符最后一段；https 取路径末段。 */
function fileNameOf(locator: string): string {
  const withoutScheme = locator.replace(/^[a-z]+:\/\//, '');
  const last = withoutScheme.split('/').filter(Boolean).pop() ?? 'resource';
  return last.includes('.') ? last : `${slug(last)}.md`;
}

/* ---------- 覆盖与冲突 ---------- */

/** 递归列出目录下所有文件（posix 相对路径）。 */
function walkFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      // 覆盖层经常要改 .packhub/ 下的文件，不能把点目录一律跳过
      if (entry.name === '.git' || entry.name === 'node_modules') continue;
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const abs = resolve(dir, entry.name);
      if (entry.isDirectory()) walk(abs, rel);
      else if (statSync(abs).isFile()) out.push(rel);
    }
  };
  walk(root, '');
  return out.sort();
}

function normalizeRel(p: string): string {
  return p.replace(/^\.\//, '').replace(/\/+$/, '') || '.';
}

/** 状态目录路径：安装根内的相对 POSIX 路径；绝对路径、盘符与 .. 一律拒绝。 */
function normalizeStatePath(value: string): string | null {
  const rel = value.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
  if (!rel || rel === '.') return null;
  if (/^([a-zA-Z]:\/|\/)/.test(rel)) return null;
  if (rel.split('/').some((part) => part === '..')) return null;
  return rel;
}

function flattenKeys(value: unknown, prefix = ''): string[] {
  if (!isPlainObject(value)) return prefix ? [prefix] : [];
  const keys: string[] = [];
  for (const [k, v] of Object.entries(value)) {
    const next = prefix ? `${prefix}.${k}` : k;
    if (isPlainObject(v)) keys.push(...flattenKeys(v, next));
    else keys.push(next);
  }
  return keys;
}

function readStructured(packDir: string, rel: string): unknown {
  const abs = resolve(packDir, rel);
  if (!existsSync(abs)) return {};
  const text = readFileSync(abs, 'utf8');
  return /\.json$/i.test(rel) ? JSON.parse(text) : (parseYaml(text) ?? {});
}

/** 同一个目标被两个来源写、或者同一个配置键被两处改，都算冲突。 */
function detectConflicts(
  actions: PlanAction[],
  packDir: string,
  manifest: Manifest,
): Issue[] {
  const issues: Issue[] = [];
  const fsPaths = new Map<string, { id: string; modify: boolean }[]>();
  const configKeys = new Map<string, string[]>();

  for (const a of actions) {
    const isModify = (a.resource ?? '').startsWith('modify#');
    if (
      a.op === 'write' ||
      a.op === 'delete' ||
      a.op === 'link.skill' ||
      a.op === 'unpack' ||
      a.op === 'link.bin' ||
      a.op === 'state.dir'
    ) {
      const list = fsPaths.get(a.to) ?? [];
      list.push({ id: a.actionId, modify: isModify });
      fsPaths.set(a.to, list);
    }
    if (a.op === 'merge.config') {
      const patch = a.patch ?? readStructured(packDir, a.patchFrom ?? '');
      for (const key of flattenKeys(patch)) {
        const composite = `${a.path}::${key}`;
        configKeys.set(composite, [...(configKeys.get(composite) ?? []), a.actionId]);
      }
    }
    if (a.op === 'register.mcp') {
      const path = a.path ?? '.packhub/config.json';
      const composite = `${path}::mcpServers.${a.resource ?? 'mcp'}`;
      configKeys.set(composite, [...(configKeys.get(composite) ?? []), a.actionId]);
    }
  }

  for (const [path, entries] of fsPaths) {
    const modifiers = entries.filter((e) => e.modify);
    const producers = entries.filter((e) => !e.modify);
    if (producers.length > 1) {
      issues.push({
        code: 'output-conflict',
        severity: 'error',
        message: `${path} 被多个动作同时写：${producers.map((p) => p.id).join(', ')}`,
      });
    }
    if (modifiers.length === 1 && producers.length > 0) {
      issues.push({
        code: 'modify-shadows',
        severity: 'warning',
        message: `${path} 会被补丁盖掉（${modifiers[0]?.id} 覆盖 ${producers[0]?.id}）；确认是有意的`,
      });
    }
  }

  for (const [composite, ids] of configKeys) {
    if (ids.length > 1) {
      const [path, key] = composite.split('::');
      issues.push({
        code: 'config-key-conflict',
        severity: 'error',
        message: `${path} 的键 ${key} 被多处修改：${ids.join(', ')}（后写的会静默赢，必须显式定夺）`,
      });
    }
  }

  return issues;
}

/** https 来源能不能当归档解包（目前只认 tar 系）。 */
function looksLikeArchive(url: string): boolean {
  const path = url.split('?')[0] ?? url;
  return /\.(tar\.gz|tgz|tar)$/i.test(path);
}

/** `with` 是路径还是内联文本：只有 ./ ../ 或带 scheme 的才算路径。 */
const PACK_PATH_RE = /^(\.\.?\/|[a-z][a-z0-9+.-]*:)/i;

/** 入口后缀推运行时；推不出就当二进制直接执行。 */
function inferRuntime(exec: string): ToolRuntime {
  if (/\.(c|m)?js$/i.test(exec)) return 'node';
  if (/\.py$/i.test(exec)) return 'python';
  if (/\.(sh|bash)$/i.test(exec)) return 'shell';
  return 'binary';
}

/**
 * route 模式的通用 shim：argv 是 `<模块> <函数> <参数…>`，
 * 导入模块、取函数、把后面的参数原样传过去。不解析参数、不做 schema。
 */
const ROUTE_SHIM: Record<'node' | 'python', string> = {
  python: `import importlib.util, json, sys
module_path, fn = sys.argv[1], sys.argv[2]
spec = importlib.util.spec_from_file_location("packhub_tool", module_path)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
result = getattr(mod, fn)(*sys.argv[3:])
if result is not None:
    sys.stdout.write(result if isinstance(result, str) else json.dumps(result, ensure_ascii=False))
    sys.stdout.write("\\n")
`,
  node: `import { pathToFileURL } from 'node:url';
const [modulePath, fn, ...rest] = process.argv.slice(2);
const mod = await import(pathToFileURL(modulePath).href);
const out = await mod[fn](...rest);
if (out !== undefined) {
  process.stdout.write(typeof out === 'string' ? out : JSON.stringify(out));
  process.stdout.write('\\n');
}
`,
};

export interface AnchorCandidate {
  /** 1 起的行号 */
  line: number;
  /** 这行上面最近的标题，给人认位置用 */
  parent?: string;
}

/**
 * 在正文里定位 `at` 并替换 / 插入 / 删除。
 * - `at` 以 `#` 开头：整节，从这行到下一个同级或更高级标题
 * - 否则：按整行匹配
 * 命中多处时用 `nth` 指定第几个；不给就要求唯一，不猜。
 */
export function applyAnchor(
  text: string,
  at: string,
  where: 'replace' | 'before' | 'after',
  replacement: string | null,
  nth?: number,
):
  | { ok: true; text: string }
  | { ok: false; reason: 'missing' }
  | { ok: false; reason: 'ambiguous'; candidates: AnchorCandidate[] }
  | { ok: false; reason: 'out-of-range'; count: number } {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const trailing = text.endsWith(eol);
  const lines = (trailing ? text.slice(0, -eol.length) : text).split(eol);
  const needle = at.trim();
  const hits: number[] = [];
  lines.forEach((line, i) => {
    if (line.trim() === needle) hits.push(i);
  });
  if (hits.length === 0) return { ok: false, reason: 'missing' };

  let start: number;
  if (nth !== undefined) {
    if (!Number.isInteger(nth) || nth < 1 || nth > hits.length) {
      return { ok: false, reason: 'out-of-range', count: hits.length };
    }
    start = hits[nth - 1]!;
  } else {
    if (hits.length > 1) {
      return {
        ok: false,
        reason: 'ambiguous',
        candidates: hits.map((i) => ({ line: i + 1, parent: nearestHeading(lines, i) })),
      };
    }
    start = hits[0]!;
  }

  let end = start + 1;
  if (needle.startsWith('#')) {
    const level = (needle.match(/^#+/) ?? ['#'])[0]!.length;
    while (end < lines.length) {
      const m = (lines[end] ?? '').match(/^(#{1,6})\s/);
      if (m && m[1]!.length <= level) break;
      end += 1;
    }
  }
  const block = replacement === null ? [] : splitBlock(replacement, eol);
  if (where === 'before') lines.splice(start, 0, ...block);
  else if (where === 'after') lines.splice(end, 0, ...block);
  else lines.splice(start, end - start, ...block);
  return { ok: true, text: lines.join(eol) + (trailing ? eol : '') };
}

/** 这一行上面最近的标题：报错时让人认出是哪个块。 */
function nearestHeading(lines: string[], index: number): string | undefined {
  for (let i = index - 1; i >= 0; i--) {
    if (/^#{1,6}\s+/.test(lines[i] ?? '')) return (lines[i] ?? '').trim();
  }
  return undefined;
}

/** 替换内容自带结尾换行时，按行切开不要多出空行。 */
function splitBlock(text: string, eol: string): string[] {
  const body = text.endsWith(eol) ? text.slice(0, -eol.length) : text;
  return body.split(eol);
}

/** 给宿主的指路块：这个包提供了什么、文件在哪。不描述步骤。 */
function instructionBlock(
  manifest: Manifest,
  graph: Graph,
  targetVars: TargetVars,
  statePaths: Record<string, string>,
): string {
  const active = manifest.resources.filter((r) => graph.resources.has(r.id));
  const stateLines = (manifest.state ?? [])
    .filter((spec) => statePaths[spec.id])
    .map((spec) => {
      const keep = (spec.retain ?? 'keep') === 'keep' ? '卸载保留' : '卸载删除';
      const note = spec.description ? `：${spec.description}` : '';
      return `- \`${spec.id}\` → \`${statePaths[spec.id]}\`（${keep}）${note}`;
    });
  const lines: string[] = [
    `这个项目装了一个整合包：**${manifest.metadata.title ?? manifest.metadata.name}**（${manifest.metadata.version}）。`,
    '',
    manifest.metadata.description ?? '',
    '',
    '可用的能力：',
    ...active.map((r) => {
      const caps = (r.provides ?? []).join('、');
      return `- \`${r.id}\`（${r.type}）${caps ? ` → ${caps}` : ''}`;
    }),
    ...(() => {
      const commands = active.flatMap((r) =>
        (r.commands ?? []).map((c) => {
          const first = c.usage.split('\n').find((l) => l.trim())?.trim() ?? c.usage.trim();
          return `- \`${c.name}\`${c.async ? '（异步调度）' : ''}：${first}`;
        }),
      );
      return commands.length > 0 ? ['', '可用的命令：', ...commands] : [];
    })(),
    '',
    '文件位置：',
    `- skills：\`${targetVars.skillsDir}\``,
    `- 知识：\`${targetVars.knowledgeDir}\``,
    `- 提示词：\`${targetVars.promptsDir}\``,
    `- 工具入口：\`${targetVars.binDir}\``,
    `- 配置：\`${targetVars.configFile}\``,
    ...(stateLines.length > 0 ? ['', '持久状态（数据，不是包产物）：', ...stateLines] : []),
  ];
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd();
}
