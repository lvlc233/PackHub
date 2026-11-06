# Minecraft 整合包制作全流程（2026-11 版）[待消费]

## 0. 先分清三件事

| 名字 | 是什么 | 谁在用 |
|---|---|---|
| 实例（instance / profile） | 启动器里一个独立的 `.minecraft` 目录，含 mods、config、存档 | 玩家 | [->Agent harness也应该有]
| 整合包（modpack / pack） | 一份「装什么、怎么配、怎么改」的配方，可分发 | 作者 | [我们的pack]
| 服务端包（server pack） | 同一份配方的服务端子集 + 启动脚本 | 服主 | 没有

**术语约定（后文沿用）**

- `实例根`：包含 `mods/`、`config/`、`saves/` 的那一层
- `包源`：你自己维护的、被 git 管的那份目录，通常只有 `mods/`（或 `mods/*.pw.toml`）、`config/`、`kubejs/`、`defaultconfigs/`、`resourcepacks/` 等
- `dist/`：导出产物（zip / mrpack / server pack），每次发布时重新生成，不进 git 
[可参考]

---

## A. 立项

### A1. 先写清楚这个包解决什么问题

- [ ] 一句话定位：给谁玩、核心循环是什么、和同类包区别在哪| [这也我们的pack的核心实现,不是只是单纯能力的集成]


### A2. 选版本和加载器（这一步决定后面 80% 的工作量）

**先选 MC 版本** 

1. 查目标模组支持到哪个版本（CurseForge/Modrinth 的 Files 页，看最新 file 的 game version）
2. 取「你要的核心模组都有人维护」的最高版本
3. 如果核心是某个大型内容模组（Create、GregTech、Botania 的深度整合），跟着它的主版本走，别追最新

**再选加载器** [基本就相当于我们选择的harness的类型]

| 加载器 | 现状（2026） | 适合 |
|---|---|---|
| NeoForge | 1.20.2 起从 Forge 分支出来，26.x 主力；Sodium/Iris 已支持 | 大型内容包、科技魔法、需要 Forge 生态模组 |
| Fabric | 轻量、更新快、API 抽象少 | 性能包、小工具包、客户端向 |
| Forge | 仍在，但 1.20.2 后生态重心转向 NeoForge | 老版本包（1.12.2 / 1.16.5 / 1.20.1） |
| Quilt | 兼容 Fabric 模组，生态小 | 一般不用作新包首选 |

判断口径：去 CurseForge 按「游戏版本 + 加载器」筛一遍，数一下你想装的模组里有多少是 NeoForge 独占、多少是 Fabric 独占。独占多的那边赢，别为了信仰硬扛。

**为什么大量整合包停在 1.20.1/1.21.1**：这两个版本模组存量最大、教程最多、作者维护最久。26.x 的模组数量还在爬坡，26.3 才发布两个多月。新包追新版本要么接受模组缺失，要么等半年。


### A6. 命名与版本号

- [ ] 包名：能搜到、不撞车，英文优先（平台索引对中文支持一般）
- [ ] 版本号：`<MC 版本>-<包版本>`，例如 `26.3-1.4.2`；包版本用语义化（改配方 = patch，加模组 = minor，换 MC 版本 = major）
- [ ] 分支策略：`main` = 当前发布版，`mc/1.21.1` = 老版本维护分支
[好习惯,但是不限制,可以在最佳实践中补充]

### A7. 产出物清单（第一版就该建好）

```
pack/
├── mods/                 # 或 packwiz 的 mods/*.pw.toml
├── config/
├── defaultconfigs/
├── kubejs/
│   ├── startup_scripts/
│   ├── server_scripts/
│   └── client_scripts/
├── resourcepacks/
├── shaderpacks/
├── options.txt           # 可选，控制默认键位/视距
├── servers.dat           # 可选，预置服务器
├── README.md             # 给玩家的安装说明
├── CHANGELOG.md
└── LICENSE-pack.md       # 你自己的授权，和模组授权分开写
```
[或可以参考,尤其是注入修改的部分]

---

## B. 环境准备

### B1. 工作区布局

```
G:\work\mc\mypack\
├── pack\          # 包源，进 git
├── instances\     # 测试实例（Prism 的实例目录）
├── dist\          # 导出产物，不进 git
├── tools\         # packwiz.exe、mx、脚本
└── notes\         # 设计笔记、待办
```
[或可以参考,用于初始化和ui界面]


