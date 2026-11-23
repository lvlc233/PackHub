---
kind: concept
summary: 术语与边界（Pack / 资源 / 计划 / 宿主 / 安装目标 / 实例 / 隔离）
verified: 2026-11-22
decay: 365
review: 实例模型或安装流程改动后
---

# PackHub 概念

### Pack（整合包）

一份可复用的 Agent 能力整合：不是把 Agent 需要的东西放在一起就够，而是这些功能能作为一个有机的整体给出。

Pack 不是资源的压缩包，哪怕有依赖关系也不自动成为有机整体；作为 Pack，需要创作者调整包内所有资源的关系，并以特定体验给出。

一个包内包括：

1. 清单 `packhub.yaml`
2. 锁 `packhub.lock.json`
3. 随包资源与补丁文件
4. 说明与变更记录（`PACK.md` / `CHANGELOG.md`，可选）
5. 签名（旁挂 `packhub.signatures.json`，或在清单里，可选）

### Assembly（整合）

整合是 Pack 的创作过程：挑资源、决定接线、叠加覆盖与调校，最后用锁把引用钉死。

产物是作者目录里的 Pack 目录，不是 `.phub`。整合回答「装什么、怎么接、为什么这么改」；打包只把结果运出去，安装只在目标环境里执行。

### Resource（资源）

Pack 里的一条能力声明，它相对于 Agent，而不是相对于整个 harness。所以它可以是 SKILL、工具、脚本、提示词……只要能让 Agent 稳定表现出某种能力；界面优化这类不算。

资源提供或需要的能力写成令牌，见 Composition 词条。

### Source（来源）

来源是资源对内容的引用：指向内容所在的位置，并且能取回来。

可以指向包内文件、代码仓库、包管理器或 URL。

### Composition（能力接线）

接线是资源之间的约束：谁提供什么能力（`provides`）、谁需要什么能力（`needs`）。这是清单里唯一的接线关系：没有互斥组，也没有「这次只装其中一个实现」的选择。

能力写成令牌 `<form>/<name>@<major>`（`tool/repo-search@1`、`skill/doc-review@1`）。`form` 是闭集 `tool` / `skill` / `content` / `config`，表示能力被消费的形态——工具调用、技能、可读内容、配置——**不是资源类型**：`mcp` / `tool2` 通常给 `tool/*`，`skill` 给 `skill/*`，`prompt` / `knowledge` 给 `content/*`，`config` 给 `config/*`。名字只描述能做什么，不泄漏资源类型；`@` 后是接口主版本（不小于 1 的整数），主版本不同就是两种能力。

`needs` 同时是能力依赖和安装顺序：多个资源可以 `provides` 同一令牌（能力叠加），它们全部安装、不互斥；消费者的每个 `needs` 只要至少有一个 provider 就算满足。所有 provider 都排在消费者之前，成环报错。没有单独的 `dependsOn`。

没有 `composition` 块：接线由 `provides` / `needs` 承载，再声明一份等于第二真相。接线图在计划期从清单派生（kernel 的 `describeComposition`，`plan` 打印出来），不落盘。

### Manifest（清单）

清单是 Pack 的书面声明：有哪些资源、彼此怎么接、有哪些约束。它不声明装到哪个宿主——那属于安装参数，见 Harness 词条的安装目标段。

它是打包的重要依据。

### Lock（锁）

锁是清单的一次解析结果：把引用钉死，并记下「清单 + pinned 引用」的内容哈希（`contentHash`），确保打包时的资源与版本一致，避免上游变动把包的功能弄坏。

锁只描述内容：不含安装宿主，也不含任何计划。装到哪个宿主、计划长什么样，是安装 / 校验那一刻按 `--harness` 现算的（见下 Plan）。

### Packaging（打包）

打包把已经整合、锁定好的 Pack 目录收成一个可交付文件：让包离开作者工作目录后仍然完整，能装到别的 harness 上。

清单、锁和要随包带走的内容进同一个归档。它只负责把包送到；

