---
kind: decision
summary: 有意为之的取舍
verified: 2026-11-22
decay: 365
review: 任何一条的前提变了（跨包引用进格式 v0、清单字段增删、锁形状或签名载荷变化、接线规则再变、检查派生规则再变、安装参数或落点表改名、命令族边界再变、命令层再出现例外、加 mac 门禁、命令面收缩）
---

# PackHub 的取舍

### 格式 v0 不做跨包引用与继承

来源只指向内容本身：包内文件、代码仓库、包管理器、URL；

没选另一条：跨包引用要先定包身份、传递安装语义与锁的跨包表达——谁负责装被引用的包、两个包要不同版本怎么办、跨包的版本对齐怎么进计划。这些都得在格式 v0 的锁格式里留位置；格式没稳定之前先定，会把形状钉死。

代价：包只能自包含，或所有来源都能在安装时远程取到；reference 模式打包时含本地来源直接失败（`pack` 的 `LocalSourceNotVendoredError`）。复用只能靠重新发布成资源，或让多个包引同一份远程上游。

### 能力用接口令牌命名，接线从 needs 派生

能力名是接口，不是资源类别：`<form>/<name>@<major>`，`form` 闭集 `tool` / `skill` / `content` / `config`（消费形态：工具调用、技能、可读内容、配置），`name` 是 kebab-case 的功能名，`@major` 是接口主版本、从 1 起，不同主版本就是互不满足的两种能力。资源类型（`mcp` / `tool2` / `skill` / `prompt` / `knowledge` / `config`）继续管落点与执行，但不出现在能力名里。接线不再有单独的 `dependsOn`：`needs` 既是能力依赖也决定安装顺序（每个 provider 到 consumer 一条边，成环仍报 `dependency-cycle`）。清单仍是接线的唯一来源——`plan` 打印的接线图由 kernel 的 `describeComposition` 从清单现算，没有 `composition` 块，也不落盘。

没选另一条：继续用 `类型:名字`（`audio:speak`、`tool:repo_search`）；保留 `dependsOn`；给能力加语义命名空间（如 `docs/lint@1`）而不是 form。

`类型:名字` 把资源类型和功能分类混进同一个命名空间：`audio:speak` 的 `audio` 是功能，`tool:repo_search` 的 `tool` 是类型，读令牌的人分不清该按哪种契约匹配，schema 也只能放宽成自由字符串。form 是有限、正交于资源类型的维度，能进 schema 的枚举，读方还能按消费形态分组。保留 `dependsOn` 则纯顺序关系要作者再声明一遍，而能力依赖已经蕴含了这条边；两份声明冲突时还要定优先级，且没有东西检查它们一致。语义命名空间随功能无限分裂，形不成闭集，也没法在计划里按维度分组。

代价：主版本只有整数、没有范围匹配——`needs tool/lint@1` 不满足 `tool/lint@2`，接口升级要所有提供方与消费方同时改；删掉 `dependsOn` 后，两个没有能力关系但必须先写谁的资源没有表达方式，只能靠输出冲突在计划里暴露，或在 `needs` 里编一个假能力来拉边；`form` 让 `knowledge` / `prompt` 在能力层合并成 `content`，落点仍由资源类型决定，两者对不上（如 `prompt` 资源 provides `tool/*`）schema 不拦，靠作者自律；改名是破坏性变更，registry 里已发布的清单要原地迁移并重锁。

### 能力叠加，不做互斥

清单里只有两种接线关系：资源 `provides` 的令牌和资源 `needs` 的令牌。同一令牌有多个 provider 时全部安装——它们不互斥，也没有「这次只装其中一个」的选择；消费者的每个 `needs` 只要至少有一个 provider 就算满足，安装顺序仍是 provider 先于 consumer。中间试过用备选组（`alternatives`）+ `pick` 表达「组内只装一个」，因没有需求证据删除了：registry 里没有包声明过备选组（原先唯一需要选择语义的包也只有一个实现），用户侧也没人要求「装两个会冲突」的表达。

没选另一条：保留备选组 / `pick`（组内成员互斥，`pick` 或唯一成员决定装哪个）。互斥语义要维护组与成员校验、选中状态、排除原因、`--pick` 覆盖、local.yaml 与一组专用错误码；这些成本落在每个用不到互斥的人身上，而「能不能一起装」本应由计划与 verify 用输出冲突暴露，不该让清单预判。能力叠加还能直接表达「两个实现都装」（例如两个 skill 同时提供 `skill/review@1`），互斥模型反而装不下。

