# 学习系统（整合案例）

这个 Pack 演示「打包」和「整合」的差别：把资源列进清单只是打包；整合要把上游的东西改过再给出去。

## 包里有什么

- `skills/learn-core`、`skills/memory-core`：两个 skill 的原始版本
- `resources/loader.md`：加载器说明（装完要做的三件事、两个 skill 的边界）
- `forks/memory-core`：改过一份的 memory-core，用 `source` 直接指过去

## 二次修改落在哪

只有一处 `modify`：`learn-core` 的 `SKILL.md` 里有一行写死了打包机器的绝对路径，改成随包走。

```yaml
modify:
  - resource: learn-core
    file: SKILL.md
    at: '本机的配置在 `G:\work\tool\skill-hub\learning\config.md`；…'
    with: '本机的配置在 `config.md`（随包走，和 SKILL.md 同级目录）；…'
```

`at` 是整行原文，必须唯一命中；找不到或命中多处，`plan` 阶段就报错，不写盘。改的是那一行，其余 63 行原样。

`memory-core` 没走 `modify`：它换的是整个资源来源，直接写 `source: ./forks/memory-core`。

## 怎么看出来

```bash
packhub plan          # 三个动作：两个 link.skill、一份 knowledge，外加一条改过的文件写入
packhub install .     # 装完
```

装出来的 `.packhub/skills/learn-core/SKILL.md` 与包里的 `skills/learn-core/SKILL.md` 差一行；`.packhub/skills/memory-core/SKILL.md` 与 `skills/memory-core/SKILL.md` 也差一行。两行都是把 `G:\work\...` 换成 `config.md`。

## 记忆区不随包走

包里只有框架。`memory-core` 说的记忆区、`learn-core` 说的临时笔记目录，都是本机的东西；换台机器应该是空的，装完按 `resources/loader.md` 的三步自己建。
