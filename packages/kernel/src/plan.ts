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
  VerifyCheck,
} from './types.ts';
import { interpolate, isPlainObject, canonicalize, sha256 } from './util.ts';
import { parseSource } from './ref.ts';
import type { Graph } from './graph.ts';

export interface PlanOptions {
  target: TargetId;
  /** adapter 提供的路径变量（相对 Pack 目录） */
  targetVars: Record<string, string>;
  packDir?: string;
  /** 这些类型的资源交给宿主/外部适配器处理，不进计划（例如全局同步时的 MCP） */
  skipResourceTypes?: ResourceType[];
}

/** dir adapter 的默认路径约定：物化到 .packhub，不碰宿主的配置文件。 */
export const DIR_TARGET_VARS: Record<string, string> = {
  root: '.packhub',
  cacheDir: '.packhub/cache',
  skillsDir: '.packhub/skills',
  knowledgeDir: '.packhub/knowledge',
  promptsDir: '.packhub/prompts',
  binDir: '.packhub/bin',
  configFile: '.packhub/config.json',
};

/** 各宿主的投影落点：从"物化"变成"接进 agent 会读的位置"。 */
export const TARGET_VARS: Record<TargetId, Record<string, string>> = {
  dir: DIR_TARGET_VARS,
  'claude-code': {
    root: '.packhub',
    cacheDir: '.packhub/cache',
    skillsDir: '.claude/skills',
    knowledgeDir: '.packhub/knowledge',
    promptsDir: '.packhub/prompts',
    binDir: '.packhub/bin',
    configFile: '.mcp.json',
    instructionFile: 'CLAUDE.md',
  },
  dsh: {
    root: '.packhub',
    cacheDir: '.packhub/cache',
    // DSH 的 skills 与 MCP 目前挂在 profile（全局），项目级只做"指路"
    skillsDir: '.packhub/skills',
    knowledgeDir: '.packhub/knowledge',
    promptsDir: '.packhub/prompts',
    binDir: '.packhub/bin',
    configFile: '.packhub/config.json',
    instructionFile: 'AGENTS.md',
  },
  codex: {
    root: '.packhub',
    cacheDir: '.packhub/cache',
    skillsDir: '.codex/skills',
    knowledgeDir: '.packhub/knowledge',
    promptsDir: '.packhub/prompts',
    binDir: '.packhub/bin',
    configFile: '.packhub/config.json',
    instructionFile: 'AGENTS.md',
  },
};

