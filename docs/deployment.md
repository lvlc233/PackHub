# 部署、接入与同步

## 一、先分清「服务器」指谁

之前笼统说"服务器"，实际上是四种机器，职责完全不同：

| 角色 | 是什么 | 装什么 | 谁维护 | 暴露面 |
|---|---|---|---|---|
| **Hub** | `packhub serve` 那台机器/容器 | 索引、打包台、版本与审计；**不执行、不装包** | 部署者 | 可公网 |
| **资源主机** | GitLab / Gitea / npm / 内网对象存储 | 真正的字节 | 原作者或公司 | 各自鉴权 |
| **目标机器** | 跑 agent 的那台：开发机、公司服务器、CI 容器 | 被装的 skills / config / knowledge | 使用方 | 内网/本机 |
| **Runner** | 一次性容器 | 跑 install + verify，产出 `verify.json` | 部署者 | 短生命 |

**自动同步发生在「目标机器」，不在 Hub。** Hub 只发布，不知道谁装没装；目标机器按自己的节奏拉，必要时上报结果。

## 二、同步：pull，不是 push

```
目标机器上的 agent（常驻）
  每 N 分钟 / 收到 webhook：
    1. 拉指定 registry 的 index（带自己的 token）
    2. 比对本地 state.planHash ↔ 远端版本
    3. 有差异 → 取 manifest + lock → 本地生成 plan
    4. 装到新版本目录（staging），不覆盖正在跑的版本
    5. 在 staging 里跑 verify
    6. 通过 → 切激活指针；不通过 → 保留旧版并告警
    7. 上报：当前版本、planHash、verify 结果、时间
```

四条约束：

1. **不接受远端下发的命令。** 让客户端把"去装什么"推到目标机器，等于开了远程 shell；服务器自己决定拉什么、何时装。
2. **staged apply + 激活指针。** 装到 `.packhub/versions/<version>/`，切换指针生效。现在的 `install` 是原地写，回滚不了。
3. **幂等靠 planHash。** 相同 hash 就是 noop：不写盘、不重启、不告警，所以轮询可以高频。
4. **上报是数据，不是指令。** 目标机器只上报状态，不接受"去执行"。

## 三、三层标识

```
<deployment>/<group>/<pack>@<version>
例：corp/prod/learning@1.2.0
```

- `deployment`：哪个 Hub（公司 / 个人 / 公用）
- `group`：环境或项目（prod / staging / 项目 A）
- `pack@version`：具体产物

不要用扁平包名：同一个包在不同环境要不同版本，同一个部署内不同团队要互相隔离。

## 四、按项目安装（project-scoped）

**项目是天然的隔离边界与版本边界**：同一台机器上项目 A 用 1.1、项目 B 用 1.2，不冲突；"不被别的东西干扰"也只有项目级能干净做到。

```
<project>/
├── packhub.yaml              ← 提交进版本库
├── packhub.lock.json         ← 提交
├── .packhub/                 ← 规范层（不进版本库）
│   ├── versions/<ver>/       ← staged 产物，可回滚
│   ├── state.json            ← 装了什么、投影到哪、路径所有权
│   └── cache/
└── （投影层，由 adapter 生成）
    ├── .claude/skills/<id>   → 指回 .packhub/versions/<ver>/skills/<id>
    ├── .mcp.json             → 只有这个包声明的 servers
    └── AGENTS.md / CLAUDE.md → 托管块（带 begin/end 标记）
```

**规范层是唯一真相，投影层是生成的。** 换 harness 只换 adapter，不动包；卸载按 state 删投影，不靠猜。

## 五、接入 agent：投影 + 指令面

接入拆成两个问题：

| 问题 | 内容 | 谁决定 |
|---|---|---|
| 投影 | 内容放到 harness 会读的位置和格式 | 每个 harness 一个 adapter |
| 指令面 | 让 agent 知道有哪些能力、何时用 | 一份可托管更新的指令块 |

