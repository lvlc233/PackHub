# PAL 实例启动器

PAL 把 Pack 装进一个独立实例根，并按宿主起停进程。代码在 `packages/launcher`（内核 + CLI + 本地界面），桌面壳在 `apps/pal-electron`（新）与 `apps/pal-desktop`（旧，待退役）。

## 三层边界

- **PackHub CLI**：管 Pack 的来源、锁与缓存，不碰实例。
- **PAL launcher（装配外壳）**：管实例根、装 Pack（调 `@packhub/kernel` / `@packhub/runtime` 的 `installPack`）、起停、看护、迁移、备份。
- **桌面壳**：只负责起 `pal serve` 并把窗口指过去，不读写实例文件；页面的 `/api/` 请求经 preload/forward 转给侧车。

本文不加限定的「外壳」指桌面壳。launcher 直接调 `runtime.installPack` 是装配层职责，不是越界：它依赖的仍是 kernel/runtime，不依赖任何宿主或桌面壳。

## 实例根长什么样

```text
<instancesRoot>/<id>/
  instance.json        实例记录（原子写）
  baseline.json        Pack 装过的文件 + sha256，以及 pack / version / planHash
  .packhub/            安装 state、快照、版本镜像
  home/dsh/            dsh 的 DSH_HOME（skills、knowledge、cordis 配置）
  home/claude/         claude-code 的 CLAUDE_CONFIG_DIR
  home/codex/          codex 的 CODEX_HOME
  logs/start.log       本次运行输出（脱敏后读）
  logs/start.<时间>.log  上一次运行
  logs/events.jsonl    启停/退出/接线事件
  secrets.json         地址里的凭据（0600，不进 API、不进日志）
  .pal-stopping        正在停止的标记（写 pid + 时间，60s TTL，停止结束即清）
```

`<instancesRoot>` 默认 `~/.packhub/instances`，可用 `PACKHUB_INSTANCES` 覆盖；取包缓存在 `<PACKHUB_HOME>/cache/packs/<来源>/<版本>`。只有「registry 来源 + 明确版本」会命中缓存：目录里已有同版本、清单版本也对得上就直接复用，不 reset 不重取；`latest`、`*`、`^1.2` 这类会变的版本，以及 `.phub` / `git+`（上游可能换内容）仍每次重取。

新建实例的 home 是空的：宿主起来也没有模型可用。两条路把已有环境接过来 —— `pal create --from-home ~/.dsh`（只补空缺地复制凭据与用户指令，Pack 写好的文件不被覆盖；`sessions`、`cache`、`attachments`、`dsh-runtimes`、`storages`、`profiles`、`logs` 不搬），或 `pal adopt`（直接接管整个已有目录，一个字节不动）。

## 隔离策略

记录里的 `isolation` 描述五层各自怎么放：`assembly`（Pack 装出来的文件）、`session`（会话/缓存）、`credentials`（凭据）、`cache`（取包缓存）、`runtime`（宿主运行时）。每层两种模式：`instance`（这个实例独有）或 `shared`（跟宿主共用）。默认值见 `isolation.ts`：`assembly`/`session`/`credentials` 为 `instance`，`cache`/`runtime` 为 `shared`。

默认策略存在 `<PACKHUB_HOME>/config.json` 的 `isolation`；`pal create --isolation assembly=shared,session=instance` 可显式覆盖，`pal config` 可看/改默认。策略在**建实例那一刻**快照进记录，之后改全局默认不追溯已有实例；`pal adopt` 也按当时的默认值记一份。旧记录与坏策略值回落默认。凭据只支持 copy（每实例一份，建实例时从已有 home 复制）；shared-ro 未实现，策略里写 `credentials=shared` 会在写任何东西之前被拒绝（`invalid-input`，提示改回 `credentials=instance`）；`keepData` 归档与备份默认剥离 `secrets.json`，宿主凭据文件（`ADAPTERS.credentialFiles`：dsh 的 `.credentials.yaml` / `auth.json`，claude-code 的 `auth.json` / `.credentials.json`，codex 的 `auth.json`）按同一份清单剥离，只匹配适配器 home 段内的路径；备份要带凭据得显式 `--include-secrets`。

