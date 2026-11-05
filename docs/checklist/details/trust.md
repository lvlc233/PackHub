# TRU ｜安全与信任：逐项验收

## 怎么验

| 编号 | 验收动作 | 现状/证据 | 缺口/下一步 |
|---|---|---|---|
| TRU-01 | `keygen` → `sign` → `verify-sig` | ed25519 签 `{pack@version,planHash}`，可验 | 无密钥托管/轮换 |
| TRU-02 | 看私钥文件权限 | keygen 以 0600 写（POSIX） | Windows 权限语义弱 |
| TRU-03 | `sign` 后看清单 | 签名写 `packhub.signatures.json`，不改 manifest | 版本目录不可变因此受益 |
| TRU-04 | `add` 一个无签名包 | 默认只提示；`--require-signature` 才拒绝 | 建议默认 `require` 或配置化 |
| TRU-05 | `--trusted keys.txt` | 只认列表里的公钥；无持久配置 | 需要 `~/.packhub/trust.json` |
| TRU-06 | `auth set` 后 `auth list` | 掩码；env 优先；0600 | 无轮换/过期 |
| TRU-07 | 401 下载失败 | 报错指名变量；URL 去查询串 | 第三方日志可能泄漏 |
| TRU-08 | `licenses` 扫本地资源 | 找 LICENSE/COPYING，猜 SPDX | 远程资源看不到；不做兼容判断 |
| TRU-09 | vendored GPL 内容 | 无阻断，只提示 | 需要许可策略/CI gate |
| TRU-10 | `visibility: private` 发布 | registry 门禁拒绝 | unlisted/internal 分发靠 URL/内网 |
| TRU-11 | 安装操作审计 | 没有安装审计；只有 Hub 请求审计 | 需要本地审计日志 |

## 结论

签名、凭据、可见性的基础都有，但“默认安全”还不够：签名不强制、许可不阻断、安装无审计。当前定位是开发者工具，不是托管平台；这些缺口在团队/市场场景会变成硬伤。