### B2. 启动器 [我们就只有PAL一个,或者是直接注入;PAL后面考虑]

| 启动器 | 用途 | 备注 |
|---|---|---|
| Prism Launcher | 主测试环境，多实例、按实例指定 Java | 支持导入 CurseForge/Modrinth/ATLauncher 包 |
| Modrinth App | 验证 mrpack 的实际安装效果 | 和 Modrinth 生态绑定 |
| HMCL / PCL2 | 中文玩家实际用的启动器，发布前必须验 | PCL2 对某些 zip 结构挑剔 |
| CurseForge App | 发布到 CurseForge 后验证 | 会自动装依赖，掩盖依赖缺失问题，不能只信它 |






### B5. 打包工具选型
[就是打包方式,确实我们得梳理下]
| 工具 | 干什么 | 适合 |
|---|---|---|
| packwiz | 用 TOML 清单描述模组，能导出 CurseForge/mrpack，自带 HTTP 更新服务 | 首选，尤其做自动更新 |
| Modrinth App 导出 | 从实例直接导出 .mrpack | 小包、快速发 Modrinth |
| CurseForge App 导出 | 导出 zip + manifest.json | 发 CurseForge |
| 手写脚本 | 复制文件、改 manifest、算 sha1 | 有特殊结构时 |

packwiz 安装（Windows）：从 GitHub Releases 下 `packwiz_amd64_windows.exe`，改名 `packwiz.exe` 放进 `tools/`。

### B6. 冒烟脚本

写一个 `notes/smoke.md`，每次改完按顺序做：

1. 启动客户端到主菜单（不看日志有没有 ERROR，只看能不能进）
2. 新建世界，出生点周围 200 格走一圈
3. `/reload` 一次
4. 退出，看 `logs/latest.log` 尾部有没有 `Exception`
[嗯,这是我们的验证,可以参考]
---

## C. 模组选型

### C1. 来源优先级

1. Modrinth / CurseForge 官方页（有校验、有版本矩阵）
2. 作者 GitHub Releases（新版本常常先发这里）
3. 作者 Discord（测试版，慎用）
4. 不要用第三方转载站：版本号被改、jar 被塞东西、缺依赖

[我们也可以梳理下,都可以由哪些来源]


### C4. 冲突预判（装之前先想）

| 冲突类型 | 表现 | 处理 |
|---|---|---|
| 功能重复 | 两个模组都改同一机制，行为不确定 | 只留一个，或用配置关掉一半 |
| Mixin 冲突 | 启动崩，栈里有 `Mixin apply failed` | 换版本、改配置、去掉一个 |
| 配方冲突 | 同一配方被两个模组定义 | 用 KubeJS 按 id 删一个 |
| 标签冲突 | 一个物品同时属于 `forge:ingots/iron` 和 `c:iron_ingots` | 写统一 tag 数据包 |
| 能量单位 | FE/RF/μI 换算不一致 | 装能量转换模组或统一配置 |
| 世界生成 | 两套结构生成规则互相挤占 | 调权重或关掉一套 |
| 客户端/服务端 | 客户端模组进服务端包 → 崩 | 按 `env` 分文件 |

[是的,这也是给作者端的思考,另外,这也是我们需要提供可以修改的缘由之一]



### C6. 记录选型理由

`notes/mods.md` 里每个模组一行：为什么选、替代方案、配置要点。半年后你自己也想不起来为什么装了两个存储模组。
[好习惯,最佳实践吧当]
---



## E. 配置层



### E4. 配置改动管理

- [ ] `notes/config.md` 记「哪个文件、哪个键、改成什么、为什么」
- [ ] 每次改完 `git diff` 看有没有误改（TOML 编辑器常顺手加空格/重排）
[好习惯]

### E5. 配置锁定

部分模组支持 `config` 只读或服务端强制下发；默认没有。要防玩家改：

- 服务端 `server.properties` 的 `enforce-whitelist` 管不了配置
- 可行做法：把关键值写进 `serverconfig`（跟存档走），客户端改了也没用
[可参考]
---

## F. 数据包层（改模组内容的主战场）

数据包改的是「游戏数据」：配方、战利品、标签、进度、世界生成。它不改代码，跨客户端/服务端，能随整合包分发。

### F1. 加载与覆盖规则

