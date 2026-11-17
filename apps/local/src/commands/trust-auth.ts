// 由 cli.ts 拆分：trustAdd / trustRemove / trustList / trustRequire / trust / authSet / authList / authRemove / authRotate / auth / keygen / sign / verifySig
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { EXIT, command, json, problemRaw, say, stop, warn } from '../emit.ts';
import { credentialsPath, listTokens, removeToken, setToken } from '@packhub/runtime';
import { loadPack, checkLockConsistency } from '@packhub/kernel';
import {
  readSignatures,
  writeSignature,
  generateKeyPair,
  signContentHash,
  verifySignatures,
  loadLock,
  withLockPins,
  contentHashFor,
  trustPath,
  readTrust,
  addTrustedKey,
  removeTrustedKey,
  setRequireSignature,
} from '@packhub/runtime';
import { reportIssues } from './shared.ts';

export const trustAdd = command({
  meta: { name: 'add', description: '把发布者的公钥 id 加入本机信任列表' },
  args: {
    key: { type: 'positional', required: true, description: '公钥 id（packhub sign 输出里的 key）' },
    label: { type: 'string', description: '给人看的备注，例如发布者名字' },
  },
  run({ args }) {
    const entry = addTrustedKey(String(args.key), args.label ? String(args.label) : undefined);
    say(`✓ 已信任 ${entry.key.slice(0, 16)}…${entry.label ? `（${entry.label}）` : ''}`);
    say(`  ${trustPath()}`);
    say('  之后安装默认要求来自这个列表的有效签名；要装无签名包用 --allow-unsigned');
  },
});

export const trustRemove = command({
  meta: { name: 'remove', description: '从信任列表移除一个公钥' },
  args: { key: { type: 'positional', required: true } },
  run({ args }) {
    const ok = removeTrustedKey(String(args.key));
    say(ok ? `✓ 已移除 ${String(args.key).slice(0, 16)}…` : '信任列表里没有这个公钥');
    if (!ok) stop(EXIT.RUNTIME);
  },
});

export const trustList = command({
  meta: { name: 'list', description: '列出本机信任的公钥' },
  run() {
    const trust = readTrust();
    if (trust.keys.length === 0) {
      say(`信任列表是空的：${trustPath()}`);
      say('用 packhub trust add <公钥 id> 添加发布者');
      return;
    }
    for (const key of trust.keys) {
      say(`${key.key}${key.label ? `  ${key.label}` : ''}  ${key.addedAt.slice(0, 19)}`);
    }
    say(
      `\n共 ${trust.keys.length} 个；要求签名：${trust.requireSignature === true || trust.keys.length > 0 ? '是' : '否'}`,
    );
  },
});

export const trustRequire = command({
  meta: { name: 'require', description: '要不要强制签名（on | off）；公钥列表不动' },
  args: {
    value: { type: 'positional', required: true, description: 'on | off' },
  },
  run({ args }) {
    const raw = String(args.value).toLowerCase();
    if (raw !== 'on' && raw !== 'off') {
      problemRaw(`只认 on 或 off：收到 ${String(args.value)}`);
      stop(EXIT.USAGE);
    }
    const on = raw === 'on';
    const data = setRequireSignature(on);
    say(on ? '✓ 之后安装要求签名（单次可被 --allow-unsigned 绕过）' : '✓ 不再要求签名');
    say(`  ${trustPath()}`);
    if (!on && data.keys.length > 0) {
      warn(`信任列表里还有 ${data.keys.length} 把公钥：列表非空时仍然只收列表里的签名`);
    }
  },
});

export const trust = command({
  meta: { name: 'trust', description: '管理持久信任的签名公钥' },
  subCommands: { add: trustAdd, remove: trustRemove, list: trustList, require: trustRequire },
});

export const authSet = command({
  meta: { name: 'set', description: '把一把 token 存进凭据库（0600，不进清单、不进 registry）' },
  args: {
    name: { type: 'positional', required: true, description: '变量名，例如 GITHUB_TOKEN' },
    value: { type: 'positional', required: true, description: 'token 值' },
  },
  run({ args }) {
    setToken(String(args.name), String(args.value));
    say(`✓ 已存入 ${credentialsPath()}（${String(args.name)}）`);
    say('  下载时环境变量优先，其次才是这里。');
  },
});


export const authList = command({
  meta: { name: 'list', description: '列出已存的 token（只显示掩码）' },
  run() {
    const tokens = listTokens();
    if (tokens.length === 0) {
      say(`凭据库是空的：${credentialsPath()}`);
      say('用 packhub auth set <变量名> <token> 添加');
      return;
    }
    for (const t of tokens) {
      say(`${t.name.padEnd(24)} ${t.masked}${t.fromEnv ? '  ← 环境变量也在起作用（优先）' : ''}`);
    }
  },
});

export const authRemove = command({
  meta: { name: 'remove', description: '删掉一把 token' },
  args: { name: { type: 'positional', required: true } },
  run({ args }) {
    const ok = removeToken(String(args.name));
    say(ok ? `✓ 已删除 ${String(args.name)}` : `没有这个 token：${String(args.name)}`);
    if (!ok) stop(EXIT.RUNTIME);
  },
});

export const authRotate = command({
  meta: { name: 'rotate', description: '换掉一把 token 的值（等价于 set，但会提示旧值已替换）' },
  args: {
    name: { type: 'positional', required: true },
    value: { type: 'positional', required: true },
  },
  run({ args }) {
    const before = listTokens().find((t) => t.name === String(args.name));
    setToken(String(args.name), String(args.value));
    say(`✓ 已轮换 ${String(args.name)}${before ? `（旧值 ${before.masked}）` : ''}`);
  },
});