| harness | skills | MCP | 指令 |
|---|---|---|---|
| Claude Code | `.claude/skills/<id>/` ✅ 已实装 | `.mcp.json`（项目级）✅ 已实装 | `CLAUDE.md` 托管块 ✅ 已实装 |
| Cursor | 无原生 skills | `.cursor/mcp.json` | `.cursor/rules/*.mdc` |
| DSH | 目前看是 `~/.dsh/skills`（**项目级是否支持待验证**） | profile 里的 MCP 条目（**项目级待验证**） | 项目 `AGENTS.md` 托管块（✅ 会写；DSH 是否读待验） |
| 通用 | 无 | `.mcp.json` | `AGENTS.md` 托管块 |

三个坑：

1. **Windows 不假设符号链接**（要管理员或开发者模式）。投影默认拷贝 + state 登记，`--link` 作为可选。
2. **指令文件是共享的**，必须用带标记的托管块，只改块内，反复安装不产生第二个块。
3. **跨包冲突**：现在的 `output-conflict` 只在一个包内查。项目里装两个包、都投影到 `.mcp.json` 时，需要项目级所有权表（state 里记 路径 → 包），后装冲突要报错。

## 六、隔离能到什么程度（诚实边界）

- `.mcp.json` 这类项目级配置通常与全局**合并**，不是替换。所以能做到"这个包声明的 MCP 会出现"，做不到"别的 MCP 不出现"。
- 真正的"只有这些工具"依赖 harness 自身机制（白名单/router）。**isolation 是 adapter 的能力，不是清单能承诺的。**
- 因此 verify 里只写能验的：「工具表里出现了这 3 个」能验；「没出现别的」多数环境验不了。

## 七、core / runtime / hub 的边界

| 组件 | 放什么 | 不放什么 |
|---|---|---|
| **packhub-core** | 解析、能力图、plan、lock、planHash、diff、探针**定义**、签名校验算法、`.phub` 格式规则、存储**端口** | 网络、写盘、任何"DSH 配置在哪" |
| **client runtime** | 下载与完整性、install/apply/uninstall、dir/dsh/claude-code 投影、MCP 探活、凭证解析 | 不定义格式、不做解析判断 |
| **hub** | HTTP + 打包台、版本与存储、索引、签名记录、审计；**不执行** | 不写登录、不做用户体系、不跑别人的代码 |
| **hub-runtime**（现在不做，接口预留） | ① runner：一次性容器里跑 install+verify；② agent：常驻目标机器做同步与装载 | 不暴露到公网 |

Hub **不内置 runner**：验证交给一次性容器（CI 或临时 job），Hub 只消费 `verify.json`。理由：Hub 面向公网，不能执行别人写的 `exec` 与脚本。

## 八、参考 Nacos 的四点（只借模型）

| Nacos | 对应 | 借什么 |
|---|---|---|
| namespace → group → dataId | deployment → group → pack@version | 别用扁平包名 |
| 变更通知 + 客户端拉内容 | index 的 ETag/版本号 | 通知与内容分离；0.x 用 HTTP 轮询就够，不需要长连接 |
| 客户端本地快照 + failover | 保留上一份 manifest/lock 与上一个激活版本 | 拉不到就继续跑旧版 |
| 灰度 / β | 按目标机器标签选版本 | 一台先试，再全量 |

不照搬：Nacos 管配置文本，我们管产物（tarball/目录/二进制），所以必须有内容寻址（integrity）+ 版本目录 + 激活指针；Nacos 的服务发现与我们无关，不要带进来。

## 九、当前缺口（按依赖顺序）

1. `diff / update`：没有计划差异，就做不了增量同步。
2. 版本目录 + 激活指针 + 回滚：现在的 install 原地写。
3. 并发锁：两个进程同时装同一目录会互相踩（`.packhub/lock`）。
4. 投影 adapter：`claude-code` 与 `dsh` 各一套落点映射。
5. 项目级所有权表：跨包冲突检测。
6. `unlisted` 档位：可见性目前是 public / internal / private，缺"不进索引但可凭名称安装"。

