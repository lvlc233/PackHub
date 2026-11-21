---
kind: decision
summary: 有意为之的取舍
verified: 2026-11-18
decay: 365
review: 任何一条的前提变了（跨包引用进格式 v0、清单字段增删、锁形状或签名载荷变化、命令层再出现例外、加 mac 门禁、命令面收缩）
---

# PackHub 的取舍

### 格式 v0 不做跨包引用与继承

来源只指向内容本身：包内文件、代码仓库、包管理器、URL；

没选另一条：跨包引用要先定包身份、传递安装语义与锁的跨包表达——谁负责装被引用的包、两个包要不同版本怎么办、跨包的版本对齐怎么进计划。这些都得在格式 v0 的锁格式里留位置；格式没稳定之前先定，会把形状钉死。

代价：包只能自包含，或所有来源都能在安装时远程取到；reference 模式打包时含本地来源直接失败（`pack` 的 `LocalSourceNotVendoredError`）。复用只能靠重新发布成资源，或让多个包引同一份远程上游。

### target 退出内容层，清单也不再声明支持集

锁只描述内容：`resolved` + `contentHash`（清单 + resolved 的规范化哈希，`lock.ts` 的 `contentHashOf`）。安装 target 是安装参数——`planFor(ctx, { target })` 在用到它的那一刻现算计划，不传就是 `dir`；签名载荷是 `{pack, contentHash}`（`signature.ts` 的 `signablePayload`）。清单的支持集声明也一起删了：schema 的 `metadata.required` 只剩 `name` / `version`，`additionalProperties: false`，旧清单带 `targets` 判 schema error；registry 索引不再有 `targets` 字段（`build.ts` 的 `buildIndex`）；发布门禁不再要求清单声明 dir，直接按 dir 干净安装并验证（`run.ts`）；launcher 建/更新实例、runtime 更新直接按选的 target 装——都不再读清单声明。

没选另一条：把每个 target 的计划快照留在锁里（`plan` / `plans` / `planHash`），签名覆盖计划哈希。target 不是内容：同一份 Pack 装到 dir 或任一宿主，装的是同一批字节，锁却会随宿主数量膨胀；每个 target 的快照都要在每次清单变化时重算、重核对，签名还要回答「签的是哪个 target 的计划」。把 target 收进安装期后，锁只有一份，内容哈希与 target 无关，`checkLockConsistency(lock, manifest)` 退化成「重算 contentHash」这一条判据。也没选「只把计划移出锁、保留清单的支持集声明」：声明是一份要单独维护的第二真相，每加一个宿主都要改清单、重锁、重签、重发版本，而它最终只用来在计划期拦一下；装不装得成，由落点表和安装结果说了算。

代价：装到不合适的宿主不再在计划期被拦——`requires.agent` 是已知 target 且与本次 target 不同时只给 warning（`agent-target-mismatch`），写得不在已知 harness 里也只给 `unknown-agent` warning；除此之外没有任何声明可对。要么装完在 `verify` 暴露，要么按该 target 的落点表装出一份作者没验证过的结果。给已发布包加宿主不再需要发新版本：同一份内容、同一把锁、同一个签名可以按新 target 装（落点由该 target 的适配表决定）。索引和锁里都不再有「这包支持哪些宿主」，用户与读端只能直接按 target 试，无法先筛。签名只证明内容、不再证明某个 target 的安装结果——换 target 不会让签名失效；`diff` 没有锁里的旧计划可读，只能读 state 里安装时留下的 `PlanSnapshot`（没装过就没有旧计划，`diff` 要求先安装）；`verify` 在项目根也按 state 快照复核，包目录模式则现算；发布门禁只验 dir 一个 target，其余 target 的安装行为只有单测；没有 `contentHash` 的锁是无效锁，registry 门禁报 error（`build.ts` 的 `buildIndex`），必须重跑 `packhub lock`（原来有签名的还要重签）。

### 命令层是薄壳，例外只剩一处

`apps/local` 的命令只做三件事：解析参数、调一次 runtime / kernel、把结果排版输出。`verify` 的模式分叉（项目根读 state 里的已装包、包目录读清单）已经下沉到 runtime 的 `verifyAt`：命令层不再自己判目录。

没选另一条：把这处判断留在命令层（或让每个调用方各写一遍）。runner 与发布门禁走同一个 runtime，入口选择若由调用方各判一次，同一目录在 CLI 与 runner 里会得出不同结论；收成 `verifyAt` 后只有一处判。

