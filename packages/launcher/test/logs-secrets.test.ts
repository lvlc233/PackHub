import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendEvent, listLogs, logsDir, readEvents, readLog, rotateLogs, tailLog } from '../src/logs.ts';
import { clearSecrets, readSecrets, redactText, splitUrl, withSecrets, writeSecrets } from '../src/secrets.ts';

function temp(): string {
  return mkdtempSync(join(tmpdir(), 'packhub-logs-'));
}

describe('启动输出里的凭据', () => {
  it('splitUrl 把 token 从地址里摘出来，withSecrets 拼得回去', () => {
    const { url, secrets } = splitUrl('http://127.0.0.1:7777/?token=abc&tab=logs');
    expect(url).not.toContain('abc');
    expect(url).toContain('tab=logs');
    expect(secrets).toEqual({ token: 'abc' });

    const back = new URL(withSecrets(url, secrets));
    expect(back.searchParams.get('token')).toBe('abc');
    expect(back.searchParams.get('tab')).toBe('logs');
  });

  it('日志文本里的查询参数、Bearer、密钥串都打码', () => {
    expect(redactText('listen http://x/?token=abc123&a=1')).toContain('token=***');
    expect(redactText('Authorization: Bearer abcdefghijklmn')).toContain('Bearer ***');
    expect(redactText('using ghp-abcdefghijklmnopqrst')).toContain('***');
  });

  it('writeSecrets / readSecrets / clearSecrets 读回同一份', () => {
    const root = temp();
    writeSecrets(root, { token: 'abc' });
    expect(readSecrets(root)).toEqual({ token: 'abc' });
    clearSecrets(root);
    expect(readSecrets(root)).toEqual({});
    rmSync(root, { recursive: true, force: true });
  });
});

describe('启动日志', () => {
  it('start.log 读出来已经脱敏，tailLog 只留尾部', () => {
    const root = temp();
    mkdirSync(logsDir(root), { recursive: true });
    writeFileSync(
      join(logsDir(root), 'start.log'),
      'listen http://127.0.0.1:7777/?token=secret-value\ndone\n',
      'utf8',
    );

    const { text } = readLog(root);
    expect(text).toContain('listen');
    expect(text).not.toContain('secret-value');
    expect(tailLog(root, 1)).toBe('done');

    rmSync(root, { recursive: true, force: true });
  });

  it('appendEvent 与 readEvents 往返', () => {
    const root = temp();
    appendEvent(root, { event: 'start', port: 7777 });

    const events = readEvents(root);
    expect(events[0]?.event).toBe('start');
    expect(events[0]?.port).toBe(7777);

    rmSync(root, { recursive: true, force: true });
  });

  it('rotateLogs 归档当前日志，只留 keep 份', () => {
    const root = temp();
    mkdirSync(logsDir(root), { recursive: true });
    for (let i = 0; i < 7; i += 1) {
      writeFileSync(join(logsDir(root), 'start.log'), `run ${i}\n`, 'utf8');
      expect(rotateLogs(root, 5)).toBeTruthy();
    }

    const archives = listLogs(root).filter((f) => f.name !== 'start.log');
    expect(archives.length).toBe(5);
    expect(existsSync(join(logsDir(root), 'start.log'))).toBe(false);

    rmSync(root, { recursive: true, force: true });
  });
});