改 `<PACKHUB_HOME>/config.json` 的默认只影响之后新建的实例：已有实例保持创建时那份快照，改默认不动它，也没有原地迁移工具。要换策略就 `pal create --isolation` 新建；`pal clone` 沿用源实例的策略，换不了策略。这是有意取舍，不是功能缺口：按新策略重排一个装好、可能正在跑的 home，要么挪丢文件，要么在不可知的时刻半途失败，而换一次策略的代价本来就只是新建一次实例；`pal migrate` 仍只负责挪根，不碰 home 布局。写默认值时也会先校验：`credentials=shared` 这类未实现的值直接 `invalid-input`，不落盘、不改原文件，`pal config` 设置那一刻就拦住，不必等到 `pal create`。

## 记录与状态
`instance.json` 的字段：`id`、`name`、`harness`、`harnessVersion`、`root`、`home`、`pack{name,version,ref}`、`status`、`managed`、`origin`、`isolation`、`pid`、`port`、`ports[]`、`url`（已摘凭据）、`startedAt`、`lastExit{code,signal,at,restarts}`、`lastError`、`restart`。类型上分 `InstanceConfig`（身份与配置）与 `RuntimeState`（`status`/`pid`/`port`/`ports`/`url`/`startedAt`/`lastExit`/`lastError`），`InstanceRecord` 是两者之和；`records.ts` 的 `partitionRecord` / `mergeRecord` 负责拆分与合回。持久化仍是同一个 `instance.json`（兼容旧记录），后续如需拆文件再迁移。`planHash` 只记在 `baseline.json`：`update` 用它判断计划有没有变，没有 baseline 视为已变；旧记录里残留的 `planHash` 读取时忽略、不再写回。

`pack{name,version}` 不另立事实：`create` / `update` 装完后、`adopt` 写记录前都走 `packIdentityFromState`，按 `.packhub/state.json` 里**恰好一个** Pack 的名字版本写回（旧 state 没写 version 时用清单值或 `0.0.0`）；0 个 / 多个 Pack、state 读不出来时退回清单值（`adopt` 是 `external`@`0.0.0`）。记录漂移会在下一次 `update` 被纠正，`pack.ref` 仍记原始引用。

状态：`installing` → `installed` → `running` / `stopped`；进程死了是 `broken`，安装失败是 `failed`。建实例时先写 `installing` 再装，所以中途崩溃也能在列表里看到它、能删能查。`pal status` 会把 pid 已死的实例真正写成 `broken`（收回 pid/port/url）；GET 列表与体检只在返回值里标，不改记录。

`origin.kind` 说明记录从哪来：`pack`（按引用可从 Pack 重建）、`adopted`（接管的目录）、`copy`（复制自另一份实例，`from` 记源 id）。只有 `pack` 且带 `ref` 的实例导出的模板可复现，`adopted` / `copy` 导出时标 `reproducible: false`，`pal import` 会拒绝。

`managed: false` 表示这是 `pal adopt` 接管的目录：删除时先停掉在跑的进程，然后只摘记录 —— 不调 `removePack`、不搬目录（`--keep-data` 也不搬），只删 `instance.json` 与 `baseline.json`、摘 `.links` 指针、清 active；CLI 的确认与结果文案按 `managed` 分支。

## 危险动作怎么保护

- **建实例失败**：只清理自己造的根。复用已有目录时不删目录，只摘 `instance.json`；自己造的根移进 `instances/.failed/` 并写 `reason.json`。
- **删除**：先停进程并等它真的退出，再删根（默认既不先卸包，也不搬目录；包记录只用来填结果里的 `uninstalled`）。`--keep-data` 才先按 state 卸包、再把根挪进 `instances/.archive/`。删目录会重试，仍被占用就改名进归档；删根失败时记录与 state 都原样留着，可以直接重试。默认删除不逐文件调 `removePack`：当前安装落点都在实例根内，删根即清干净；以后若写入宿主级副作用（全局 MCP 注册、宿主配置键），必须在这里补反向清理，不能只靠删根。
- **停止标记**：`stopInstance` 与 `removeInstance` 都在 kill 之前写 `<root>/.pal-stopping`（pid + 时间，60s TTL），结束时清掉。`pal serve` 的 onExit 有三道闸：标记与 pid 对得上、记录里的 pid 已经换人、记录已是 `stopped` —— 任一成立都不按崩溃处理，也不触发 `on-failure` 重起。
- **迁移**：rename 与写记录在同一把实例锁里做完，写完必须能从新根读回记录；失败就把目录挪回原路径、记录改回旧 `root`，回滚也失败才报 `internal`。
- **坏记录**：`instance.json` 解析失败不再静默跳过 —— `pal list` / `pal status` 会把它移进 `instances/.quarantine/` 并写原因（接管实例只收走 `.links` 指针，目录不动），`pal recover` 能看。读接口（GET `/api/instances`、体检）只把问题列进 `broken`，不写记录、也不隔离。
- **原子写**：临时文件 + rename，崩在写记录中途不会留半份 JSON。
- **实例锁**：`<root>/.pal-lock.json` 记 pid/操作；持有者已经不在就当陈旧锁清掉。
- **凭据**：启动输出里的 `token` 等查询参数摘进 `secrets.json`（0600）；记录、API、界面只见脱敏地址；「打开」走 `/api/instances/:id/open` 的 302，页面拿不到 token。