- 数据包位置：`saves/<world>/datapacks/`（单存档）、`<实例>/datapacks/`（全局，1.13+ 可用）
- 模组 jar 里的 `data/` 会被当成内建数据包加载
- **同名文件**：后加载的覆盖先加载的。优先级从高到低：世界数据包 > 实例数据包 > 模组内置 > 原版
- **同名目录下的 JSON 列表**（tags、某些 registry）：默认**合并**而不是替换，要整体替换必须写 `"replace": true`
- 加载顺序无法精确控制，靠文件名排序不可靠 → 要覆盖就保证路径完全一致
[数据包吗....]
### F2. 一个最小数据包

```
mypack-datapack/
├── pack.mcmeta
└── data/
    └── <modid>/
        └── recipe/
            └── some_recipe.json
```

`pack.mcmeta`（以 1.21.1 为例）：

```json
{
  "pack": {
    "description": "MyPack tweaks",
    "pack_format": 48
  }
}
```

- 1.21.1 的数据包格式是 48，资源包是 34；26.2 是 107.1 / 88.0，26.3 是 121.0 / 97.1（官方发行说明的写法，带小数）
- `pack_format` 对不上不会报错，**整个包被静默忽略**——"我改了没生效"九成是这个
- 1.20.2+ 才有 `supported_formats`；26.x 的写法有变化（版本号带小数点），写之前对一遍 wiki 当前示例
- 26.3 的数据包版本是 121.0，资源包是 97.1（官方发行说明里写着，别抄博客）



### F4. 配方

**删配方**（最常用的「改模组原内容」）：

- 数据包没有「删除」这个原语：覆盖同名文件只能改内容，不能让它消失；写空对象会让解析报错
- 真正干净的做法是脚本层按 id 删（见 G 节），因为同名覆盖要猜路径和 id
- 想知道 recipe id：`/recipe` 命令不给，用 KubeJS 的 `/kubejs export`（视版本）或解压 jar 看 `data/<modid>/recipe/*.json` 文件名

**改配方**：复制原 JSON，改 ingredients/result，放同路径覆盖。

1.21+ 的 result 写法变了：

```json
{
  "type": "minecraft:crafting_shaped",
  "pattern": ["ABA", "BBB", "ABA"],
  "key": { "A": "minecraft:iron_ingot", "B": {"item": "minecraft:coal"} },
  "result": { "id": "minecraft:diamond", "count": 1 }
}
```

1.20.4 及以前是 `"result": {"item": "minecraft:diamond", "count": 1}`，1.20.1 及以前可以直接 `"result": "minecraft:diamond"`。

**加配方类型**：`crafting_shaped`、`crafting_shapeless`、`smelting`、`blasting`、`smoking`、`campfire_cooking`、`stonecutting`、`smithing_transform`、`smithing_trim`，以及模组注册的自定义 type（例如 `create:mechanical_crafting`）。模组配方类型要去模组的 wiki 查 JSON 结构，没有统一规范。

### F5. 标签（统一矿物、统一流体）

```json
{
  "replace": true,
  "values": [
    "minecraft:iron_ingot",
    {"id": "othermod:iron_ingot", "required": false}
  ]
}
```

- `replace: true` = 丢掉所有原有值，只用我的 → 用来解决「一个物品属于两套 tag」
- 不要轻易 `replace` 原版 tag（`minecraft:planks` 之类），会把别的模组依赖打断
- 通用标签：1.21 起官方推 `c:` 命名空间（`c:ingots/iron`），老的 `forge:` 仍在用，两套并存是常见冲突源
- 加方块挖掘等级：`minecraft:mineable/pickaxe`、`needs_iron_tool`

### F6. 战利品表

路径：`data/<ns>/loot_table/blocks/<block>.json`、`entities/<entity>.json`、`chests/<chest>.json`、`gameplay/fishing.json`。

结构骨架：

```json
{
  "type": "minecraft:block",
  "pools": [{
    "rolls": 1,
    "entries": [{
      "type": "minecraft:item",
      "name": "minecraft:diamond",
      "functions": [
        {"function": "minecraft:set_count", "count": {"min": 1, "max": 3}},
        {"function": "minecraft:apply_bonus", "enchantment": "minecraft:fortune", "formula": "minecraft:ore_drops"}
      ]
    }],
    "conditions": [{"condition": "minecraft:survives_explosion"}]
  }]
}
```

