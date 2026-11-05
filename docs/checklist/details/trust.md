# TRU ｜安全与信任：逐项验收

## 怎么验

| 编号 | 验收动作 | 现状/证据 | 缺口/下一步 |
|---|---|---|---|
| TRU-01 | `keygen` → `sign` → `verify-sig` | ed25519 签 `{pack@version,planHash}`，可验 | 无密钥托管/轮换 |
| TRU-02 | 看私钥文件权限 | keygen 以 0600 写（POSIX） | Windows 权限语义弱 |
| TRU-03 | `sign` 后看清单 | 签名写 `packhub.signatures.json`，不改 manifest | 版本目录不可变因此受益 |
| TRU-04 | `add` 一个无签名包 | 有信任列表就强制；`--allow-unsigned` 显式降级；trust.json 可设 requireSignature | 无签名仍是默认放行 |
| TRU-05 | `packhub trust add/remove/list` | 持久列表，安装默认使用 | 无组织级分发 |
| TRU-06 | `auth set` 后 `auth list` | 掩码；env 优先；0600 | 无轮换/过期 |
| TRU-07 | 401 下载失败 | 报错指名变量；URL 去查询串 | 第三方日志可能泄漏 |
| TRU-08 | `licenses` 扫本地资源 | 本地猜 SPDX；`--online` 读 npm registry license | github/https 仍看不到 |
| TRU-09 | vendored GPL 内容 | 策略 JSON：allow/deny/copyleft/NC/ND/requireSpdx | 不做法律解释 |
| TRU-10 | `visibility: private` 发布 | registry 门禁拒绝 | unlisted/internal 分发靠 URL/内网 |
| TRU-11 | 安装操作审计 | add/install/update 写 `~/.packhub/audit.jsonl`，`packhub audit` 查看 | 没有轮转与签名 |

## 结论

签名、凭据、可见性的基础都有，但“默认安全”还不够：签名不强制、许可不阻断、安装无审计。当前定位是开发者工具，不是托管平台；这些缺口在团队/市场场景会变成硬伤。
