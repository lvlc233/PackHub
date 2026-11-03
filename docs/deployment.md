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

## 十、下一步：先验证，再抽象

拿当前仓库当试验田，写 `dsh` 与 `claude-code` 两个投影，实际验证：

1. DSH 是否读项目级 skills / MCP；不读就退化成"指令块 + 指路"方案；
2. `.mcp.json` 写进去后 harness 是否真的加载；
3. 卸载后投影是否清干净。

验证结果决定投影怎么设计，比纸上推演可靠。