打包不负责整合：不挑资源、不改接线、不做调校，也不生成安装计划。默认自包含；打包也不安装——产物交给 `pal install`（见 Install 词条）。

### Plan（计划）

计划是一次安装的动作安排：把 Pack 展开到某个落点上，列出要做哪些事、按什么顺序做。

计划是唯一描述副作用的东西，安装只是执行它。

计划是**按需现算**的产物：`planFor(ctx, { harness })` 在用到它的那一刻按宿主算（不传就是平铺目录）——`packhub plan` / `packhub verify`、`pal install` / `pal update`、launcher 建/更新实例与 publish 门禁里的 runner 都各算一份；同一个 Pack 装到不同宿主会得到不同的计划与 `planHash`。锁和内容哈希都不含计划。

### Install（安装）

安装把 Pack 落进一个目录的过程：项目目录或实例根。内容展开到文件，登记写进该目录的 `.packhub/state.json`。

安装由 `pal` 执行，`packhub` 不写用户目录。`pal install <来源>` 只有一个动词，作用域由 target 决定，三选一：`--into <目录> --harness <宿主>`（项目级，只写这个目录，不建实例记录）、`--instance <实例>`（实例级，装进已有实例根；要求实例已停且还是空实例）、`--new --kind <宿主> --name <名字>`（新建实例再装）。`uninstall` / `update` / `rollback` / `verify` 收同一组 target（`--into` / `--instance`）；实例的写操作（install / uninstall / update / rollback）要求已停，`verify` 允许运行。目录是项目级落点，实例是全局环境（home 与运行态都在实例上）；要一份能跑起来的环境用实例，目录形态的实例用 `pal adopt` 接管已有目录。

安装只发生在 target 里，不在别处发生；目录只是文件落点，实例的 home 与运行态在实例上（见 Launcher 词条）。

安装是事务性的：要么全部成功，要么按快照回到安装前，不留半套。

### State（状态）

状态记录这台机器上已经发生了什么：装了哪个包、改写了哪些文件、每个动作的结果。

回滚、卸载、升级清理、漂移检查都读它；它是「装了什么」的唯一真相。

### Harness（宿主）与安装目标

宿主是支持 Agent 运行的那一层，是整合包能够运行的底层。如果要比喻，就像 MC 的原版：不同的 harness 是不同实现或版本的 MC。

模型循环、工具执行、上下文、界面都在它那里。

`--harness` 只有两类：不写 = 平铺目录（中性落点，不属于任何宿主）；写 = 某个宿主名（`dsh` / `claude-code` / `codex` / `opencode` / `workbody` / `hermes`）。`dir` 不是可写的取值，它只是平铺目录那张落点表的名字。装到宿主上就是按那个宿主的落点表物化文件、指令与 MCP 写法。宿主可以声明自己的 MCP 方言（写哪个文件、条目挂在哪个键下面、什么格式、条目长什么样）；hermes 这类只有全局目录的宿主是 `project: false`——不能 `pal install --into`，只能 `pal install <pack> --new --kind hermes --name <名字>` 建实例再装。

它在 `pal install` 上是**安装参数**；`packhub plan` / `packhub verify` 只拿它算预览与检查计划，不产生安装。它不是 Pack 属性：不进锁、不进内容哈希，`pack` 与 `lock` 都不接受它；同一个 Pack 装到不同宿主，锁与签名不变，变的只是落点与计划（`planFor` 现算）。清单与资源也都不声明安装形态——旧清单带 `targets` 会被判 schema error。

宿主的全部知识在 kernel 的宿主注册表里：`kernel/src/harness/contract.ts` 定义 `HarnessSpec` 与查表 API，`dsh` / `claude-code` / `codex` / `opencode` / `workbody` / `hermes` 各自一个模块，在模块里 `registerHarness`——落点差异、实例 home 与环境变量、MCP 方言、可执行名与版本参数、凭据文件、指令文件名、启动模板与探针配方都在各自文件里；`harness/index.ts` import 一遍完成注册。加一个宿主 = 新建 `harness/<id>.ts` + 在 index 加一行 import，launcher / runtime / 探针都从注册表查，不用改。`HarnessId` 是运行期字符串：编译期穷尽性没有了，靠 `isHarnessId()` 与 schema 的 pattern 兜底；注册是 import 副作用，重复 id 或非法 id 直接抛错。注册表在代码里、不在用户数据里，第三方宿主仍不能自己加（见 decisions）。

