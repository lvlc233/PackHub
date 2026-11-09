# PAL 审计待办（37 条）

> 日期：2026-11-09 ／ 基线：`26d46a5`，`pnpm check` 全绿 ／ 口径：2026-11-09 的 PAL 全量审计 50 条，已关闭 43 条（A 11、B 15、C 11、D 6），本文只记**原始剩余 7 条**与新增未完成的 E 3 条，共 **10 条**。
> 需要拍板的四组语义（A3/B12/E3/E5）与结构项顺序见 [PAL-剩余决策](PAL-剩余决策.md)。
> 用途：跨会话派工，不依赖聊天记录。编号沿用审计原号，新增组往后排，**不重排、不复用**。
> 相关：功能现状见 [PackHub-功能全量清单](PackHub-功能全量清单.md) 的 PAL 域，机制细节见 [details/pal.md](details/pal.md)。本表只记待办，做完就改状态；现状描述不在这里续写。

## 状态标记

| 标记 | 含义 |
|---|---|
| `[open]` | 未开工 |
| `[proposal]` | 提案已出，待审 |
| `[decision]` | 等决策，动手前先问 |
| `[done]` | 已合入，行内记 commit |

## 先定这两个决策

| 决策 | 阻塞 | 现状与选项 |
|---|---|---|
| B12 pid 语义 | B12、A10、D7 | 提案是记 `spawnPid`、杀前校验 pid 仍属于该实例，不再靠端口反查。2026-11-09 讨论时你说「等一下」，未定 |

A3 凭据已定为 **copy**（`0d4f6d6`）：`credentials=shared` 明确拒绝，归档/备份剥离 `secrets.json`。

## A 组：缺的能力（13 条）

| 编号 | 事项 | 位置 / 证据 | 状态 | 前置 |
|---|---|---|---|---|
| A1 | 隔离策略模型（层、模式、字段） | `isolation.ts`：五层 + instance/shared + `DEFAULT_ISOLATION` + `parseIsolation`；新建/接管写默认值，旧记录与坏策略回落默认，clone 沿用源策略 | `[done]` 59ed357 | A2/A3 用这套词汇 |
| A2 | 默认策略与每实例覆盖 | `~/.packhub/config.json` 存新实例默认（`pal config` 可看/改）；`pal create --isolation` 显式覆盖；坏配置报错不回落，已有实例不追溯 | `[done]` 15d4086 | A3/A7/A13 用这套语义 |
| A3 | 凭据没有 copy/shared-ro 策略，禁 link，归档剥离 | 定为 copy：`seedHome` 复制；`credentials=shared` 在建实例前 `invalid-input` 拒绝；`keepData` 归档先删 `secrets.json`；备份默认剥离 | `[done]` 0d4f6d6 | A1；copy 已定 |
| A4 | 取包缓存管理面（`pal cache ls/clean`、meta、GC） | `cache.ts` + `pal cache`：ls/clean（`--all`/`--ref`/`--older-than`）、缓存 meta、命中补写 | `[done]` 65e2183 | A1 的缓存层 |
| A5 | 实例根可选 | `create` / `clone` / `import` 的 CLI `--root`、API `body.root` 已支持；只收绝对路径，拒绝盘符根/文件系统根与 PAL 实例根内（`assertExternalRoot`） | `[done]` 8a722fa | 无 |
| A6 | 界面缺实例流转 | 新建对话框「来源」：pack / 接管目录 / 导入模板；详情「更多」：克隆、改名、迁移、导出（APIs 见 A6a，web 见 `app.js`） | `[done]` f8cb9b8 | 提案已有 6 个 API 形状 |
| A7 | 策略变更没有迁移工具 | `migrate.ts` 只挪根，不按新策略重排 home | `[open]` | A1、A3 |
| A8 | 没有整实例快照 / 备份 / 恢复 | `pal backup <id> [--include-secrets]` 目录快照到 `PACKHUB_HOME/backups`；`pal restore <dir> [--name] [--root]` 重写 id/root/home 后恢复 | `[done]` 71e0b94 | 无 |
| A9 | 没有发现 / 导入已有实例 | `pal scan <dir> [--depth] [--json]` 只读识别三类：instance.json / packhub.yaml / .packhub/state.json；`scan.ts` + test | `[done]` dae2efc | 无 |
| A10 | 系统级看护缺失 | `pal watch [--interval]`：headless 轮询 scanInstances，对 running 但 pid 已死的记录按 on-failure 预算重起，否则写 broken；与 `pal serve` 二选一 | `[done]` 6fea5d6 | 无 |
| A11 | 没有运行时版本管理 | PAL-23 是 `[part]`；分发自带 node.exe，不能切换 | `[open]` | 无 |
| A12 | 没有并发多实例管理面 | `pal ps [--json]`：running/pid 实例、端口冲突、stale、坏记录与总计；纯读不写盘（`ps.ts`） | `[done]` 1ea038c | 无 |
| A13 | 决策没写回文档 | `pal.md` 已写清隔离五层/默认/覆盖/快照与凭据 copy/shared-ro 拒绝、归档/备份剥离；`concepts.md` 未动（你的未提交文件） | `[done]` 0d4f6d6 | A3 |