例外：`install` 成功后的审计写入（`appendAudit`）仍在命令里，写失败只 warn，不回滚也不改退出码。

没选另一条：把审计写进 `installPack`。runner 的干净安装与发布门禁都经过它，机器验包的那次安装会写进用户审计，与「用户跑了一次命令」混在一条流里。

代价：审计写入点分散在命令层，每条新命令要自己记得写，不经 CLI 的安装不写审计。

### macOS 与 Electron 壳不在当前承诺内

仓库里没有 CI 矩阵（`.github/` 已删），Windows 专属用例只在 `pnpm check` 里跑；Electron 壳与打包脚本已删（PAL-37）。

没选另一条：加一份 macOS 矩阵，或留着壳等以后打包。mac 上的差异是路径分隔符与权限位，Linux 与 Windows 的用例没喂出第三种行为；多一条矩阵要一直有人管，换不到验证（没有使用方）。壳没有使用者、也打包不起来，留着只是一份会腐烂的代码。

代价：mac 上的路径、权限位（私钥 0600 之类）、宿主落点都没有门禁，出问题只能靠人真跑；要桌面壳时从头做。

### 命令面按对象划分：packhub 碰目录，pal 碰实例

一条命令只对一个对象动手。`packhub` 的对象是目录：Pack 目录与项目目录，解析、计划、安装、校验、发布都在目录里发生，装完即止；`pal` 的对象是实例：建实例，在实例上装、更新、卸载，起停与看护。分界线是「有没有一份要跑起来的环境」——目录里只有文件与 state，home、进程、端口只属于实例。对象唯一，动词于是也唯一：同一份内容不管来自目录、`.phub`、registry 名还是 `git+https` 仓库，装进目录就是 `install` 这一条入口，不再按落点各开一条；项目里也不留「装了哪些版本、哪个在激活」这份第二状态，切版本就是在目录里再装一次 `name@version`，`rollback` 仍回上一代；发布前那次干净安装加校验也不单开入口，并进 `publish`——它本来就是发布的第一步。往全局 home 铺东西不在 `packhub` 里做了：全局环境是实例的 home，归 `pal`，那条不写 state 的落点路径由此消失。

没选另一条：继续按落点铺长命令（一个落点一条），或者保留 `sync` 管全局 home、保留 `versions` + `activate` 管项目内切换版本。

按落点铺长命令时，命令的对象变成「这次落到哪个宿主」而不是「改哪个东西」：同一个动作几条入口，每条都要重新回答「装的是不是同一份内容、锁与签名管不管用、审计写不写」，而这些答案本来就是同一份。`sync` 那条全局 home 路径在 state 里没有记录，事后回滚、卸载、漂移检查都没有可核对的账，等于在记录体系外开一个写盘口；换成实例，落点有 `instance.json` / `runtime.json` 与实例根的 state，装了什么、删了什么都能追。`versions` + `activate` 要在项目里维护第二份状态，而安装本身可重复：切版本装一次就够，多留一份激活指针只会和 state 里的 `generations` 打架——「现在是哪个版本」得有两处说了算。

代价：切版本是重装一次，没有开关式切换——要重算计划、重走一遍写盘与卸载，失败时目录停在安装事务的哪一步由 `rollback` 决定。`verify` 把漂移与真机探针合成一次输出，一次要同时讲两件事，读的人得自己分辨哪一段失败。全局 `dsh` 不再能靠一条命令铺好：要用全局环境就得建一个实例，多一份实例记录、多一次启动。跨对象的流程拆成两步——先在目录里装，再到实例上装或更新，脚本里没法一步到底。

### 命令面大于 README 的承诺

README 只承诺一件事：「一条命令装进新项目，换台机器装出来的是同一套」；CLI 的实际面宽得多，覆盖到哪些环节以 `packhub --help` 为准。

没选另一条：把命令面裁到只留 README 承诺的那几个，或让 README 逐条承诺命令。裁掉等于砍能力入口（发布、trust 都有测试）；逐个承诺则每加一条命令都要改 README 并保证说明跟得上，而说明在格式稳定前一定会和代码对不上——README 自己的话：错的说明比没有说明更贵。

代价：README 那句话不构成对任意命令的承诺，命令面每条都得有人核（`--help` 是唯一被测试盯着的出口）；对外解释得靠 `--help`，不能只看 README。