export const auth = command({
  meta: { name: 'auth', description: '管理私有来源的 token' },
  subCommands: { set: authSet, list: authList, remove: authRemove, rotate: authRotate },
});

export const keygen = command({
  meta: { name: 'keygen', description: '生成一对 ed25519 签名密钥' },
  args: {
    out: { type: 'string', default: 'packhub.key', description: '私钥输出路径' },
  },
  run({ args }) {
    const { privatePem, publicKey } = generateKeyPair();
    const out = resolve(String(args.out));
    writeFileSync(out, privatePem, { encoding: 'utf8', mode: 0o600 });
    say(`✓ 私钥：${out}（别提交进版本库）`);
    say(`  公钥 id：${publicKey}`);
    say('  把公钥 id 发给要信任你的人；签名用 packhub sign');
  },
});

export const sign = command({
  meta: { name: 'sign', description: '用私钥签这个包的内容哈希（先有锁）' },
  args: {
    dir: { type: 'positional', required: false, default: '.' },
    key: { type: 'string', required: true, description: '私钥 PEM 路径' },
  },
  run({ args }) {
    const dir = resolve(String(args.dir));
    const loaded = loadPack(dir);
    if (!loaded.manifest) {
      reportIssues(loaded.issues);
      stop(EXIT.USAGE);
    }
    // 和 install / verify 看同一份：有锁就按锁钉死的引用算内容哈希，否则签的哈希和装的对不上
    const lockRead = loadLock(dir);
    if (lockRead.problem) {
      reportIssues([lockRead.problem]);
      stop(EXIT.USAGE);
    }
    const ctx = withLockPins(loaded, lockRead.lock);
    if (reportIssues(ctx.issues)) stop(EXIT.USAGE);
    // 签名载荷是 {pack, contentHash}：必须先有锁才签得了——没有锁或锁过期时，
    // 这里算出的内容哈希和安装时用到的不是同一份，签了也验不过。
    const lockCheck = checkLockConsistency(lockRead.lock, ctx.manifest);
    if (lockCheck.status === 'missing') {
      problemRaw('这个包没有锁：先跑 packhub lock 再签，否则签的内容和安装时用的对不上');
      stop(EXIT.USAGE);
    }
    if (lockCheck.status === 'mismatch') {
      problemRaw('锁与当前清单对不上：先跑 packhub lock 再签，否则签的是一个装不上去的内容哈希');
      stop(EXIT.USAGE);
    }
    const contentHash = lockCheck.actual!;
    const pack = `${ctx.manifest.metadata.name}@${ctx.manifest.metadata.version}`;
    const pem = readFileSync(String(args.key), 'utf8');
    const signature = signContentHash(pem, pack, contentHash);
    writeSignature(dir, signature);
    say(`✓ 已签名 ${pack}`);
    say(`  公钥 id：${signature.key}`);
    say(`  contentHash：${contentHash.slice(0, 22)}…`);
  },
});

export const verifySig = command({
  meta: { name: 'verify-sig', description: '校验包上的签名' },
  args: {
    dir: { type: 'positional', required: false, default: '.' },
    trusted: { type: 'string', description: '信任的公钥 id 列表文件（每行一个）' },
    json: { type: 'boolean', default: false },
  },
  run({ args }) {
    const dir = resolve(String(args.dir));
    {
      const loaded = loadPack(dir);
      if (!loaded.manifest) {
        reportIssues(loaded.issues);
        stop(EXIT.USAGE);
      }
      const lockRead = loadLock(dir);
      if (lockRead.problem) {
        reportIssues([lockRead.problem]);
        stop(EXIT.USAGE);
      }
      const ctx = withLockPins(loaded, lockRead.lock);
      if (reportIssues(ctx.issues)) stop(EXIT.USAGE);
      // 签名覆盖的是内容哈希：有锁按锁的 resolved 归一清单算，没锁按清单自身引用算
      const contentHash = contentHashFor(ctx.manifest, lockRead.lock);
      const sigs = [...readSignatures(dir), ...(ctx.manifest.signatures ?? [])];
      if (sigs.length === 0) {
        if (args.json) json({ ok: false, error: '这个包没有签名', signatures: [] });
        else problemRaw('这个包没有签名');
        stop(EXIT.RUNTIME);
      }
      const pack = `${ctx.manifest.metadata.name}@${ctx.manifest.metadata.version}`;
      const results = verifySignatures(sigs, pack, contentHash);

      const trustedFile = args.trusted ? String(args.trusted) : undefined;
      const trusted = trustedFile
        ? readFileSync(trustedFile, 'utf8').split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
        : undefined;

      const rows = results.map((r) => {
        const isTrusted = !trusted || trusted.includes(r.key);
        return { ...r, trusted: isTrusted, accepted: r.ok && isTrusted };
      });
      const good = rows.filter((r) => r.accepted).length;
      if (args.json) {
        json({ ok: good > 0, contentHash, signatures: rows });
      } else {
        for (const r of rows) {
          say(
            `${r.accepted ? '✓' : 'x'} ${r.key.slice(0, 16)}… ${r.ok ? '签名有效' : '签名不符'}${
              trusted && !r.trusted ? '（不在信任列表）' : ''
            }`,
          );
        }
        say(`\n${good}/${results.length} 个签名通过`);
      }
      if (good === 0) stop(EXIT.RUNTIME);
    }
  },
});