## 九点五、公开页（已实装）

`/packs` 列表与 `/packs/<scope>/<name>` 详情页，只读 `registry/index.json` 与版本目录里的 manifest / lock / verify.json；`/api/registry` 与 `/api/registry/pack` 是它们的唯一数据源。页面上只给命令，不给在线安装。

## 九点五、创作台（已实装）

`/console`：左边列出 registry 里的包可作底稿，中间改 `packhub.yaml`，右边点「预览计划」由服务端内核算问题与动作（`POST /api/plan`，只读、不落盘、不联网）。草稿存在 localStorage，可下载成 `packhub.yaml`。

它只做"写清单 + 看计划"，不做在线安装——安装永远在用户机器上。

## 九点六、DSH 与 Claude Code 的实测方法（待执行）

投影写出来了，但"harness 真的会读"还没验。验法要固定，不然每次都是猜：

### 探针命令（封装好了，不用手工问）

```bash
packhub probe <项目目录> --target dsh          # 调用 dsh --profile headless，问一句，看回答里有没有包的标记
packhub probe <项目目录> --target claude-code  # 调用 claude -p，带 --max-budget-usd 0.05 限额
```

它做的事：从 `AGENTS.md` / `CLAUDE.md` 的托管块里取一个标记（块内第一行的标题），让 harness 复述块内第一行，回答里出现标记才算通过。缺凭证、没登录、没装包都会给出具体原因。

**DSH 的 headless 入口需要 `DEEPSEEK_API_KEY` 在环境变量里**（桌面应用里存的加密凭证 headless 读不到）。没有它时探针会直接报「缺少凭证」，不会假装通过。

已验证的：Claude Code 的 MCP 投影。

已验（2026-11-03）：

```
$ packhub install ./demo --target claude-code
$ claude mcp list
local-files: npx -y @modelcontextprotocol/server-filesystem@2025.1.14 . - ✓ Connected
```

Claude Code 读到了项目里的 `.mcp.json`，并且把声明的 server 连上了——**MCP 投影这条链是真的**。

未验：`CLAUDE.md` 托管块会不会被模型读进上下文、`.claude/skills` 这个落点 Claude Code 认不认。这两条都要真跑一次模型（`claude -p`），会花账号额度，所以留着由人决定什么时候跑。

验法：装包后 `claude -p "这个项目装了哪些能力？"`，回答里出现托管块内容 = 指令面生效；再 `packhub uninstall`，重复一次，能力应该消失。

**DSH**

已验（2026-11-03）：`packhub probe <dir> --target dsh` 调用 `dsh --profile headless`，让 agent 复述 `AGENTS.md` 托管块的第一行，回答里出现了标记：

```
✓ harness 读到了托管块
  回答：这个项目装了一个整合包：**探针验证包**（0.0.1）。
```

**结论：DSH 会读项目级 `AGENTS.md`，`--target dsh` 的指令面成立。** 卸载后同一个探针报「AGENTS.md 不存在」，说明清理也是干净的。

仍成立的限制：DSH 的 skills 与 MCP 条目挂在 profile（全局），项目级只做"物化 + 指路"。要在项目里真正拿到 MCP，得改 profile 或让 DSH 支持项目级配置——这一条没变。

跑探针的两个前提（本机实测）：

```powershell
$env:OPENCODE_API_KEY = "<oc_sk_...>"
packhub probe <项目> --target dsh --patch scripts/dsh-headless-opencode.yml
```

没有 `--patch` 时 headless 走默认的 `deepseek-official` 路由，会报余额不足；patch 文件把 provider 换成 `opencode-go`（就是桌面端在用的转发）。

**OpenCode**

已验（2026-11-03）：`packhub probe <dir> --target opencode` 调用 `opencode run --model opencode-go/deepseek-v4.1-flash`，回答里出现托管块标记，且它的日志里自己写着 `Read AGENTS.md`。