`--harness` 只决定目录内的落点形态，不等于有了一份宿主环境：home、进程、端口都不在目录里，装完只得到一份文件；要跑起来用实例（见 Launcher 词条）。

启动器的实例形态用 `pal … --kind` 选：`install --new` 只接受宿主名（`dsh` / `claude-code` / `codex` / `opencode` / `workbody` / `hermes`）；目录形态的实例由 `pal adopt` 接管已有目录产生。`dir` 是实例形态（项目目录实例），属于 PAL，不是宿主；`instance.json` 仍记 `harness` 字段（值含 `dir`）。

### Adapter（适配）

适配是 Pack 与某个宿主之间的翻译：把通用声明换成那个宿主认得的说法。

它只回答这个 Pack 在它上面能落成什么样——落点表、指令文件、MCP 写法、技能元数据。

### Instance（实例）

实例是宿主被启动之后的那份运行体：一个实例根，加上跑起来的进程与端口。

它同时有三样东西：配置（用哪个 Pack、什么宿主、根与 home 在哪）、数据（home 下的 skills、知识、会话、凭据、缓存）、运行态（进程、端口、地址、最近一次退出）。三样分开存放，运行态不混进配置。

实例不是 Pack 的一份拷贝：同一个 Pack 可以建多个实例，各自装、各自跑；实例也可以完全脱离 Pack 存在（`pal adopt` 接管来的目录）。

### Instance Record（实例记录）

启动器对每个实例维护两份记录：`instance.json` 只存配置，`runtime.json` 只存运行态。

两者之和才是「一份实例」；缺运行态就算坏记录，坏记录会被隔离到 `.quarantine/`，不会静默消失。

### Isolation（隔离）

隔离描述实例的每一层是独有还是跟宿主共用，共五层：装配产物、会话、凭据、取包缓存、宿主运行时。

默认是装配 / 会话 / 凭据每实例一份，缓存 / 运行时共用。策略在**建实例那一刻**快照进记录，之后改全局默认不追溯已有实例。

### Launcher（启动器）

启动器（`pal`）管实例与安装 target。安装类命令 `install` / `uninstall` / `verify` / `rollback` / `update` 用 target 二选一：`--into <目录>`（项目级，只写这个目录）或 `--instance <实例>`（全局环境，写实例根）；`install` 另有 `--new --kind <宿主> --name <名字>`，新建实例再装（替代原来的 `create`）。实例的写操作（install / uninstall / update / rollback）要求实例已停，`verify` 允许运行；`--instance` 安装还要求实例是空的。`adopt` 接管已有目录，`adopt` 与 `install --new` 默认把新实例设为它宿主的当前实例；`use` 改当前、`current` 看当前，`start` 不写目标时用当前实例（多个宿主各有当前实例时要求显式指定）。`list` / `ps` 是纯读：`list` 把坏记录原样列出、不隔离；`ps` 默认只出账本（在跑、端口、运行时长、端口冲突、已死的 pid），加 `--refresh` 才按 pid 探测并写回记录。`health` 体检实例（`--hosts` 附带宿主发现），`audit` 看安装审计，`leftovers` 只读列出隔离区 / 失败现场 / 归档区（不移动、不删除）。列、复制、迁移、备份、删除实例与起停看护都在这里。实例是运行入口：要跑起来、要一份全局环境，都在实例上发生，不在目录里。

实现上分两层：常驻的 core 独占启停与看护（CLI 只是它的客户端），core 被杀了由用户任务计划带回来。

### Registry（仓库）

一个用来存 Pack、维护不同版本的目录树：以 Pack 为最基础的操作单元，提供发布与读取。

包版本发布后不可变，改动要发新版本。读端是只读接口，写端是发布流程。