export function buildPlan(
  manifest: Manifest,
  graph: Graph,
  opts: PlanOptions,
): { plan?: Plan; issues: Issue[] } {
  const issues: Issue[] = [];
  const targetVars = { ...(TARGET_VARS[opts.target] ?? DIR_TARGET_VARS), ...opts.targetVars };
  const scope: Record<string, unknown> = {
    vars: manifest.vars ?? {},
    target: targetVars,
  };

  const missing: string[] = [];
  const interp = (value: unknown): unknown => interpolate(value, scope, missing);

  // 持久状态目录先算出来：resources / composition.env / verify 都可能用 ${state.<id>}
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
    const rawPath = spec.path ?? `${targetVars.root ?? '.packhub'}/state/${spec.id}`;
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

  // 接线：Pack 级 env 注入到目标配置，让所有资源都能读到
  const packEnv = manifest.composition?.env;
  if (packEnv && Object.keys(packEnv).length > 0) {
    push({
      op: 'merge.config',
      path: targetVars.configFile ?? '.packhub/config.json',
      strategy: 'json-merge',
      patch: { env: interp(packEnv) },
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
          path: targetVars.configFile ?? '.packhub/config.json',
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
        }
        break;
      }
      case 'knowledge':
      case 'prompt': {
        const dir = res.type === 'knowledge' ? targetVars.knowledgeDir : targetVars.promptsDir;
        const name = fileNameOf(parsed.locator);
        if (parsed.kind === 'local') {
          push({ op: 'write', from: parsed.locator, to: `${dir}/${name}`, resource: id });
        } else {
          push({
            op: 'fetch',
            uri: res.source,
            dest: `${dir}/${name}`,
            ...(res.integrity ? { integrity: res.integrity } : {}),
            ...(res.auth ? { auth: res.auth } : {}),
            resource: id,
          });
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
          path: targetVars.configFile ?? '.packhub/config.json',
          strategy: strategyFor(res.source),
          patchFrom: parsed.locator,
          resource: id,
        });
        break;
      }
      case 'tool': {
        if (parsed.kind === 'local') {
          issues.push({
            code: 'tool-source-unsupported',
            severity: 'error',
            message: `tool 只支持 npm: / github: / .tar.gz 归档（现在是本地路径）：${res.source}`,
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
        // tool 的价值在“能执行”：解包完在 binDir 下生成一个能直接跑的 wrapper
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

  // 覆盖层：装完之后按路径盖上去（mod 的 mod）。必须排在资源之后，才盖得住生成文件。
  const packDir = opts.packDir ?? '.';
  for (const [i, ov] of (manifest.overlays ?? []).entries()) {
    const relFrom = ov.from.replace(/^\.\//, '').replace(/\/+$/, '');
    const absFrom = resolve(packDir, relFrom);
    const base = resolve(packDir);
    // extends 继承来的覆盖层会落在父包目录（../…）：只读它、写目标仍在安装根内
    const inherited = ov.from.startsWith('../');
    if (!inherited && absFrom !== base && !absFrom.startsWith(base + sep)) {
      issues.push({
        code: 'overlay-outside-pack',
        severity: 'error',
        message: `overlays[${i}] 指向包目录之外：${ov.from}`,
      });
      continue;
    }
    if (!existsSync(absFrom)) {
      issues.push({
        code: 'overlay-missing',
        severity: 'error',
        message: `overlays[${i}] 指向的目录不存在：${ov.from}`,
      });
      continue;
    }
    const files = walkFiles(absFrom);
    if (files.length === 0) {
      issues.push({
        code: 'overlay-empty',
        severity: 'warning',
        message: `overlays[${i}] 目录是空的：${ov.from}`,
      });
    }
    const toRoot = normalizeRel(ov.to ?? '.');
    for (const rel of files) {
      if (ov.include && ov.include.length > 0 && !ov.include.some((p) => rel.endsWith(p))) continue;
      const to = toRoot === '.' ? rel : `${toRoot}/${rel}`;
      push({
        op: 'write',
        from: `${relFrom}/${rel}`,
        to,
        resource: `overlay#${i + 1}`,
      });
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

  issues.push(...detectConflicts(actions, packDir, manifest));

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
  const fsPaths = new Map<string, { id: string; overlay: boolean }[]>();
  const configKeys = new Map<string, string[]>();

  for (const a of actions) {
    const isOverlay = (a.resource ?? '').startsWith('overlay#');
    if (
      a.op === 'write' ||
      a.op === 'link.skill' ||
      a.op === 'unpack' ||
      a.op === 'link.bin' ||
      a.op === 'state.dir'
    ) {
      const list = fsPaths.get(a.to) ?? [];
      list.push({ id: a.actionId, overlay: isOverlay });
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
    const overlays = entries.filter((e) => e.overlay);
    const producers = entries.filter((e) => !e.overlay);
    if (producers.length > 1) {
      issues.push({
        code: 'output-conflict',
        severity: 'error',
        message: `${path} 被多个动作同时写：${producers.map((p) => p.id).join(', ')}`,
      });
    }
    if (overlays.length > 1) {
      issues.push({
        code: 'overlay-conflict',
        severity: 'error',
        message: `${path} 被多个覆盖层同时改：${overlays.map((o) => o.id).join(', ')}`,
      });
    }
    if (overlays.length === 1 && producers.length > 0) {
      issues.push({
        code: 'overlay-shadows',
        severity: 'warning',
        message: `${path} 会被覆盖层盖掉（${overlays[0]?.id} 覆盖 ${producers[0]?.id}）；确认是有意的`,
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

  // overrides 里引用了不存在的资源，等于什么都没覆盖
  for (const ov of manifest.overrides ?? []) {
    if (!manifest.resources.some((r) => r.id === ov.resource)) {
      issues.push({
        code: 'override-unknown-resource',
        severity: 'error',
        message: `overrides 指向不存在的资源：${ov.resource}`,
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

/** 给宿主的指路块：这个包提供了什么、文件在哪。不描述步骤。 */
function instructionBlock(
  manifest: Manifest,
  graph: Graph,
  targetVars: Record<string, string>,
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
