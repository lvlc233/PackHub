---
kind: decision
summary: 有意为之的取舍
verified: 2026-11-18
decay: 365
review: 任何一条的前提变了（跨包引用进格式 v0、锁形状或签名载荷变化、命令层再出现例外、加 mac 门禁、命令面收缩）
---

# PackHub 的取舍

### 格式 v0 不做跨包引用与继承

来源只指向内容本身：包内文件、代码仓库、包管理器、URL；

没选另一条：跨包引用要先定包身份、传递安装语义与锁的跨包表达——谁负责装被引用的包、两个包要不同版本怎么办、跨包的版本对齐怎么进计划。这些都得在格式 v0 的锁格式里留位置；格式没稳定之前先定，会把形状钉死。

代价：包只能自包含，或所有来源都能在安装时远程取到；reference 模式打包时含本地来源直接失败（`pack` 的 `LocalSourceNotVendoredError`）。复用只能靠重新发布成资源，或让多个包引同一份远程上游。

### target 退出内容层，计划改为按需现算

锁只描述内容：`resolved` + `contentHash`（清单 + resolved 的规范化哈希，`lock.ts` 的 `contentHashOf`）。安装 target 是安装参数——`planFor(ctx, { target })` 在用到它的那一刻现算计划；签名载荷是 `{pack, contentHash}`（`signature.ts` 的 `signablePayload`）；发布只跑 dir 一个 target 的干净安装（`run.ts` 拒绝未声明 dir 的清单）。

没选另一条：把每个 target 的计划快照留在锁里（`plan` / `plans` / `planHash`），签名覆盖计划哈希。target 不是内容：同一份 Pack 装到 dir 或任一宿主，装的是同一批字节，锁却会随宿主数量膨胀；每个 target 的快照都要在每次清单变化时重算、重核对，签名还要回答「签的是哪个 target 的计划」。把 target 收进安装期后，锁只有一份，内容哈希与 target 无关，`checkLockConsistency(lock, manifest)` 退化成「重算 contentHash」这一条判据。

代价：签名只证明内容、不再证明某个 target 的安装结果——换 target 不会让签名失效；`diff` 没有锁里的旧计划可读，只能读 state 里安装时留下的 `PlanSnapshot`（没装过就没有旧计划，`diff` 要求先安装）；`verify` 在项目根也按 state 快照复核，包目录模式则现算；发布门禁只验 dir 一个 target，其余 target 的安装行为只有单测；没有 `contentHash` 的锁是无效锁，registry 门禁报 error（`build.ts` 的 `buildIndex`），必须重跑 `packhub lock`（原来有签名的还要重签）。

### 命令层是薄壳，例外只剩一处

`apps/local` 的命令只做三件事：解析参数、调一次 runtime / kernel、把结果排版输出。`verify` 的模式分叉（项目根读 state 里的已装包、包目录读清单）已经下沉到 runtime 的 `verifyAt`：命令层不再自己判目录。

没选另一条：把这处判断留在命令层（或让每个调用方各写一遍）。runner 与发布门禁走同一个 runtime，入口选择若由调用方各判一次，同一目录在 CLI 与 runner 里会得出不同结论；收成 `verifyAt` 后只有一处判。

例外：`install` 成功后的审计写入（`appendAudit`）仍在命令里，写失败只 warn，不回滚也不改退出码。

没选另一条：把审计写进 `installPack`。runner 的干净安装与发布门禁都经过它，机器验包的那次安装会写进用户审计，与「用户跑了一次命令」混在一条流里。

代价：审计写入点分散在 install / add / update，新命令要自己记得写，不经 CLI 的安装不写审计。

### macOS 与 Electron 壳不在当前承诺内

仓库里没有 CI 矩阵（`.github/` 已删），Windows 专属用例只在 `pnpm check` 里跑；Electron 壳与打包脚本已删（PAL-37）。

没选另一条：加一份 macOS 矩阵，或留着壳等以后打包。mac 上的差异是路径分隔符与权限位，Linux 与 Windows 的用例没喂出第三种行为；多一条矩阵要一直有人管，换不到验证（没有使用方）。壳没有使用者、也打包不起来，留着只是一份会腐烂的代码。

代价：mac 上的路径、权限位（私钥 0600 之类）、宿主落点都没有门禁，出问题只能靠人真跑；要桌面壳时从头做。

### 命令面大于 README 的承诺

README 只承诺一件事：「一条命令装进新项目，换台机器装出来的是同一套」；CLI 的实际面宽得多，覆盖到哪些环节以 `packhub --help` 为准。

没选另一条：把命令面裁到只留 README 承诺的那几个，或让 README 逐条承诺命令。裁掉等于砍能力入口（发布、trust 都有测试）；逐个承诺则每加一条命令都要改 README 并保证说明跟得上，而说明在格式稳定前一定会和代码对不上——README 自己的话：错的说明比没有说明更贵。

代价：README 那句话不构成对任意命令的承诺，命令面每条都得有人核（`--help` 是唯一被测试盯着的出口）；对外解释得靠 `--help`，不能只看 README。