## 启动与看护

1. 读记录 → 宿主能不能起（`dir` / `claude-code` / `codex` 明确报“没有常驻服务”，附原因）。
2. 上一轮的 pid 已死 → 先标 `broken` 再继续（启动前自愈）。
3. 找宿主可执行文件并探测版本（Windows 的 `.cmd` 垫片按 `/d /s /c ""…""` 引号规则跑，先认 PATHEXT 再认无扩展名壳）。
4. 选端口：显式指定被占时报告占用者（pid + 进程名）；否则沿用上次端口，再不行让系统挑。
5. dsh 实例：把 Pack 的 mcp 资源写成 `home/dsh/pal-mcp.patch.yml`，用 `--patch` 传给宿主（见下）。
6. spawn 不走 shell 拼串：日志用 `stdio` 的 fd 直接写，`cwd` 是实例根，home 走宿主自己的环境变量。环境也不整份继承：`hostEnv` 只留 PATH/PATHEXT、SystemRoot 等系统项、TEMP、home 与语言变量，代理按原名带上；名字命中 `API_KEY`/`TOKEN`/`SECRET`/`PASSWORD`/`CREDENTIAL` 的、`PACKHUB_*`、`PAL_*` 以及各模型厂商前缀的一律剔除。要额外给，用 `opts.env` 显式补 —— 它最后应用，能覆盖先前的值（包括被剔除的项）。
7. 从日志里等地址；等不到就收掉进程，并把日志尾部贴进错误里。
8. pid 记**真正在监听**的那个（Windows 上 `.cmd` 垫片的 spawn pid 是 cmd 的，靠端口反查）。
9. `pal serve` 期间会记退出码/信号到 `lastExit`；`restart: on-failure` 的实例按 1s/2s/4s… 退避重起，超过 `maxRestarts` 停止。

## dsh 的 MCP 接线

Pack 里的 `type: mcp` 资源安装时写进实例的 `.packhub/config.json`（`mcpServers`）。PAL 在启动前把这份清单转成 dsh 的 patch 层：

```yaml
- insert:
    - id: pal-mcp-markdownlint
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: "markdownlint"
        transport: stdio
        command: "npx"
        args: ["-y", "@dougis/markdown-lint-mcp@1.0.5"]
```

`serverName` 只保留 `[A-Za-z0-9_-]`，超过 32 字符截断加短哈希。换到没有 MCP 的 Pack 时旧 patch 会被删掉，不会继续生效。不写宿主的 profile 文件，也不改全局 DSH home。

## 错误语义

失败一律是 `PalError`，带稳定 code、提示与细节；HTTP 状态由 code 决定：

| code | HTTP | 什么时候 |
|---|---|---|
| `invalid-input` | 400 | 缺字段、模板不可复现、参数不合法 |
| `unknown-harness` | 400 | 宿主名不认识（附可选值） |
| `unknown-instance` / `not-found` | 404 | 找不到实例或文件 |
| `name-taken` / `root-occupied` / `already-running` / `not-running` / `busy` / `port-in-use` | 409 | 冲突类 |
| `not-startable` / `harness-missing` / `install-failed` / `start-failed` / `record-corrupt` | 422 | 宿主起不来、安装失败，或记录写下了却读不回来 |
| `forbidden` | 403 | 跨源写请求、缺客户端头、外部页面触发打开 |
| `internal` | 500 | 兜底 |

## HTTP 面

