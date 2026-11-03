# 打包：像 Minecraft 整合包那样

## 一、先纠正我上一轮的说法

上一轮我把它写成「从机器上反推事实、自动生成包」，错了。真实场景是：

> **人主动挑组件、改配置、处理冲突、验证能用，然后打成一个包发出去。**
> 不是把现有环境压成 zip，是「策展 + 适配」的产物。

这套东西的形状跟 MC 整合包一模一样：**一堆别人的东西 + 作者的调整 + 一份说明「这个包是什么体验」**。区别只在组件是 MCP / skill / prompt / 知识 / 配置，而不是 mod。

## 二、MC 整合包拆开看，它到底由什么组成

一个真正的整合包不是 mods 文件夹的压缩包，而是六样东西：

| MC 里有什么 | 作用 | PackHub 对应 | 现状 |
|---|---|---|---|
| `mods/` + 每个 mod 的版本 | 组件选择 | `resources[]` + source pin | ✅ 有 |
| `overrides/config/*` | **作者改过的默认值**（不改就冲突/不好玩） | `overlays`（文件级）+ `overrides`（资源级） | ✅ 已实装，含冲突检测 |
| `manifest.json`（带每个文件的哈希） | 可复现 | `lock` + `planHash` | ✅ 有 |
| `side: client / server / both` | 同一个包，服务端只装必要部分 | `targets`（dir / dsh / claude-code） | ⚠️ 有 target，没有「服务端裁剪」 |
| pack version + changelog | 版本化与迁移说明 | `metadata.version` | ⚠️ 有版本，没有 changelog |
| 任务书 / 说明 / 上手引导 | 这个包**是干什么的**、怎么用 | Pack 的 README / 意图 | ❌ 没有 |
| 冲突处理（ID、配方、能量单位） | 让组件能共存 | `provides`/`needs`、`pin-conflict`、`output-conflict`、`config-key-conflict` | ✅ 能力图 + 输出冲突检测 |

结论：我们现在有「组件选择 + 可复现 + 安装」，缺的是**让一个包成为作品的那三样**——配置覆盖、客户端/服务端拆分、包自己的说明与变更记录。

## 三、由此推出的四件事

### 1. 覆盖（overrides）—— 已实装

MC 整合包的价值一半在 config 覆盖。现在两层都有：

- **资源级覆盖** `overrides:`：换某个资源的 pin / 实现 / 安装参数，与它原有的 `config` 深合并；上游清单不动。
- **文件级覆盖** `overlays:`：包里带一个目录，装完后按路径覆盖目标文件（配置、skill 里的文件、知识）。覆盖层最后执行，盖得住任何生成物；可以带二进制。

**冲突检测**（对应 MC 里「两个 mod 改同一个配方」）：

| 报错码 | 触发条件 |
|---|---|
| `output-conflict` | 两个动作写同一个文件 |
| `overlay-conflict` | 两个覆盖层改同一个文件 |
| `config-key-conflict` | 两个 config / MCP 改同一个配置键（此前是后写的静默赢） |
| `overlay-shadows` | 覆盖层盖住生成文件（**警告**，确认是有意的） |
| `override-unknown-resource` | `overrides` 指向不存在的资源 |

还没做：**用户本地覆盖**（`.packhub/local.yaml`），装完之后用户自己再改一层、不随包分发。这是下一处该补的口子。

### 2. 客户端 / 服务端拆分

MC 包有 client pack 和 server pack：同一个包，服务端剔除只对客户端有意义的组件（音效、界面、按键），配置也不同。

PackHub 的对应物是 target profile：

```yaml
targets:
  dir:    { include: [*] }                 # 本地/项目目录：全量
  server: { include: [mcp, tool, config], exclude: [prompt] }   # 服务器：无交互组件
```

这样「装到公司服务器」不是把本地那套原样搬过去，而是按 profile 裁剪——这正是你上一轮说的「本地 / 公司服务器 / 远程服务器」三种落点的真实差别。

### 3. 包自己的说明与变更记录

一个包要能回答：它解决什么问题、由哪些部分组成、装完怎么用、这版改了什么。

- `metadata.description` 只够一行；需要一份随包分发的 `PACK.md`（用途、上手三步、已知限制），包页直接渲染它。
- `CHANGELOG.md` 按版本记录；`verified` 报告绑到具体版本上，页面上能看到「0.0.2 改了什么、这版验证过」。

### 4. 归档与分发形态

`.phub` = MC 的 zip + `manifest.json`：manifest、lock、verify 报告、`overrides/`、vendored 资源。两种打包模式：

- `reference`：只带引用与哈希（小，装的时候下载）。
- `vendored`：资源全部快照进去（大，离线可装；公司内网场景必需）。

## 四、这解释了「为什么不是一个 zip 工具」

zip 工具解决「传过去」，整合包解决「传过去还能跑」。后者需要：

1. **知道每个组件怎么被消费**（mcp 只写配置、skill 要落目录）——已有；
2. **知道它们会不会打架**（能力图、pin 冲突、配置键冲突）——做了一半；
3. **知道装完算不算成功**（verify 报告）——已有；
4. **知道这套组合是干什么的**（说明 + 上手）——没有。

第 2 条和第 4 条是接下来真正要补的，不是采集器。

## 五、建议的下一步顺序

1. ~~overrides + 冲突检测~~（已实装）
2. **PACK.md / CHANGELOG + 包页渲染**（让包成为可传播的作品）
3. **server profile**（让「装到服务器」有真实差异）
4. **`.phub` 归档 + registry 分发**（前面三样齐了，分发才有意义）

采集器（从现有环境提取）在这之后做，而且只作为「起草」的辅助：扫出来给你当草稿，最终仍然是人挑、人改、人验证。
