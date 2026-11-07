#!/usr/bin/env node
/**
 * PAL 端到端冒烟：起本地服务 → 建实例 → 体检 → 停/删 → 关服务。
 * 跑的是真实 HTTP 接口与真实安装流程（不含浏览器），CI 里用它替代手跑。
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = process.cwd();
const home = mkdtempSync(join(tmpdir(), 'pal-smoke-'));
const env = {
  ...process.env,
  PACKHUB_HOME: home,
  PACKHUB_INSTANCES: join(home, 'instances'),
};

const HEADERS = { 'content-type': 'application/json', 'x-pal-client': 'pal-ui' };

function fail(message) {
  console.error(`x ${message}`);
  process.exitCode = 1;
}

async function main() {
  const cli = join(root, 'packages', 'launcher', 'src', 'bin.ts');
  const child = spawn(process.execPath, ['--experimental-strip-types', cli, 'serve', '--port', '0', '--json'], {
    cwd: root,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const url = await new Promise((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(() => reject(new Error('pal serve 20s 内没有给出地址')), 20_000);
    child.stdout.on('data', (chunk) => {
      buffer += String(chunk);
      const line = buffer.split(/\r?\n/).find((item) => item.trim().startsWith('{'));
      if (!line) return;
      clearTimeout(timer);
      try {
        resolve(JSON.parse(line).url);
      } catch (err) {
        reject(err);
      }
    });
    child.once('exit', (code) => reject(new Error(`pal serve 退出了：${code}`)));
  });

  const call = async (path, init = {}) => {
    const res = await fetch(new URL(path, url), { ...init, headers: HEADERS });
    const text = await res.text();
    const body = text ? JSON.parse(text) : {};
    if (!res.ok) throw new Error(`${init.method ?? 'GET'} ${path} → ${res.status} ${JSON.stringify(body)}`);
    return body;
  };

  const meta = await call('/api/meta');
  console.log(`· 服务 ${url}（${meta.name}）`);

  const harnesses = await call('/api/harnesses?probe=0');
  console.log(`· 宿主：${harnesses.map((h) => h.id + (h.startable ? '' : '(不可启动)')).join(' ')}`);

  const created = await call('/api/instances', {
    method: 'POST',
    body: JSON.stringify({ pack: 'examples/doc-review', name: 'smoke', harness: 'dir' }),
  });
  console.log(`· 实例 ${created.id} ${created.status}`);

  const notice = await call('/api/instances');
  if (!notice.instances.some((item) => item.id === created.id)) throw new Error('列表里没有刚建的实例');

  const health = await call(`/api/instances/${created.id}/health`);
  const failedCheck = health.checks.find((check) => check.status === 'fail');
  if (failedCheck) throw new Error(`体检不通过：${failedCheck.name} ${failedCheck.detail}`);
  console.log(`· 体检：${health.checks.map((check) => `${check.name}=${check.status}`).join(' ')}`);

  const removed = await call(`/api/instances/${created.id}`, { method: 'DELETE' });
  if (!removed.removed) throw new Error('删除没有真的删掉实例根');
  console.log('· 删除：已卸包并删根');

  child.kill();
}

main()
  .catch((err) => fail(err.message))
  .finally(() => {
    try {
      rmSync(home, { recursive: true, force: true });
    } catch {
      /* 清理失败不影响结论 */
    }
  })
  // fetch 的 keep-alive 连接会拖住事件循环，冒烟跑完直接收工
  .then(() => process.exit(process.exitCode ?? 0));