所以 **AGENTS.md 这条约定不是 DSH 特有的**：DSH（headless）、OpenCode 都读。项目里放 `AGENTS.md` 是跨 harness 可移植的。

**Codex**

已验（2026-11-04）：用原生账号、不换 provider，模型指定 `gpt-5.6-sol`：

```
$ packhub probe <dir> --target codex
✓ harness 读到了托管块
  命令：codex exec --skip-git-repo-check --sandbox read-only -m gpt-5.6-sol "<question>"
  回答：这个项目装了一个整合包：**Codex 验证包**（0.0.1）。
```

两个坑记一下：

- 本机 `~/.codex/config.toml` 里写着 `model = "gpt-6.1-sol"`，这个 id 该账号不支持（`model_not_found`），要显式 `-m gpt-5.6-sol`。
- 不要把 Codex 的 provider 换成 opencode-go：它只支持 `wire_api = "responses"`，打 `/zen/v1/responses` 是 402，走原生账号才对。

**Claude Code**：没有可用账号，`CLAUDE.md` 这一面未验证；MCP 那一面已验（`claude mcp list` 显示 ✓ Connected）。用户明确表示不使用 CC，这一面按"环境不具备"记录。

## 九点七、和宿主自己的指令文件共存

宿主（Claude Code / DSH / OpenCode / Codex）自己也读 `CLAUDE.md` / `AGENTS.md`，项目里通常已经有用户或别的工具写的内容。PackHub 只做一件事：**在文件里放一个带标记的块，只改块内，永不整文件覆盖。**

```
用户的规则……
<!-- packhub:begin lvlc233/team-conventions -->
这个项目装了一个整合包：……
<!-- packhub:end lvlc233/team-conventions -->
```

现在的保证（都有测试）：

1. 块外内容一个字不动；重复安装只替换自己那块；多个包各占一个块（块 id 是包名）。
2. 卸载只摘自己的块；摘完文件空了才删文件。
3. 安装前会把指令文件快照进 generation，`packhub rollback` 能恢复被改之前的内容。

真实风险与对策：

| 风险 | 现状 |
|---|---|
| 宿主工具重新生成整个文件，把我们的块吃掉（静默失效） | `packhub doctor` 检测：块不见了会点名文件与包，退出码非零 |
| 我们的块在文件末尾，语义上可能压过用户前面的规则 | 块内容只写"装了什么、文件在哪"，不写"你必须…"；真要更强约束应写进 Pack 的知识文件，由 agent 主动读 |
| 两个包抢同一份指令文件 | 块 id 不同，互不覆盖；卸载互不影响 |
| 用户手改了块内内容 | 卸载时整块删除（块是原子单元），这一点写在这里，不假装能合并 |

```bash
packhub doctor my-pack      # 文件还在不在、托管块还在不在
```

后续可选的更保守方案：宿主若支持 `@import`（Claude Code 的 CLAUDE.md 支持），可以只在宿主文件里写一行导入，正文放 `.packhub/PACKHUB.md`——宿主文件零污染，但依赖各家对 import 的支持，未验证前不做默认。

## 九点四、客户端怎么装

仓库里有两个可交付入口，各自有 bin：

| 入口 | bin | 用途 |
|---|---|---|
| `apps/local` | `packhub` | 本机命令：plan / install / add / update / publish / probe / serve … |
| `packages/hub` | `packhub-hub` | 只读发布端（fail-closed 鉴权） |

**单文件分发**（npx 用这个）：

```bash
pnpm build:local        # esbuild 打成 dist/local/packhub.mjs（含 yaml/ajv/tar/undici，schema 也打进去）
pnpm pack:local         # 再 npm pack，出 dist/local/packhub-<version>.tgz
npm install ./dist/local/packhub-0.0.1.tgz   # 或 npx ./packhub-0.0.1.tgz
```

