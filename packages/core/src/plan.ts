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
        if (parsed.kind === 'local') {
          push({ op: 'link.skill', from: parsed.locator, to: `${targetVars.skillsDir}/${id}`, resource: id });
        } else {
          const fetched = push({
            op: 'fetch',
            uri: res.source,
            dest: `${targetVars.cacheDir}/${id}.tar.gz`,
            ...(res.integrity ? { integrity: res.integrity } : {}),
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
          push({
            op: 'link.skill',
            from: `${targetVars.cacheDir}/skills/${id}`,
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
        const fetched = push({
          op: 'fetch',
          uri: res.source,
          dest: `${targetVars.cacheDir}/${id}.tar.gz`,
          ...(res.integrity ? { integrity: res.integrity } : {}),
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

  if (issues.some((i) => i.severity === 'error')) return { issues };

  const plan: Omit<Plan, 'planHash'> = {
    apiVersion: 'packhub.dev/plan/v0.0.1',
    pack: { name: manifest.metadata.name, version: manifest.metadata.version },
    target: opts.target,
    actions,
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