代价：清单表达不了「同一能力只装一个」——两个实现提供同一令牌、装一起又冲突时（例如写同一个工具入口），只能靠计划期的输出冲突（`output-conflict`）或运行时暴露，没有清单层的互斥开关。真出现这种需求时，按包拆（一个包只带一个实现）或将来在格式里加显式标记（资源级或能力级的「独占」），现在不预建。删除也是破坏性的：`alternatives` / `pick` 字段、配套错误码与排除原因一起删，已发布清单要迁移并重锁，格式 v0 不给过渡期。

### 安装宿主退出内容层，清单也不再声明支持集

锁只描述内容：`resolved` + `contentHash`（清单 + resolved 的规范化哈希，`lock.ts` 的 `contentHashOf`）。安装宿主是安装参数——`planFor(ctx, { harness })` 在用到它的那一刻现算计划，不传就是平铺目录；签名载荷是 `{pack, contentHash}`（`signature.ts` 的 `signablePayload`）。清单的支持集声明也一起删了：schema 的 `metadata.required` 只剩 `name` / `version`，`additionalProperties: false`，旧清单带 `targets` 判 schema error；registry 索引不再有 `targets` 字段（`build.ts` 的 `buildIndex`）；发布门禁不再要求清单声明支持集，直接按平铺目录干净安装并验证（`run.ts`）；launcher 建/更新实例、runtime 更新直接按选的宿主装——都不再读清单声明。

没选另一条：把每个宿主的计划快照留在锁里（`plan` / `plans` / `planHash`），签名覆盖计划哈希。宿主不是内容：同一份 Pack 装到平铺目录或任一宿主，装的是同一批字节，锁却会随宿主数量膨胀；每个宿主的快照都要在每次清单变化时重算、重核对，签名还要回答「签的是哪个宿主的计划」。把宿主收进安装期后，锁只有一份，内容哈希与宿主无关，`checkLockConsistency(lock, manifest)` 退化成「重算 contentHash」这一条判据。也没选「只把计划移出锁、保留清单的支持集声明」：声明是一份要单独维护的第二真相，每加一个宿主都要改清单、重锁、重签、重发版本，而它最终只用来在计划期拦一下；装不装得成，由落点表和安装结果说了算。

代价：装到不合适的宿主不再在计划期被拦——资源与清单都不声明安装形态，计划里没有任何声明可对。要么装完在 `verify` 暴露，要么按该宿主的落点表装出一份作者没验证过的结果。给已发布包加宿主不再需要发新版本：同一份内容、同一把锁、同一个签名可以按新宿主装（落点由该宿主的适配表决定）。索引和锁里都不再有「这包支持哪些宿主」，用户与读端只能直接按宿主试，无法先筛。签名只证明内容、不再证明某个宿主的安装结果——换宿主不会让签名失效；`diff` 没有锁里的旧计划可读，只能读 state 里安装时留下的 `PlanSnapshot`（没装过就没有旧计划，`diff` 要求先安装）；`verify` 在项目根也按 state 快照复核，包目录模式则现算；发布门禁只验平铺目录这一形态，其余宿主的安装行为只有单测；没有 `contentHash` 的锁是无效锁，registry 门禁报 error（`build.ts` 的 `buildIndex`），必须重跑 `packhub lock`（原来有签名的还要重签）。

### 安装参数改名 harness、dir 退出枚举，PAL 用 kind

上一条把安装形态收进安装期后，参数仍叫 `--target`，枚举里混着中性落点 `dir` 与三个宿主名。`dir` 不是宿主，只是平铺落点表的名字；写成 `--target dir` 会让人以为 `dir` 是某种宿主形态，作者命令里出现 `--target` 也容易被读成内容层参数。

现在 packhub 只选宿主：`plan` / `install` / `verify` 用 `--harness`，取值只有 `dsh` / `claude-code` / `codex`；不写就是平铺目录，计划里没有 `harness` 字段。PAL 的实例形态另用 `--kind`：`create` 只接受宿主名，`dir` 只出现在 `adopt`（接管已有目录）里；`instance.json` 仍记 `harness` 字段（值含 `dir`），记录格式不动。

没选另一条：保留 `--target` 并把 `dir` 留在枚举里，或让两个命令族统一叫 `--harness`。留 `--target` + `dir` 等于让一个参数同时回答「装到哪个宿主」和「要不要平铺」，每处调用都要先解释 `dir` 不是宿主；统一叫 `--harness` 则 PAL 的 `dir` 得假装成宿主名，实例记录与落点表也要跟着改词。两个命令族用不同参数名是有意的：packhub 的参数决定「内容按哪张落点表物化」，PAL 的参数决定「实例是什么形态」；同名会把这两个概念重新混在一起。

