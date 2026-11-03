# 自动打包：从「已经跑通的环境」反推整合包

## 一、产品中心应该在哪

之前几轮我们把中心放在「作者写 `packhub.yaml`」。但真正值钱的是另一件事：

> 某台机器上的 Agent 环境已经能干活了（MCP 配好了、skill 装好了、提示词调好了）。
> 把这套东西自动变成一个整包，换一台机器/一台服务器，装完就是同一套能力。

所以主路径是 **采集 → 打包 → 分发 → 部署**，手写 YAML 是采集结果的**修补**手段，不是入口。

```
① 采集   扫本机 / 扫服务器 → 发现 MCP、skill、prompt、knowledge、config
② 打包   归一成 manifest + vendored 资源 + lock + verify 报告 → .phub 归档
③ 分发   registry（静态索引）+ 包页 + 一行安装
④ 部署   装回本机目录 / SSH 到服务器 / 交给容器
```

现有资产能用在中后段：`manifest → plan → apply → verify`、registry、verify 报告都已经跑通。缺的是 ① 采集 和 ④ 的远程形态。

## 二、采集要采什么

采集的难点不是读文件，而是**判断什么是「这套环境之所以能干活」的部分**。

| 采什么 | 从哪来 | 归一成什么 |
|---|---|---|
| MCP Server 定义 | 目标环境的 MCP 配置（DSH / Claude / 自建） | `type: mcp` + transport + command/args/env |
| Skill 目录 | 目标环境的 skills 目录 | `type: skill`，vendored 进包 |
| 提示词 / 角色 | prompts 目录、`CLAUDE.md`、规则文件 | `type: prompt` |
| 知识 / 规范 | 项目内文档、约定的知识目录 | `type: knowledge` |
| 配置片段 | 目标环境的 config、`.env` 模板、editorconfig | `type: config` |
| 工具 / 脚本 | PATH 里被引用到的 CLI、项目脚本 | `type: tool` |

**采集时不做的事**：不猜依赖关系（能力图 `provides/needs` 由人补或由命名约定推），不采集凭证（env 里的密钥必须剥掉，只留键名），不采集运行时状态（session、缓存）。

凭证这一条是硬约束：包会进 registry、会被别人装，采集器必须有一份明确的 redact 列表，并且在 `packhub capture --dry-run` 里把剥掉的东西列出来给人看。

## 三、三种来源，三种形态

| 来源 | 用户怎么用 | 技术形态 | 难点 |
|---|---|---|---|
| **本机** | `packhub capture ~/work/app` | 直接读本机目录与配置 | 判断哪些是「这套环境的能力」 |
| **公司服务器** | `packhub capture --ssh build@10.0.1.7:/srv/agent` | 远端跑一次只读探测，结果回传本地打包 | 远端可能没有 Node/我们的 CLI；只读、不留痕 |
| **远程服务器 / 托管环境** | 由服务器侧跑 `packhub capture --report` 上传清单 | 采集与打包分离：服务器只产出「环境事实」，打包在本地做 | 信任：清单来自别人，必须能复核（哈希 + 指纹） |

三种来源都应该收敛到同一份中间产物：**环境事实（facts）**。facts 是纯数据，不含凭证，可以被人审阅、diff、归档。打包器只吃 facts，不直接摸机器——这样本地、SSH、远程上报三种来源走同一条打包逻辑。

## 四、部署形态

| 目标 | 形态 | 状态 |
|---|---|---|
| 本机目录 | `packhub install <dir>`（已有） | ✅ |
| 另一台机器 | `packhub deploy --ssh user@host:/path <pack>`：把 plan 读出来、远端执行同样动作 | 未做 |
| 容器 | 生成 Dockerfile 片段 / 直接产物挂载 | 未做 |

远程部署的关键约束：**判断仍在本地做**。远端只执行 plan，不重新解析 manifest——否则两台机器上的行为会分叉，`planHash` 就失去意义。

## 五、最小可验证切片（建议先做这个）

不碰 SSH、不碰 registry，先把「反推」这条链在本地跑通：

```
packhub capture ./my-env --out ./my-pack     # 扫一份真实环境，产出 manifest + vendored 资源
packhub install ./my-pack --dir /tmp/target  # 装到另一个目录
packhub verify /tmp/target                   # 校验通过
```

验收标准：**把 `my-env` 删掉之后，`/tmp/target` 仍然是完整可用的一套能力**。这一条成立，才说明采集出来的包是自足的；不成立，后面的分发和远程部署都是假的。

## 六、要定的三件事

1. **采集边界**：只采 PackHub 自己装出来的东西（`.packhub/state.json` 里记录的），还是采整个机器的 Agent 环境（DSH/Claude/自建都认）？后者价值大，但要写各家的探测适配器。
2. **facts 的形态**：一份 JSON（机器可读、可 diff）还是直接就是 manifest？我倾向 facts 与 manifest 分开：facts 记录「机器上有什么」，manifest 记录「要交付什么」，中间是可以人审的转换。
3. **远程优先做哪种**：SSH push（本地决定、远端执行）还是 pull（服务器自己跑、上报清单）？前者可控，后者适合公司服务器不让外连的场景。