只绑回环。写请求要求 `host` 与 `Origin` 一致且带 `x-pal-client: pal-ui`（跨源表单发不出来）。

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/api/meta` | 版本与界面目录 |
| GET | `/api/harnesses` | 宿主发现：可用性、版本、能不能起（`?probe=0` 跳过版本探测） |
| GET | `/api/instances` | `{instances, broken, active}`；纯视图，不写 `instance.json`、不隔离坏记录 |
| POST | `/api/instances` | 建实例（`pack`/`name`/`harness`/`version`/`index`） |
| GET | `/api/instances/:id` | 单份记录 |
| POST | `/api/instances/:id/start` / `stop` / `restart` / `active` | 启停、重起、设为当前 |
| GET | `/api/instances/:id/logs` | 日志（`?file=` 看归档），带事件流 |
| GET | `/api/instances/:id/health` | 体检报告 |
| GET | `/api/instances/:id/open` | 302 到带凭据的地址 |
| DELETE | `/api/instances/:id` | 删除（`?keepData=1` 保留数据） |
| GET | `/api/packs` | registry 索引的包与版本 + 本地 Pack 目录 |

## 界面

`web/app.js` 只做增量更新：列表按 id 复用节点、详情按字段赋值，轮询（2.5s）在页面隐藏、有对话框打开或有操作在跑时暂停 —— 刷新不会打断输入、选中和展开态。宿主版本只在首轮探测一次，之后轮询不再 spawn 宿主。

创建对话框从索引拉包与版本（也可手填目录/`.phub`/`git+https`），选宿主时显示是否安装、能不能起；详情页有更新提示（索引 latest ≠ 已装版本）、体检面板、删除时「保留数据」勾选。

## 命令

`pal create / list / show / remove / start / stop / restart / status / health / doctor / logs / use / current / serve / adopt / clone / rename / migrate / update / rebaseline / export / import / recover`。

`start` 会立刻退出（宿主 detach）；要看着护就用 `pal serve`。「实例流转」目前只有 CLI。

`adopt` 只有实例 state 里恰好 1 个 Pack 时才记下它的名字/版本；0 个或多个一律记 `external`，免得记录谎称身份。`planHash` 不进记录，只在 `baseline.json` 里维护。`clone` 复制出来的记录是 `managed: true`、`origin: {kind:'copy', from}`，端口与运行信息清空 —— 它是拷贝，不从 Pack 重建，导出的模板不可复现。

`show` / `rename` / `migrate` / `use` 也认 `--json`（`show` 本来只输出记录 JSON）；`current --json` 同样只输出一份 JSON。

`update` 要求实例已停。计划确实会变（`changed`）且 Pack 写过的文件被本地改过时默认拒绝，一个文件都不写；确认覆盖要带 `--force`（API 是 `body.force=true`）。同版本重跑不写盘、也不拦。放行后装上新版本，把上一版独有的文件删掉（删不掉就留着），刷新基线与记录，并回报这次被覆盖的本地改动。
`rebaseline` 把当前磁盘状态认作基线：本地改动被接受，体检不再报漂移；`baseline.json` 里的 `planHash` 与 `ignore` 原样保留。

## CI

`.github/workflows/pal.yml`：Ubuntu 跑 `pnpm check`（含 PAL 内核测试）+ `pal:bundle`（esbuild 单文件）+ `pal:smoke`（起服务 → 建实例 → 体检 → 删）；Windows 跑全量测试 + `build:pal-desktop` + `Pal.exe --smoke` + 用分发里的 `runtime/node.exe` 跑 `pal.cjs doctor`。

## 缺口

- 看护只在 `pal serve` 活着时生效，壳退出后没有系统级守护。
- `adopt` / `clone` / `migrate` 没有界面入口（`update` / `rebaseline` 前者的界面入口是详情页的「更新」按钮，后者只有 CLI）。
- 没有运行时版本管理；跨盘迁移要手动搬。
- `update` 的强制放行只有 CLI 的 `--force` 和 API 的 `body.force`：界面没有强制更新入口，改过本地文件的实例只能走 CLI `--force` 覆盖，界面上点「更新」只会报错。
- 计数与耗时这类性能数字只在本机测过，没有进 CI 基线。

这些缺口与后续工作的编号、证据和顺序见 [PAL 审计待办](../PAL-审计待办.md)。
