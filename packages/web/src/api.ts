export interface Issue {
  code: string;
  severity: 'error' | 'warning';
  message: string;
  path?: string;
}

export interface ResourceSpec {
  id: string;
  type: string;
  source: string;
  transport?: string;
  integrity?: string;
  provides?: string[];
  needs?: string[];
}

export interface PlanAction {
  actionId: string;
  op: string;
  resource?: string;
  to?: string;
  dest?: string;
  path?: string;
  from?: string;
  command?: string;
  args?: string[];
}

export interface Plan {
  apiVersion: string;
  pack: { name: string; version: string };
  target: string;
  actions: PlanAction[];
  verify: { type: string }[];
  planHash: string;
}

export interface PackSummary {
  dir: string;
  name: string;
  version: string;
  title: string;
  targets: string[];
  resourceCount: number;
  errors: number;
  planHash: string | null;
  installedHash: string | null;
}

export interface InstallOutcome {
  actionId: string;
  op: string;
  status: 'done' | 'noop' | 'failed' | 'skipped' | 'needs-approval';
  message?: string;
  target?: string;
}

export interface CheckResult {
  index: number;
  type: string;
  status: 'pass' | 'fail' | 'skipped';
  detail: string;
}

export interface PackDetail {
  dir: string;
  manifest: {
    metadata: { name: string; version: string; title?: string; description?: string; targets: string[] };
    resources: ResourceSpec[];
    vars?: Record<string, string | number | boolean>;
    composition?: { env?: Record<string, unknown>; order?: string[] };
  } | null;
  issues: Issue[];
  plan: Plan | null;
  state: Record<
    string,
    { planHash: string; installedAt: string; written?: string[]; actions?: InstallOutcome[] }
  >;
}

export interface HarnessStatus {
  target: 'dsh' | 'codex' | 'claude-code';
  root: string;
  ok: boolean;
  packs: string[];
  error: string | null;
}

export interface SyncTargetResult {
  target: string;
  root: string;
  planHash?: string;
  outcomes?: InstallOutcome[];
  mcp?: { id: string; status: 'added' | 'kept' | 'planned' | 'removed' }[];
}

export interface SyncResult {
  pack: string;
  results: SyncTargetResult[];
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
  return (await res.json()) as T;
}

export const api = {
  packs: (): Promise<{ root: string; packs: PackSummary[] }> =>
    fetch('/api/packs').then((r) => json<{ root: string; packs: PackSummary[] }>(r)),

  pack: (dir: string): Promise<PackDetail> =>
    fetch(`/api/pack?dir=${encodeURIComponent(dir)}`).then((r) => json<PackDetail>(r)),

  install: (dir: string): Promise<{ outcomes: InstallOutcome[]; planHash: string }> =>
    fetch(`/api/install?dir=${encodeURIComponent(dir)}`, { method: 'POST', body: '{}' }).then((r) =>
      json<{ outcomes: InstallOutcome[]; planHash: string }>(r),
    ),

  verify: (dir: string): Promise<{ results: CheckResult[]; planHash: string }> =>
    fetch(`/api/verify?dir=${encodeURIComponent(dir)}`, { method: 'POST', body: '{}' }).then((r) =>
      json<{ results: CheckResult[]; planHash: string }>(r),
    ),

  harness: (): Promise<{ targets: HarnessStatus[] }> =>
    fetch('/api/harness').then((r) => json<{ targets: HarnessStatus[] }>(r)),

  sync: (dir: string, to: string[], dryRun = false): Promise<SyncResult> =>
    fetch(`/api/sync?dir=${encodeURIComponent(dir)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ to, dryRun }),
    }).then((r) => json<SyncResult>(r)),

  syncRemove: (dir: string, to: string[]): Promise<{ results: { target: string; removed: string[] }[] }> =>
    fetch(`/api/sync/remove?dir=${encodeURIComponent(dir)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ to }),
    }).then((r) => json<{ results: { target: string; removed: string[] }[] }>(r)),
};