要改模组方块掉落，就把模组 jar 里同路径文件复制出来改；找不到路径时用 `/loot` 命令反查（`/loot give @s loot <path>` 能确认路径存在）。

### F7. 世界生成（改完必须新建世界）

- 相关目录：`worldgen/{biome,configured_feature,placed_feature,structure,structure_set,template_pool,processor_list,noise_settings,density_function}`、`dimension/`、`dimension_type/`
- **`/reload` 不生效**，改一次新建一次世界，或用 `/execute in <dimension> run tp` 在现有档里验证已有区块之外的部分
- 结构改了但旧档已有区块不会重生成；测试要用 `chunky` 或新档
- 加维度要三件套：`dimension_type`、`dimension`、以及进入方式（传送门/命令/模组）

### F8. 进度与函数

- 进度（advancement）能当「隐形成就系统」，触发 `function` 做奖励
- 函数（function）1.20.2+ 支持宏（`$(arg)` + `macros` 字段），能写参数化逻辑
- `data/minecraft/tags/function/tick.json`、`load.json` 挂循环与初始化
- 服务端专用；客户端不读

### F9. 什么时候数据包改不了

- 模组用**代码**注册配方/物品（不是 JSON）
- 模组在运行时动态生成内容（例如某些随机化模组）
- 需要改行为逻辑（掉落条件带复杂判断、机器处理流程）
- 需要改客户端渲染

这几种只能走脚本层或写模组。判断方法：解压 jar，看 `data/` 里有没有目标文件；没有就是代码注册。



### F10. 全局数据包的加载方式

原版只认世界里的 `datapacks/`。要让整合包「装完就带」：

- 放进 `config/openloader/data/`（OpenLoader 模组）
- 用 Paxi（NeoForge/Fabric 的全局数据包/资源包加载器）
- 或者干脆不打包，开服时手动放 `world/datapacks/`

前两种要额外带模组，第三种要写安装说明。

### F11. 数据包验证

1. `/datapack list` 看有没有被识别
2. `/reload` 看日志里有没有 `Failed to load`
3. 用 `/recipe give`、`/loot`、`/advancement` 做正向验证
4. 版本错时**没有任何提示**，只能靠行为反推
[这里似乎为skill的文本修改或者是其他的修改可以提供思路]

---


## H. 自定义内容（资源包与表现层）

### H1. 资源包结构

```
mypack-resources/
├── pack.mcmeta
├── pack.png
└── assets/
    ├── minecraft/          # 覆盖原版
    │   ├── textures/
    │   ├── models/
    │   ├── lang/
    │   └── sounds.json
    └── <modid>/            # 覆盖模组
        └── textures/item/xxx.png
```

- 路径必须和 jar 内**完全一致**才覆盖
- 打包成 zip 时，`pack.mcmeta` 必须在 zip 根目录，不能多一层文件夹——这是「资源包显示为无效」的第一原因
- 默认启用：`options.txt` 里 `resourcePacks:["vanilla","file/mypack.zip"]`
[自定义内容...或可以参考]

### H2. 改模组贴图/模型

1. 解压 jar，找 `assets/<modid>/textures/...`
2. 复制到资源包同路径，改 PNG（保持尺寸，某些渲染器对非 2 的幂尺寸敏感）
3. 需要改模型就一并复制 `models/**/*.json`，注意里面的贴图引用路径
4. 1.21.4+ 有新的 item model 定义系统，老教程的 `item/generated` 写法部分失效

### H3. 语言与文本

- `lang/en_us.json`、`lang/zh_cn.json`，key 必须和模组里的一致
- 覆盖模组条目 = 同名 key 写进你的资源包
- 术语统一：能量叫「FE」还是「RF」、机器叫「方块」还是「机器」，全包一致
- 翻译漏了会显示 key 原文，不影响运行，但很显眼

### H4. 音效与音乐

- `assets/<ns>/sounds.json` 定义事件 → 文件映射
- OGG Vorbis，单声道、44.1 kHz、码率别太高（音乐可以立体声）
- 背景音乐要挂到 `minecraft:music.game`/`music.creative` 等事件，或由模组触发
- 音量默认值在 `options.txt` 的 `soundCategory_music`

### H5. 界面定制

