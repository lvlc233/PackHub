# PAL 剩余决策（2026-11-10）

基线：`ac95717`，`pnpm check` 全绿（82 文件 / 450 用例）。50 条审计已关闭 38 条，剩余 15 条（见 [PAL-审计待办](PAL-审计待办.md)）。本文只列**需要你拍板**的四组语义，以及不拍板就动不了的结构项；做完一条就在待办表改状态。

## 一、四个待决

### A3 凭据策略

- **copy（建议）**：每个实例一份凭据，建实例时从 `--from-home` 复制；之后宿主登录写的是实例自己那份。禁止 link。归档/删除时凭据随实例走；备份默认不带，`--include-secrets` 显式带（已按此实现）。
- **shared-ro**：实例只读共享宿主的凭据，登录仍由宿主那份负责；需要处理 refresh token 轮换与并发写，且「一个实例退出不影响别的实例」这条要重新验。

影响：A7（策略迁移）、A13（写回 concepts/pal）。选 copy 的话 A7 只做「已有实例按新默认重排」；选 shared-ro 还要做只读共享与轮换的保护。

### B12 pid 语义

- **现状**：启动后用端口反查监听者记 `pid`，杀掉前不校验归属；Windows 上 spawn 的是 `.cmd` 垫片，监听者是它的子进程。
- **建议**：记录 `spawnPid`（自己 spawn 的）与 `listenPid`（端口反查，仅证据）；stop 只杀 `spawnPid`，端口换人/记录 pid 与端口主人不一致时**拒杀**并提示。代价：界面/脚本看到的 pid 从「真正监听者」变成「cmd 垫片」；旧记录没有 `spawnPid` 只能保守拒杀。
- **备选**：维持现状，只在 `pal doctor` 里做事后取证（启动时间/命令行匹配）。

影响：A10（watch 重起也按 pid 判断）、D7（优雅退出）、E4（旧壳杀进程）。

### E3 侧车传输

- **HTTP + token（当前实现）**：`pal serve` 只监听 127.0.0.1，浏览器请求要 `x-pal-token`，无 Origin 的本机调用不校验；静态资源不校验。开发调试方便。
- **stdio / 内部 RPC**：Electron 通过管道说话，不再有 HTTP 面；B14 的 token 可以删。改动集中在 `apps/pal-electron`、`web/api.js`、`server.ts` 的传输层。

建议：0.x 先保留 HTTP + token（已可用），E4 退役旧壳前再评估是否切 stdio。

### E5 打包范围

- **Windows-only（建议）**：当前 `pal serve`、路径、进程树、`.cmd` 垫片都有 Windows 假设；先只承诺 Windows。
- **跨平台**：要审 POSIX 的进程组、信号、路径大小写与 `pal:smoke`，工作量另算。

影响：E4 的分发脚本与 CI。

## 二、不需要产品决策、但要确认顺序的结构项

| 项 | 内容 | 依赖 |
|---|---|---|
| C4 | `instance.json` 的 pack/planHash、`.packhub/state.json`、`baseline.json` 三份事实合一：建议以 state 为安装事实、record 只留展示与引用、baseline 只留哈希 | D1 |
| D1 | 记录拆「配置/身份」与「运行态」：status/pid/url/lastExit 进独立 runtime 区（或单独文件） | A1 已完成，可动 |
| D3 | `ADAPTERS` 补能力字段（可隔离层、凭据位置、可共享层），供 A1/A3 使用 | A3 |
| C9 | service 层：HTTP handler 与 CLI 共用的用例函数，避免两套编排 | C4/D1 |
| C10 | 补测试：Electron 壳、并发看护边界；其余（隔离策略、迁移回滚、停止竞争）已有覆盖 | E1 |
| D2 | 外壳边界：launcher 直接 `installPack` 与「外壳只依赖 kernel/runtime」的说明不一致；要么改文档承认 launcher 是装配外壳，要么把编排下沉 | 无 |
| D7 | 桌面壳优雅退出：先请求 `pal serve` 关闭，再收进程；现在两套壳都是 `/T /F` | E3 |
| A11 | 运行时版本管理：当前分发自带 node，不能切换；先记录/展示版本，再谈多版本 | 无 |
| E4 | 退役 `apps/pal-desktop`：已获批准并删除（`bfe21fd`） | E1 可用 |

## 三、如果你说「按建议继续」

默认采用：**A3 copy、B12 spawnPid、E3 HTTP+token、E5 Windows-only、E4 暂不删旧壳**。我会按 `A3 → A7/A13 → B12 → C4/D1/D3 → C9 → C10 → D2/D7/A11 → E4` 的顺序，一轮一项，继续走「派发 + 审 diff + typecheck + 相关测试」。