## B 组：坏影响（2 条）

| 编号 | 事项 | 位置 / 证据 | 状态 | 前置 |
|---|---|---|---|---|
| B12 | 端口反查 pid 可能记错 / 误杀 | `start.ts` 靠端口反查监听者记 pid，杀前不校验归属 | `[decision]` | 见上表，等你定 pid 语义 |
| B14 | 本地 API 只挡浏览器 | 服务每次启动生成 token：带 Origin 的请求必须带 `x-pal-token`（页面从首页 meta 读），无 Origin 的本机调用不校验；首页 `no-store`，重启换 token | `[done]` 32fb368 | E3 若去掉 HTTP 面，token 一起删 |

## C 组：脏乱差（5 条）

| 编号 | 事项 | 位置 / 证据 | 状态 | 前置 |
|---|---|---|---|---|
| C4 | 三份事实 | `planHash` 只在 baseline；pack 身份由 `packIdentityFromState` 从 state 派生（0/≥2 个包才 external），record 只存派生快照；update 写完回读 state | `[done]` 26d46a5 | 无 |
| C7 | 静默失败 | `seedHome` 单文件失败经 `onWarn` 报告（CLI stderr）；`update` 删旧文件失败进 `warnings`；日志读取仍 best-effort | `[done]` acaab37 | 无 |
| C8 | 状态机缺 `unknown`/`stale` | 只读视图 `statusView` 对 running 但 pid 已死/缺席的记录给 `status:broken` + `stale:true`（不落盘）；不新增 `unknown` 状态，记录 schema 不变 | `[done]` a2e1a9e | 无 |
| C9 | 没有 service 层 | HTTP handler 直接调 materialize/create/update，CLI 又重复一遍 | `[open]` | 无 |
| C10 | 测试缺口 | 已覆盖：隔离策略（config/isolation 测试）、并发看护/停止（start/watch）、迁移回滚失败（instance）、Electron 转发器路径/头/token（apps/pal-electron/test/forward.test.ts） | `[done]` cb160a3 | 随对应条目补 |

## D 组：坏味道（7 条）

| 编号 | 事项 | 位置 / 证据 | 状态 | 前置 |
|---|---|---|---|---|
| D1 | 记录同时是配置与运行态 | `InstanceRecord` 把 status/pid/url/lastExit 与 pack/planHash 混装 | `[open]` | 与 A1 绑定 |
| D2 | 外壳边界糊 | `pal.md` 明确三层：PackHub CLI / PAL launcher（装配外壳，可调 runtime.installPack）/ 桌面壳（只起 serve、不碰实例文件）；不设限定的「外壳」指桌面壳 | `[done]` 本次文档 | 无 |
| D3 | `ADAPTERS` 缺能力字段 | 只有 label/homeDir/homeEnv/executable/versionArgs，没有隔离旋钮、凭据位置、可共享层（`layout.ts`） | `[open]` | 与 A1 绑定 |
| D4 | 实例 id 是「时间戳 + 随机后缀」 | `newId`（`paths.ts`）改为 14 位时间戳 + 12 位 crypto 十六进制；旧 id 不迁移，两种并存可读 | `[done]` 8a02c18 | 无 |
| D5 | 错误文案回显绝对路径 | 错误消息改为 `details`/`hint`，message 不再拼 root/home（`create/migrate/remove/update` 等） | `[done]` 65e2183 | 无 |
| D7 | 桌面壳 `taskkill /F` 硬杀 | 新壳：`pal serve --exit-on-stdin-close`，Electron 先 `stdin.end()` 等 1.5s，再 `taskkill /T /F` 兜底；旧 `apps/pal-desktop` 仍硬杀，随 E4 退役 | `[part]` 087c940 | E3/A10 |
| D9 | 取包缓存 slug 只截末 40 字符 | `slug()` 现在拼完整引用的 sha256 前 10 hex；旧缓存目录被弃用，等 A4 清理 | `[done]` 9793c18 | A4 |

## E 组：Electron 工作流（5 条）