| 目标 | 做法 |
|---|---|
| 主菜单背景 | `assets/minecraft/textures/gui/title/background/panorama_*.png` + `panorama` 配置 |
| 窗口标题 | 需要模组（如 CustomWindowTitle）或启动器参数 |
| 加载画面 | 1.20.2+ 有 `loading_background` 资源，或模组接管 |
| 图标 | `icons/icon_32x32.png` 等，打包进 zip；启动器还要单独设 |
| MOD 列表图标 | 每个模组自带，不改 |

### H6. 开箱即用设置

- `options.txt`：键位、视距、GUI 缩放、语言、音量——只在首次生成时生效
- `servers.dat`：预置服务器地址，二进制 NBT，别手写
- 预置存档：`saves/` 里放一个模板世界，让玩家从固定起点开始

---

## I. 任务与引导
[确实可以加一个安装了harness后,例如用户打招呼或初始化,可以给他发送消息,然后做下引导,而不是单纯的你好]

-


## N. 打包与分发
[嗯....]

### N1. 三种分发形态

| 形态 | 文件 | 优点 | 缺点 |
|---|---|---|---|
| 完整 zip | 全部 mods + config + 脚本 | 简单，离线可装 | 体积大，ARR 模组不能直传，更新要重下 |
| manifest（CurseForge） | `manifest.json` + `overrides/` | 平台托管下载，合规 | 绑定 CurseForge，国内慢 |
| mrpack（Modrinth） | `modrinth.index.json` + `overrides/` | 开放格式，多启动器支持 | 依赖 Modrinth 有该模组 |
| packwiz | `pack.toml` + `index.toml` + `mods/*.pw.toml` | 增量更新、git 友好、可自建源 | 玩家要装 bootstrap，教程成本 |

### N2. CurseForge manifest.json

```json
{
  "minecraft": {
    "version": "26.3",
    "modLoaders": [{ "id": "neoforge-21.1.0", "primary": true }]
  },
  "manifestType": "minecraftModpack",
  "manifestVersion": 1,
  "name": "MyPack",
  "version": "1.0.0",
  "author": "you",
  "files": [
    { "projectID": 238222, "fileID": 5123456, "required": true }
  ],
  "overrides": "overrides"
}
```

- `projectID`/`fileID` 从 CurseForge 项目页的 Files 里拿，不是 slug
- `overrides/` 里放 config、kubejs、defaultconfigs、resourcepacks
- 客户端/服务端分离用 `"clientOnly"` / `"serverOnly"` 标记（新版字段，写之前对一遍当前规范）

### N3. mrpack

结构：

```
mypack.mrpack (zip)
├── modrinth.index.json
├── overrides/           # 两端都要的文件
├── client-overrides/    # 只客户端
└── server-overrides/    # 只服务端
```

`modrinth.index.json`：

```json
{
  "formatVersion": 1,
  "game": "minecraft",
  "versionId": "1.0.0",
  "name": "MyPack",
  "summary": "一句话",
  "files": [
    {
      "path": "mods/sodium.jar",
      "hashes": { "sha1": "...", "sha512": "..." },
      "env": { "client": "required", "server": "unsupported" },
      "downloads": ["https://cdn.modrinth.com/data/.../sodium.jar"],
      "fileSize": 1234567
    }
  ],
  "dependencies": {
    "minecraft": "26.3",
    "neoforge": "21.1.0"
  }
}
```

- `env` 决定启动器是否在服务端跳过该文件，写错就是「客户端能进、服务端崩」
- `hashes` 至少给 sha1 和 sha512，启动器会校验
- `overrides` 里的文件**不写进 files**，直接原样解压

### N4. packwiz 流程

```bash
# 初始化（在包源目录）
packwiz init --name "MyPack" --author "you" --version "1.0.0" \
             --mc-version 26.3 --modloader neoforge --neoforge-version 21.1.0

# 装模组（自动解析依赖）
packwiz modrinth install sodium
packwiz curseforge install jei
packwiz curseforge install 238222        # 按 projectID

# 刷新索引（改完任何文件都要跑）
packwiz refresh

# 导出
packwiz modrinth export          # -> .mrpack
packwiz curseforge export        # -> CurseForge zip

# 本地测试服务（给启动器当更新源）
packwiz serve --port 8080
```

产物：`pack.toml`（包元数据 + index 哈希）、`index.toml`（文件清单 + 哈希）、`mods/*.pw.toml`（每个模组的下载源）。

