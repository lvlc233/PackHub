import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type {
  Issue,
  Manifest,
  Plan,
  PlanAction,
  PlanActionInput,
  ResourceSpec,
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
}

/** dir adapter 的默认路径约定；v0.0.1 只有这一个 adapter。 */
export const DIR_TARGET_VARS: Record<string, string> = {
  root: '.packhub',
  cacheDir: '.packhub/cache',
  skillsDir: '.packhub/skills',
  knowledgeDir: '.packhub/knowledge',
  promptsDir: '.packhub/prompts',
  configFile: '.packhub/config.json',
};

export function buildPlan(
  manifest: Manifest,
  graph: Graph,
  opts: PlanOptions,
): { plan?: Plan; issues: Issue[] } {
  const issues: Issue[] = [];
  const targetVars = { ...DIR_TARGET_VARS, ...opts.targetVars };
  const scope: Record<string, unknown> = {
    vars: manifest.vars ?? {},
    target: targetVars,
    paths: manifest.paths ?? {},
  };

  const missing: string[] = [];
  const interp = (value: unknown): unknown => interpolate(value, scope, missing);

  const actions: PlanAction[] = [];
  const counters = new Map<string, number>();
  const push = (action: PlanActionInput): PlanAction => {
    const n = (counters.get(action.op) ?? 0) + 1;
    counters.set(action.op, n);
    const next = { ...action, actionId: action.actionId ?? `${action.op}#${n}` } as PlanAction;
    actions.push(next);
    return next;
  };

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

  for (const id of graph.order) {
    const res = graph.resources.get(id);
    if (!res) continue;
    const parsed = parseSource(res.source);
    const at = `resources.${id}`;

    switch (res.type) {
      case 'mcp': {
        // MCP 由目标环境自己用 npx/uvx 拉起，安装期只登记，不预先下载包体
        push({
          op: 'register.mcp',
          spec: mcpSpec(res, interp(res.config ?? {}) as Record<string, unknown>),
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
          to: `${targetVars.cacheDir}/tools/${id}`,
          strip: 1,
          resource: id,
          dependsOn: [fetched.actionId],
        });
        break;
      }
      default:
        issues.push({
          code: 'unknown-resource-type',
          severity: 'error',
          message: `未知资源类型：${String(res.type)}`,
          path: at,
        });
    }
  }

  // 覆盖层：装完之后按路径盖上去（mod 的 mod）。必须排在资源之后，才盖得住生成文件。
  const packDir = opts.packDir ?? '.';
  for (const [i, ov] of (manifest.overlays ?? []).entries()) {
    const relFrom = ov.from.replace(/^\.\//, '').replace(/\/+$/, '');
    const absFrom = resolve(packDir, relFrom);
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

  for (const [i, spec] of (manifest.install?.exec ?? []).entries()) {
    push({
      op: 'exec',
      command: spec.command,
      args: interpolate(spec.args ?? [], scope, []) as string[],
      ...(spec.cwd ? { cwd: spec.cwd as string } : {}),
      approval: 'required',
      actionId: `exec#${i + 1}`,
    });
  }

  const verify = (manifest.verify ?? []).map((check) => interp(check) as VerifyCheck);
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
    excluded: graph.excluded,
    verify,
  };
  return { plan: { ...plan, planHash: sha256(canonicalize(plan)) }, issues };
}

function mcpSpec(res: ResourceSpec, raw: Record<string, unknown>): Record<string, unknown> {
  const parsed = parseSource(res.source);
  const config = isPlainObject(raw) ? raw : {};
  const env = isPlainObject(config.env) ? config.env : undefined;
  const spec: Record<string, unknown> = {
    transport: res.transport ?? 'stdio',
    ...(env ? { env } : {}),
  };
  if (parsed.kind === 'npm') {
    spec.command = config.command ?? 'npx';
    spec.args = config.args ?? ['-y', res.source];
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
    if (a.op === 'write' || a.op === 'link.skill' || a.op === 'unpack') {
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
      const composite = `${'.packhub/config.json'}::mcpServers.${a.resource ?? 'mcp'}`;
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
