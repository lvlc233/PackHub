# PAL 审计待办（37 条）

> 日期：2026-11-09 ／ 基线：`5ca4cab`，`pnpm check` 全绿 ／ 口径：2026-11-09 的 PAL 全量审计 50 条，已关闭 23 条（B 组 14、C 组 7、D 组 2），本文只记**剩余 27 条**与审计后**新增 10 条**（E 组 Electron 迁移、N 组本轮实现暴露）。
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
| A3 凭据策略 | A3、A7、A13 | `copy`（每实例一份）或 `shared-ro`（只读共享宿主凭据），两者都禁 `link`，归档时剥离。参考：PCL 把账号存在启动器全局设置（`LoginMsJson`）里，由启动器单写入 —— 据 2026-11-09 对其源码的查证 |

## A 组：缺的能力（13 条）

| 编号 | 事项 | 位置 / 证据 | 状态 | 前置 |
|---|---|---|---|---|
| A1 | 隔离策略模型（层、模式、字段） | `isolation.ts`：五层 + instance/shared + `DEFAULT_ISOLATION` + `parseIsolation`；新建/接管写默认值，旧记录与坏策略回落默认，clone 沿用源策略 | `[done]` 59ed357 | A2/A3 用这套词汇 |
| A2 | 没有默认策略与每实例覆盖 | 默认值目前只有代码里的 `DEFAULT_ISOLATION`；`~/.packhub/config.json` 与每实例覆盖还没有 | `[open]` | A1 |
| A3 | 凭据没有 copy/shared-ro 策略，禁 link，归档剥离 | `seedHome`（`create.ts`）只在建实例时复制一次，之后宿主登录的凭据不回写 | `[decision]` | A1；等你选 copy / shared-ro |
| A4 | 取包缓存没有管理面（`pal cache ls/clean`、meta、GC） | `materialize.ts` 只有取与复用，没有列出、清理、配额 | `[open]` | A1 的缓存层 |
| A5 | 实例根不可选 | `create` / `clone` / `import` 的 CLI args 里都没有 `--root`，API 与界面也没有 | `[open]` | 无 |
| A6 | 界面缺实例流转 | `web/app.js` 有建 / 启停 / 重起 / 更新 / 设为当前 / 删；adopt / clone / rename / migrate / export / import 没有入口 | `[open]` | 提案已有 6 个 API 形状 |
| A7 | 策略变更没有迁移工具 | `migrate.ts` 只挪根，不按新策略重排 home | `[open]` | A1、A3 |
| A8 | 没有整实例快照 / 备份 / 恢复 | `export` 只导出 Pack 引用模板（`template.ts`），不含 home 与数据 | `[open]` | 无 |
| A9 | 没有发现 / 导入已有实例 | `adopt` 要手工给 dir + harness，不能扫描 | `[open]` | 无 |
| A10 | 系统级看护缺失 | supervisor 在 `pal serve` 进程内（`start.ts`）；壳退出后 `on-failure` 失效 | `[open]` | 无 |
| A11 | 没有运行时版本管理 | PAL-23 是 `[part]`；分发自带 node.exe，不能切换 | `[open]` | 无 |
| A12 | 没有并发多实例管理面 | `pal status` 只有单条记录，没有端口 / 资源账本 | `[open]` | 无 |
| A13 | 决策没写回文档 | `concepts.md`、`details/pal.md` 只写现状，没写隔离与凭据策略 | `[open]` | A1、A3 定稿 |

## B 组：坏影响（2 条）

| 编号 | 事项 | 位置 / 证据 | 状态 | 前置 |
|---|---|---|---|---|
| B12 | 端口反查 pid 可能记错 / 误杀 | `start.ts` 靠端口反查监听者记 pid，杀前不校验归属 | `[decision]` | 见上表，等你定 pid 语义 |
| B14 | 本地 API 只挡浏览器 | `isTrustedRequest`（`server.ts`）比对 Origin / Host 加 `x-pal-client`；本机其他进程可直连 | `[proposal]` | 已定 token「只防浏览器」；若按 E1/E3 去掉 HTTP 面，此条改成“收敛传输” |

## C 组：脏乱差（5 条）

| 编号 | 事项 | 位置 / 证据 | 状态 | 前置 |
|---|---|---|---|---|
| C4 | 三份事实 | `instance.json` 的 pack/planHash、`.packhub/state.json`、`baseline.json` 各存一份，更新要同步三处 | `[open]` | 无 |
| C7 | 静默失败 | `seedHome` 单文件复制、update 删旧文件、日志轮转与读取都有 `catch {}` | `[open]` | 无 |
| C8 | 状态机缺 `unknown`/`stale` | 进程自然退出、无人刷新时记录仍是 `running`（读接口已改成纯视图） | `[open]` | 无 |
| C9 | 没有 service 层 | HTTP handler 直接调 materialize/create/update，CLI 又重复一遍 | `[open]` | 无 |
| C10 | 测试缺口 | 隔离策略（尚无）、并发看护 / 停止、迁移回滚失败分支、Electron 壳均未覆盖 | `[open]` | 随对应条目补 |

## D 组：坏味道（7 条）