实测：装进空项目后 `node node_modules/packhub/packhub.mjs plan <pack>` 能直接出计划，不需要仓库里的 `schema/` 或 workspace 链接。

**为什么单独打一份**：`apps/local` 依赖 workspace 包（`workspace:*`），直接 `npm pack` 装不了；bundle 之后只有一个文件加一个 `package.json`，npx 才能用。

## 九点七三、发布流程：`packhub publish`

发布不是"把文件丢进目录"，而是一串必须全过的检查：

```bash
packhub publish my-pack                       # 默认写 ./registry
packhub publish my-pack --registry ./registry --dry-run
packhub publish my-pack --out .tmp/pr         # PR 模式：只产出要提交的部分
```

1. 清单必须零错误；
2. **runner 在干净目录里装一遍并校验**，不过就拒绝发布（装不上的包进不了 registry）；
3. 版本目录已存在就拒绝（已发布版本不可变），`--force` 才覆盖；
4. 写 `packhub.yaml` / `packhub.lock.json`（按当前计划重算）/ `verify.json` / `<version>.phub`（vendored）；
5. 重生成 `index.json`，门禁（visibility、锁一致、不可变、verify 与计划一致）不过就不写。

PR 模式把同样结构写到 `--out` 目录，提交成 PR 即可，不碰主 registry。

## 九点七五、发布门禁：runner

`packages/runner` 是"这个包在别人机器上装得起来吗"的唯一执行者：复制到临时目录 → 清掉 `.packhub` → install → verify → 出 `verify.json`。registry CI 与本地发布共用同一段代码：

```bash
packhub run my-pack                 # 干净目录里跑一遍，报告默认写 <dir>/verify.json
packhub run my-pack --out /tmp/r.json
```

- 包目录本身不会被安装污染（报告之外的写入都在临时目录里，跑完删掉）。
- 清单有错直接抛错、不安装；校验不过返回非零退出码。
- `scripts/registry/verify-pack.mjs` 只是它的薄壳，CI 走同一条路。

## 九点八、Hub 的部署与运维

`packhub hub` 是只读发布端，默认绑回环。对外服务必须显式给鉴权，否则**启动即失败**（fail-closed）：

```bash
# 静态 token（客户端带 Authorization: Bearer <token> 或 x-packhub-token）
PACKHUB_HUB_TOKEN=xxx packhub hub . --host 0.0.0.0 --port 8788

# 反向代理已经做过 SSO：信任它注入的身份头
packhub hub . --host 0.0.0.0 --user-header x-forwarded-user

# 审计与限流
packhub hub . --host 0.0.0.0 --token xxx --audit logs/audit.jsonl --rpm 120
```

| 能力 | 行为 |
|---|---|
| 鉴权 | 配了 token / user-header 就校验；`/api/health` 不需要鉴权 |
| 限流 | 每 IP 每分钟上限（默认 240，`--rpm 0` 关闭），超了 429 + `retry-after` |
| 健康检查 | `GET /api/health` → `{ ok, packs, uptimeSeconds }` |
| 审计 | 每次请求一行 JSON：时间、IP、用户、方法、路径、状态 |
| 日志 | 启动与关键事件走 stdout JSON，交给外部收集 |
| 优雅退出 | SIGINT/SIGTERM 先停监听，在途请求完成后退出；5 秒兜底 |
| 镜像 | 根目录 `Dockerfile`，只装只读端，`CMD` 即 `packhub hub` |

**这里刻意没有的东西**：install、verify、发布、写文件的接口。Hub 只回答"有什么包"，装不装发生在目标机器上。

## 十、下一步：先验证，再抽象

拿当前仓库当试验田，写 `dsh` 与 `claude-code` 两个投影，实际验证：

1. DSH 是否读项目级 skills / MCP；不读就退化成"指令块 + 指路"方案；
2. `.mcp.json` 写进去后 harness 是否真的加载；
3. 卸载后投影是否清干净。

验证结果决定投影怎么设计，比纸上推演可靠。