| 编号 | 事项 | 位置 / 证据 | 状态 | 前置 |
|---|---|---|---|---|
| E1 | 最小 Electron 壳 | `apps/pal-electron`：spawn `pal serve --json`、读地址、窗口加载；侧车异常有可见错误。pnpm 跳过 electron postinstall，二进制要手动补一次（README 已写） | `[done]` e48ea2d | 无 |
| E2 | 前端 API 层抽离 + IPC 桥 | `web/api.js` 是唯一 API 入口：浏览器 fetch、Electron 走 `pal.request`；`forward.mjs` 校验 `/api/` 路径并补 `x-pal-client`/`origin`；页面代码不动即可换传输 | `[done]` 2f4bd2e | E3 只改 transport 与 forward |
| E3 | 侧车传输收敛 | `pal serve` 保留 HTTP（仅 dev）还是改 stdio / 内部 RPC；决定 B14 是「加 token」还是「去掉 HTTP 面」 | `[decision]` | E1、E2 |
| E4 | 退役 WinForms/WebView2 壳 | 删 `apps/pal-desktop/*.cs`；同步 `README.md`、`.github/workflows/pal.yml`、`build:pal-desktop` 与分发脚本 | `[open]` | E1 可用后 |
| E5 | 打包范围 | Windows-only 还是保留 macOS/Linux；跨平台要先审 `pal serve` 与路径逻辑的 Windows 假设（见 [details/windows.md](details/windows.md)） | `[decision]` | E1 |

## N 组：本轮实现暴露的（5 条）

| 编号 | 事项 | 位置 / 证据 | 状态 | 前置 |
|---|---|---|---|---|
| N1 | 界面强制更新入口 | 详情页「覆盖本地改动」勾选，勾了才给 `body.force`；失败文案按界面改写 | `[done]` 65e2183 | 无 |
| N2 | `remove` 不再 `removePack` 的副作用边界 | `remove.ts` 注释与 pal.md 写清：默认删根不逐文件卸包，当前无根外副作用；以后写宿主级 MCP/配置须补反向清理 | `[done]` 71e0b94 | 无 |
| N3 | `uninstalled` 报告语义 | `RemoveResult.uninstalled` 注释写清「删前读到的 Pack key，非逐个卸载凭据」；CLI 分「随根删除 / 随根归档 / 已卸包」三种说法 | `[done]` b8afeed | 无 |
| N4 | 校验函数位置 | `assertNameFree` / `assertHarness` 已收进 `validators.ts`，create / migrate 直接 import；顺带去掉了 create 里不可达的宿主检查 | `[done]` 297c4a9 | 无 |
| N5 | 过时注释 / 文案 | `catalog.ts` 头注释、冒烟删除文案已校准（默认删除不卸包、归档时 removed=false） | `[done]` db5325a | 无 |

## 计数

| 组 | 编号 | 条数 |
|---|---|---|
| A | A7、A11 | 2 |
| B | B12 | 1 |
| C | C9 | 1 |
| D | D1、D3、D7 | 3 |
| 小计 | 原始剩余 | **7** |
| E | E3–E5 | 3 |
| N | — | 0 |
| 合计 |  | **10** |

## 建议开工顺序

1. **A1 + A2**：策略模型与默认 / 覆盖，其它 A 项都依赖它。
2. **A3**：凭据 copy / shared-ro、禁 link、归档剥离（等你定策略）。
3. **B14**：按现状加 token，或随 E3 去掉 HTTP 面（你已把 Electron 定为默认方向）。
4. **C4 + D1 + D3**：三份事实、记录分层、适配表能力字段 —— 与 A1 一起做最省。
5. **A4 + D9**：缓存管理面与 slug 碰撞。
6. **A5 + A6**：root 可选与界面流转，随 Electron 迁移一起做。
7. **A7 / A8 / A9 / A10 / A11 / A12**：迁移工具、备份、扫描、看护、运行时、并发账本。
8. **C7 / C8 / C9 / C10、B12、D2 / D4 / D5 / D7**：清理与补测；B12 仍等 pid 语义。

Electron 这条线独立于 A–D：先 **E1**（壳能起来），再 **E2**（IPC），**E3 / E5** 定传输与打包范围，最后 **E4** 退役旧壳；N1 可与 E2 一起做。

新会话开场可直接写：

> 继续 PackHub PAL 审计剩余 10 条（原 7 + E3–E5），仓库在 `26d46a5`。A1/A2/A3/A4/A5/A6/A8/A9/A10/A12/A13/B14/C1–C8/C10–C12/E1/E2/N2 已完成；下一步 D1 或 C9；B12 仍待定。

## 完成判据

- 代码合入，且有至少一条测试或实测证据；`pnpm check` 全绿。
- 涉及界面或分发的条目，另跑对应的 `pal:bundle` / `pal:smoke`。
- 做完一条改状态并写 commit；现状描述同步到 [PackHub-功能全量清单](PackHub-功能全量清单.md) 与 [details/pal.md](details/pal.md)。
