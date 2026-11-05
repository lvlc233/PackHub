import { spawnSync } from 'node:child_process';

/** 宿主 MCP 的启动规格：与计划里的 register.mcp spec 同形。 */
export interface HostMcpSpec {
  transport?: string;
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, string>;
}

export interface HostMcpResult {
  id: string;
  status: 'added' | 'kept' | 'planned' | 'removed';
  message?: string;
}

function claudeBin(): string {
  return process.env.PACKHUB_CLAUDE_BIN || 'claude';
}

/** 调宿主自己的 CLI；Claude Code 的 user scope 是稳定接口，不猜它的配置文件格式。 */
function runClaude(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const res = spawnSync(claudeBin(), args, {
    encoding: 'utf8',
    timeout: 60_000,
    windowsHide: true,
    // Windows 上 claude 是 claude.cmd / claude.ps1 垫片，只能过 shell
    shell: process.platform === 'win32',
  });
  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

function tail(text: string): string {
  return text.trim().split(/\r?\n/).filter(Boolean).slice(-1)[0] ?? '';
}

export function claudeAvailable(): boolean {
  return runClaude(['--version']).status === 0;
}

export function claudeHasMcp(name: string): boolean {
  return runClaude(['mcp', 'get', name]).status === 0;
}

/** 用 claude 自己的 CLI 注册 user scope MCP；stdout/stderr 只取最后一行做错误信息。 */
export function addClaudeMcp(name: string, spec: HostMcpSpec): void {
  const args = ['mcp', 'add', '--scope', 'user'];
  for (const [key, value] of Object.entries(spec.env ?? {})) args.push('-e', `${key}=${value}`);
  if (typeof spec.url === 'string' && spec.url) {
    args.push('--transport', 'http', name, spec.url);
  } else if (typeof spec.command === 'string' && spec.command) {
    args.push(name, '--', spec.command, ...(spec.args ?? []).map(String));
  } else {
    throw new Error(`MCP ${name} 没有 command 或 url，没法交给 claude 注册`);
  }
  const res = runClaude(args);
  if (res.status !== 0) {
    throw new Error(`claude mcp add ${name} 失败：${tail(res.stderr || res.stdout) || `退出码 ${String(res.status)}`}`);
  }
}

/** 删掉 user scope MCP；本来就不存在时返回 false，不报错。 */
export function removeClaudeMcp(name: string): boolean {
  if (!claudeHasMcp(name)) return false;
  const res = runClaude(['mcp', 'remove', '--scope', 'user', name]);
  if (res.status !== 0) {
    throw new Error(`claude mcp remove ${name} 失败：${tail(res.stderr || res.stdout) || `退出码 ${String(res.status)}`}`);
  }
  return true;
}