代价：`plan` 与 `PlanSnapshot` 的形状变了（`target` 换成可选的 `harness`），`planHash` 随之变化——registry 里已发布的包要重锁、重跑 verify 并重建索引，否则锁、报告与当前代码算出的计划对不上。同一轮把清单插值命名空间从 `${target.*}` 改成 `${layout.*}`：旧写法在计划期找不到键，报 `undefined-variable`，已发布清单要原地改并重锁。两个命令族各用一套词，文档与 `--help` 要各讲一次，从 `--harness` 切到 PAL 的人得换一个词。

### 宿主注册表：核 + 每宿主模块

一个宿主要回答的问题分散在几处：落点表（文件写到哪）、实例 home 与环境变量、可执行名与版本参数、凭据文件、指令文件名、启动模板、探针配方。上一版把静态知识收进 kernel 的一张 `HARNESSES` 大表（`HARNESS_IDS` / `LAYOUT_VARS` 从表派生，加宿主 = 表里加一行、`Record` / `keyof` 编译期卡完备）。表变大之后，所有宿主的启动模板与探针逻辑挤在同一个文件里，改一个宿主也要在同一处翻，而探针配方还留在 runtime——「加宿主」的边界仍然不是一个模块。

现在改成运行期注册表：`kernel/src/harness/contract.ts` 定义 `HarnessSpec` / `ProbeRecipe` 与 `registerHarness` / `harnessIds` / `requireHarness` / `layoutFor` 等查表 API；每个宿主一个模块（`dsh.ts` / `claude-code.ts` / `codex.ts`），在自己的文件里 `registerHarness({...})`，探针配方随模块走；`harness/index.ts` import 三个模块完成注册。加宿主 = 新建 `harness/<id>.ts` + index 一行 import，launcher / runtime / 探针都从注册表查，不用改。注册是 import 副作用：重复 id 或非法 id 在注册时抛错。

没选另一条：保留一张大表，或把宿主描述做成 registry 下发数据 / runtime 插件。大表把一个宿主的全部知识挤在同一个文件里，加宿主改一处但同时改到所有人；数据描述把「怎么装」变成可远程改的输入，要配信任与钉版本，而启动模板、探针配方里还有只能写成代码的行为；runtime 插件要在 kernel 里再开一个执行面（加载时机、失败隔离、版本兼容与信任）。宿主是产品支持集，不是用户扩展点。

代价：`HarnessId` 从编译期联合类型变成运行期 `string`——穷尽性没了，靠 `isHarnessId()` 与 schema 的 `^[a-z][a-z0-9-]*$` pattern 兜底；schema 不能静态枚举宿主名，`scenario.harness` 也只能是 pattern。注册靠 import 副作用：`harness/index.ts` 漏 import 一个模块，那个宿主就不存在，错误只在运行期暴露。第三方宿主仍不能自己加——必须改代码并随 packhub / pal 发版；加宿主仍要动 barrel 的那一行 import。

### 资源级 targets 与 requires.agent 删除

`resources[].targets` 与清单的 `requires.agent` 都删了：schema 里资源条目不接受 `targets`，`requires` 只剩 `packhub`；registry 索引的 `requiresAgent` 展示字段一起删，`target-mismatch` 与 `agent-target-mismatch` / `unknown-agent` 三个码也不再出现。

删之前，registry 里没有包写这两个字段；仓库里唯一的用例是 `target-trim` 测试里给「桌面版」专用的资源裁剪（那个测试随字段一起删），而桌面版（Electron 壳）已经删了。资源级 `targets` 也和上一条冲突：宿主是安装参数，资源再声明「我只在哪些宿主上装」等于让内容层再管一次安装形态，同一个落点有两处说了算。`requires.agent` 同理：作者写的 agent 偏好只在计划期换一句 warning，装不装得成仍由落点表决定。

没选另一条：留着字段等以后真有人用。空字段要一直进 schema、类型、索引和文档；有人写错时还得解释「为什么写了不生效」，比没有这个字段更贵。

代价：真出现宿主专用资源时，只能按宿主拆包发布；格式 v0 不做跨包引用，共享内容只能在每个包里各带一份。将来若这种需求真的出现，在能力层表达：`host` 作为一个 form，由宿主提供 `host/<harness>@1`，资源用 `optional` 需要它——让「这条资源要哪个宿主」成为接线的一部分，而不是给内容加支持集。

### 命令层是薄壳，例外只剩一处

`apps/local` 的命令只做三件事：解析参数、调一次 runtime / kernel、把结果排版输出。`verify` 的模式分叉（项目根读 state 里的已装包、包目录读清单）已经下沉到 runtime 的 `verifyAt`：命令层不再自己判目录。