| 编号 | 事项 | 位置 / 证据 | 状态 | 前置 |
|---|---|---|---|---|
| D1 | 记录同时是配置与运行态 | `InstanceRecord` 把 status/pid/url/lastExit 与 pack/planHash 混装 | `[open]` | 与 A1 绑定 |
| D2 | 外壳边界糊 | launcher 直接 `installPack`，与「外壳只依赖 kernel/runtime」的说明不一致 | `[open]` | 无 |
| D3 | `ADAPTERS` 缺能力字段 | 只有 label/homeDir/homeEnv/executable/versionArgs，没有隔离旋钮、凭据位置、可共享层（`layout.ts`） | `[open]` | 与 A1 绑定 |
| D4 | 实例 id 是「时间戳 + 随机后缀」 | `newId`（`paths.ts`）改为 14 位时间戳 + 12 位 crypto 十六进制；旧 id 不迁移，两种并存可读 | `[done]` 8a02c18 | 无 |
| D5 | 错误文案回显绝对路径 | `PalError` 的 message / hint 直接拼 root、home | `[open]` | 无 |
| D7 | 桌面壳 `taskkill /F` 硬杀 | `apps/pal-desktop` 以 `/T /F` 收进程；E1 的 Electron 壳同样 `/T /F`。优雅退出要先给 `pal serve` 一个关闭入口 | `[open]` | E3/A10 |
| D9 | 取包缓存 slug 只截末 40 字符 | `slug()` 现在拼完整引用的 sha256 前 10 hex；旧缓存目录被弃用，等 A4 清理 | `[done]` 9793c18 | A4 |

## E 组：Electron 工作流（5 条）

| 编号 | 事项 | 位置 / 证据 | 状态 | 前置 |
|---|---|---|---|---|
| E1 | 最小 Electron 壳 | `apps/pal-electron`：spawn `pal serve --json`、读地址、窗口加载；侧车异常有可见错误。pnpm 跳过 electron postinstall，二进制要手动补一次（README 已写） | `[done]` e48ea2d | 无 |
| E2 | 前端 API 层抽离 + IPC 桥 | `web/app.js` 的 `api()` 直接 fetch；拆出 `api.js`，浏览器走 fetch、Electron 走 preload 的 IPC | `[open]` | E1 |
| E3 | 侧车传输收敛 | `pal serve` 保留 HTTP（仅 dev）还是改 stdio / 内部 RPC；决定 B14 是「加 token」还是「去掉 HTTP 面」 | `[decision]` | E1、E2 |
| E4 | 退役 WinForms/WebView2 壳 | 删 `apps/pal-desktop/*.cs`；同步 `README.md`、`.github/workflows/pal.yml`、`build:pal-desktop` 与分发脚本 | `[open]` | E1 可用后 |
| E5 | 打包范围 | Windows-only 还是保留 macOS/Linux；跨平台要先审 `pal serve` 与路径逻辑的 Windows 假设（见 [details/windows.md](details/windows.md)） | `[decision]` | E1 |

## N 组：本轮实现暴露的（5 条）

| 编号 | 事项 | 位置 / 证据 | 状态 | 前置 |
|---|---|---|---|---|
| N1 | 界面强制更新入口 | 界面「更新」发空 body；`update.ts` 遇本地改动且无 force 就抛，界面只能报错。需要勾选或二次确认后再带 force | `[open]` | 无 |
| N2 | `remove` 不再 `removePack` 的副作用边界 | `remove.ts` 默认直接删根；当前根内没有外部副作用，将来若写宿主级 MCP / 配置注册要补清理 | `[open]` | 无 |
| N3 | `uninstalled` 报告语义 | 归档兜底时文件仍在归档里，CLI 与 `scripts/pal/smoke.mjs` 仍打印「已卸载 / 已删除」 | `[open]` | 无 |
| N4 | 校验函数位置 | `assertNameFree` / `assertHarness` 暂放 `create.ts` 并导出给 index / migrate 复用，宜收进 `validators.ts` | `[open]` | C1 遗留结构 |
| N5 | 过时注释 / 文案 | `catalog.ts` 头注释仍说「写入流程在 index.ts」；`smoke.mjs` 的「已卸包并删根」在 B13 后不准确 | `[open]` | 无 |

## 计数

| 组 | 编号 | 条数 |
|---|---|---|
| A | A1–A13 | 13 |
| B | B12、B14 | 2 |
| C | C4、C7、C8、C9、C10 | 5 |
| D | D1–D5、D7、D9 | 7 |
| 小计 | 原始剩余 | **27** |
| E | E1–E5 | 5 |
| N | N1–N5 | 5 |
| 合计 |  | **37** |

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

> 继续 PackHub PAL 审计剩余 37 条（原 27 + E1–E5 + N1–N5），仓库在 `5ca4cab`。先做 A1/A2；Electron 迁移从 E1 开始；B12/凭据策略待定。

## 完成判据

- 代码合入，且有至少一条测试或实测证据；`pnpm check` 全绿。
- 涉及界面或分发的条目，另跑对应的 `pal:bundle` / `pal:smoke`。
- 做完一条改状态并写 commit；现状描述同步到 [PackHub-功能全量清单](PackHub-功能全量清单.md) 与 [details/pal.md](details/pal.md)。
