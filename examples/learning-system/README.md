# 学习系统（整合案例）

这个 Pack 演示「打包」和「整合」的差别：把资源列进清单只是打包；整合要把上游的东西改过再给出去。

## 包里有什么

- `skills/learn-core`、`skills/memory-core`：两个 skill 的原始版本
- `resources/loader.md`：加载器说明（装完要做的三件事、两个 skill 的边界）
- `forks/memory-core`：改过一份的 memory-core
- `overlays/learn-core/SKILL.md`：装完之后盖上去的 learn-core

## 二次修改落在哪

1. **换来源（`overrides`）**：`memory-core` 不用 `skills/` 里那份，换成 `forks/memory-core`。上游把配置路径写成打包机器的绝对路径，这一份改成随包走。
2. **盖文件（`overlays`）**：装完两个 skill 之后，再把 `overlays/learn-core/SKILL.md` 写到 `.packhub/skills/learn-core/SKILL.md`，改的是同一处路径。

## 怎么看出来

```bash
packhub plan          # 四个动作：两个 link.skill、一份 knowledge、一条覆盖写入（排在最后）
packhub install .     # 装完
```

装出来的 `.packhub/skills/learn-core/SKILL.md` 与包里的 `skills/learn-core/SKILL.md` 差一行；`.packhub/skills/memory-core/SKILL.md` 与 `skills/memory-core/SKILL.md` 也差一行。两行都是把 `G:\work\...` 换成 `config.md`。

## 记忆区不随包走

包里只有框架。`memory-core` 说的记忆区、`learn-core` 说的临时笔记目录，都是本机的东西；换台机器应该是空的，装完按 `resources/loader.md` 的三步自己建。