没选另一条：把这处判断留在命令层（或让每个调用方各写一遍）。runner 与发布门禁走同一个 runtime，入口选择若由调用方各判一次，同一目录在 CLI 与 runner 里会得出不同结论；收成 `verifyAt` 后只有一处判。

例外：`install` 成功后的审计写入（`appendAudit`）仍在命令里，写失败只 warn，不回滚也不改退出码。

没选另一条：把审计写进 `installPack`。runner 的干净安装与发布门禁都经过它，机器验包的那次安装会写进用户审计，与「用户跑了一次命令」混在一条流里。

代价：审计写入点分散在命令层，每条新命令要自己记得写，不经 CLI 的安装不写审计。

### 检查由程序派生，作者只写推不出来的

`verify` 的检查不再靠作者在清单里写全。漂移段由程序按 state 里的安装记录查磁盘：写过的文件/链接在不在、指令托管块、配置里的 `mcpServers` 条目、宿主侧 MCP 登记、`state` 目录、激活指针。检查段从计划自动派生：带 `integrity` 的 `write` 动作自动生成 `knowledge-integrity`（作者不用写），`verify --probe-mcp` 时每个 `register.mcp` 自动生成 `mcp-ready`（作者不用写）；派生项与作者写的同 `resource` + `integrity` 项去重。作者清单里的 `verify` 只写计划推不出来的两类：`command`（脚本 self-test）与 `scenario`（宿主语义，要真跑一次）。`file-exists` / `config-key` 仍支持，但属于重复兜底，不再推荐。`install` 装后自动复核带派生项，`publish` 门禁在干净目录跑清单检查 + 派生段。

没选另一条：继续让作者写全量检查（每条路径、每个哈希、每个 MCP 都手写）。这些期望值全都能从计划算出来，手写一遍只是把计划里的路径与哈希抄进清单；漏写时验证少查一项，写错时验证会「通过」一份作者其实没要求的内容，比不写更糟。自动段跟着计划走，资源落点或哈希变了，检查自动跟着变。

代价：自动段只知道计划里的事，看不到业务语义——脚本能不能真跑、文档结构是否符合团队约定、宿主有没有真读懂指令，仍只能靠作者的 `command` / `scenario` 或真机探针。`--probe-mcp` 默认关：给每个 MCP 起进程或联网有副作用与耗时，普通 `verify` 与装后复核都不做，要显式加 flag。包内 `checks` 少了以后，验证报告的信息量下降：报告里现在多是自动项，读报告的人不能只按项数判断覆盖度，得知道自动段覆盖的是什么。

### macOS 与 Electron 壳不在当前承诺内

仓库里没有 CI 矩阵（`.github/` 已删），Windows 专属用例只在 `pnpm check` 里跑；Electron 壳与打包脚本已删（PAL-37）。

没选另一条：加一份 macOS 矩阵，或留着壳等以后打包。mac 上的差异是路径分隔符与权限位，Linux 与 Windows 的用例没喂出第三种行为；多一条矩阵要一直有人管，换不到验证（没有使用方）。壳没有使用者、也打包不起来，留着只是一份会腐烂的代码。

代价：mac 上的路径、权限位（私钥 0600 之类）、宿主落点都没有门禁，出问题只能靠人真跑；要桌面壳时从头做。

### 安装归 PAL：packhub 只做生产

`packhub` 与 `pal` 按「生产 / 安装与运行」分：`packhub` 只碰 Pack 的生产面——清单、锁、打包、发布、签名，以及 Pack 目录里的预览（`plan` / `verify`），不写用户目录；装进项目、卸载、回滚、更新已装目录、建实例与起停看护都归 `pal`，目录安装与实例安装都在它这里。`pal create` 只建宿主实例（`--kind dsh` / `claude-code` / `codex`），目录形态的实例走 `pal adopt`；`pal audit` 看安装审计（审计由 `pal install` / `pal update` 写），`pal health --hosts` 兼职宿主发现（装没装、版本、能不能起）。`packhub verify` 只验 Pack 目录（检查段）；`pal verify` 验已装目录（漂移 + 检查）。一条命令仍只对一个对象动手：`packhub` 的对象是 Pack，`pal` 的对象是已存在的目录或实例。