托管：把包源 push 到 GitHub，用 Pages 或对象存储提供 `pack.toml` 的 URL；玩家用 `packwiz-installer-bootstrap.jar` 指向该 URL，启动时增量同步。

### N5. 导出后的自检

- [ ] 在干净的实例目录（不是你的工作实例）装一遍
- [ ] 断网装一遍：验证哪些文件其实没被写进包
- [ ] 检查 zip 根目录结构：`manifest.json`/`modrinth.index.json` 必须在根
- [ ] 大小与文件数对得上（少一个 config 就可能少一类设置）
- [ ] 服务端包单独装一遍

### N6. 国内分发补充

- CurseForge/Modrinth 下载慢，国内玩家多用 HMCL/PCL2 从镜像装
- 给网盘完整包时，附 `README` 写清 Java 版本、内存、启动器版本
- 别把 jar 改名为中文，部分启动器按文件名匹配更新

---

## O. 发布
[嗯,打包和发布是两件事情]
### O1. 发布前检查表

- [ ] 版本号、包名、图标（400×400 起，PNG）
- [ ] 描述页文案：定位、玩法、配置要求、Java 版本、内存、安装方式
- [ ] 截图 3–6 张（主菜单、任务书、特色机器、联机场景），不要全是风景
- [ ] 模组清单（自动生成，别手打，打错一个就是版权风险）
- [ ] 授权信息：每个模组的 license 与是否允许再分发
- [ ] `CHANGELOG.md` 对应当前版本
- [ ] 服务端包单独上传（如果支持联机）
- [ ] 备用下载（国内网盘），并写清校验值

### O2. CurseForge 流程

1. 注册项目（Project type: Modpacks），填名称/摘要/分类
2. 上传 zip：根目录含 `manifest.json` + `overrides/`
3. File 设置：Release 类型、游戏版本（26.3）、加载器版本
4. 关联依赖：不需要逐个列，manifest 里已有
5. 审核：CurseForge 对整合包有人工审核，含版权投诉的会被打回

### O3. Modrinth 流程

1. 创建项目（Project type: Modpack），上传 `.mrpack`
2. 版本号、changelog、游戏版本、加载器
3. Modrinth 的包会自动解析到每个模组的原始页，作者能看到自己的模组被谁用了
4. 审核较快，但同样受 DMCA

### O4. 国内渠道

- 苦力怕论坛（klpbbs）、MC 相关贴吧、QQ 群、B 站专栏
- 网盘完整包 + 安装视频是转化率最高的组合
- 论坛帖要写清「Java 版本 / 内存 / 启动器 / 已知问题」，否则评论区全是重复提问

### O5. changelog 写法

```markdown
## 1.2.0 (2026-11-10) — MC 26.3

### 新增
- 加入 Create 6.x，替换旧版机械动力
- 新增第 4 章任务：蒸汽时代

### 修改
- 铁锭产出下调 30%，抑制刷铁机
- 统一矿物标签到 c: 命名空间

### 修复
- 修复下界传送门在 26.2 存档中失效

### 升级注意
- 从 1.1.x 升级需删除 config/create-common.toml（格式已变）
```




# 第二部分：细化     

### Y5. 托管

| 方案 | 成本 | 国内速度 |
|---|---|---|
| GitHub Pages | 免费 | 慢，偶尔被墙 |
| Cloudflare Pages / R2 | 免费额度够 | 中 |
| 阿里云 OSS / 腾讯 COS | 几块钱/月 | 快 |
| 自建 nginx | 服务器成本 | 看线路 |

`pack.toml`、`index.toml`、`mods/*.pw.toml` 都要能公网访问；jar 本身可以指向 CurseForge CDN（但 CDN 有防盗链策略，packwiz 的 curseforge 源会自动处理）。

### Y6. CI 自动发布

```yaml
# .github/workflows/pack.yml
name: pack
on: push
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: |
          curl -L -o packwiz https://github.com/packwiz/packwiz/releases/latest/download/packwiz-linux-amd64
          chmod +x packwiz
          ./packwiz refresh
          ./packwiz modrinth export
      - uses: actions/upload-artifact@v4
        with: { name: mrpack, path: "*.mrpack" }
```

`packwiz refresh` 在 CI 里跑可以验证「清单和实际文件是否一致」，不一致就失败——这是防止漏文件最有效的一招。

---