原来 `packhub install` / `uninstall` / `update` / `rollback` / `diff` 都挂在 `packhub` 下面（它也吃项目目录）。现在目录侧的 `install` / `uninstall` / `verify` / `rollback` 由 `pal` 承接：`pal install <来源> --into <目录> --harness <宿主>` 只写文件与 `.packhub/state.json`，不建实例记录；`pal update` 同时接目录与实例；`create` 只建宿主实例，目录形态走 `adopt`。`diff` 直接删掉——装了什么在 state 里，要和清单比就重新 `plan` / `pal verify`。`packhub audit` 也删了，改成 `pal audit`（审计是 pal 写的东西，看也归 pal）；`pal doctor` 并入 `pal health --hosts`，health 默认查实例，加 flag 才附带宿主发现。`publish` 门禁里的干净安装仍由 runner 内部做，不走 CLI：它是发布流程的一步，不是用户装包。

没选另一条：`packhub` 保留 `install`，按「目录 vs 实例」分两套入口，或让 `pal` 只做实例。前者要维持两份安装参数、两套退出码与两份文档，而「装进目录」会同时出现在两个命令族的帮助里；后者则让目录侧没有安装入口，`pal install --into` 这种「先装目录、再决定要不要建实例」的用法无处安放。分界线换成「生产 vs 安装与运行」后，用户只需要记：做包找 `packhub`，装和跑找 `pal`。

代价：`pal` 的命令面变大——目录四件套、实例管理与起停看护、`audit` 与宿主体检挤在一个 CLI 里，`pal --help` 要同时讲目录、实例、本机状态三类事；README 的承诺从「一条命令装进新项目」改成「packhub 做包、pal 装和跑」，老用户得改习惯。`create` 少了 `--kind dir`：要一份目录形态的实例得先有目录再 `pal adopt`，比原来一步建多一步。`publish` 与 `pal` 各有一条安装路径：前者是门禁里的内部干净安装，后者是用户可见的目录安装，两条路径的检查范围不同（发布跑全部清单检查，`pal install` 装后复核只跑只读项），解释成本落在文档上。`packhub` 用户想装包还得多学一个 `pal` 入口。

### 读命令不写盘，动作显式

`pal list` 原来调 `listInstances()`，顺手把坏记录挪进隔离区；`pal ps` 原来叫 `pal status`，一跑就刷新状态写盘。读命令带写副作用，用户只是想看一眼也会改机器状态，脚本里更不敢随便调。现在 `list` 与 `ps` 都是纯读：`list` 把坏记录原样列出来（`坏记录 <目录> <原因>`），不动文件；`ps` 只出账本（在跑、端口、运行时长、端口冲突、已死的 pid），要看最新状态得显式 `pal ps --refresh`——它才按 pid 探测并写回记录。

同一原则落到另外两处：`pal recover` 改名 `pal leftovers`，只读列出隔离区 / 失败现场 / 归档区里的东西，不移动、不删除（原来「recover」听起来像会做恢复，实际只是看）；`pal update` 的位置参数只收实例，更新已装目录要写 `pal update --dir <目录>`。后者把「更新实例」和「更新目录」分成两个显式入口：位置参数拿到一个装过包的目录时不再猜，直接提示用 `--dir`；目录重装仍可 `pal install --into`。

没选另一条：让 `list` / `ps` 继续顺手整理（list 隔离坏记录、status 刷新状态），或让 `update <目录>` 按参数形状猜。读命令的副作用只在「记录坏了 / 进程死了」时发生，那恰恰是用户最不敢让它自动改的时候；猜目录则让一个位置参数同时表示实例与路径，报错信息也得两边解释。显式 flag 多打几个字，换来「看到什么就是什么」。

代价：`list` 不再自动清理坏记录，坏记录会一直出现在列表里，直到人工搬走或修好；`ps` 不刷新时可能显示 `stale`（pid 已死但记录没改），得记得加 `--refresh` 才是最新。`recover` 的老用户要改记 `leftovers`，且这个名字不再暗示能恢复；`update <目录>` 的老习惯要改成 `--dir`，否则会被当成实例名报错。`pal --help` 的参数更多了（`--refresh`、`--dir`），但每个写操作都只在显式 flag 后面发生。

### 命令面大于 README 的承诺

README 只承诺分工：「packhub 做包与发版，pal 安装与运行」；CLI 的实际面宽得多，覆盖到哪些环节以 `packhub --help` / `pal --help` 为准。

没选另一条：把命令面裁到只留 README 提到的那几个入口，或让 README 逐条承诺命令。裁掉等于砍能力入口（发布、trust 都有测试）；逐个承诺则每加一条命令都要改 README 并保证说明跟得上，而说明在格式稳定前一定会和代码对不上——README 自己的话：错的说明比没有说明更贵。

代价：README 那句分工不构成对任意命令的承诺，命令面每条都得有人核（`--help` 是唯一被测试盯着的出口）；对外解释得靠 `--help`，不能只看 README。
