---
version: 0.0.1
mode: operate
palette:
  shell: "#101a1b"
  ground: "#e4e5df"
  panel: "#f4f4ee"
  panel_raise: "#fbfbf5"
  ink: "#16191a"
  ink_2: "#3a4542"
  mute: "#58625f"
  rule: "#c6c9c0"
  rule_soft: "#dcdeD5"
  accent: "#d9a100"
  accent_ink: "#191300"
  accent_deep: "#8a6400"
  ok: "#2c6b4f"
  warn: "#9a6a10"
  bad: "#a63a2e"
type:
  ui: '"Segoe UI Variable Text", "Segoe UI", -apple-system, "Noto Sans SC", "Microsoft YaHei", sans-serif'
  mono: '"Cascadia Mono", Consolas, "SFMono-Regular", ui-monospace, monospace'
  scale: { h1: 24px, body: 14px, ui: 13px, micro: 11px, micro_caps: 10.5px }
  tracking: { caps: 0.12em, mark: 0.18em, body: 0 }
radius: { default: 0px }
borders: { hairline: 1px, rule: "#c6c9c0", soft: "#dcdeD5" }
motion:
  stamp: 600ms cubic-bezier(0.16, 1, 0.3, 1)
  settle: 400ms ease-out
  hover: 160ms ease-out
---

# PackHub 设计说明

## 这是什么界面的设计

控制面板（Operate）。用户打开它是为了做一件事：看清一个整合包会动哪些文件，然后决定装不装、装完对不对。判断都在内核里，界面负责把内核的语义（资源、pin、计划、校验、状态）摆到台面上。所以世界只借四样东西：字体、调色、密度、一个签名动作；导航和控件保持平台标准。

## 世界

**备料台与装配单。** 现实场景：开发机上 21:00 之后开着编辑器，屏幕亮度调低一半，想确认这个包不会把 `.packhub` 之外的东西改掉。所以底色是偏冷的浅灰纸，左边一条近黑的墨绿导轨，正文黑，只有一处高饱和的赭黄——用在「当前选中的包」和落笔确认上，不铺开当装饰。

为什么不是深色主题：这类面板常与终端并排放，深色会与终端糊成一片；浅色纸面反而把它和编辑器分开。为什么不是奶油底 + 衬线：那是这个类目里最容易撞的默认脸，和「装配单」没有关系。赭黄而非信号红绿：红绿留给状态（通过/失败），不能让装饰色和工作状态色打架。

## 签名动作

**运行单落笔。** 右侧「运行单」按 `<op>#<n>` 列出内核生成的计划动作；点安装后每题逐条落字，状态点变实心，行底扫过一道赭黄后归位；同一时刻标题下的分隔线从左到右被「盖戳」一次。这是整个界面唯一一次动效，对应「计划被兑现」这件事，不是装饰。

## 排版与密度

- 数据一律等宽（Cascadia Mono / Consolas）：actionId、路径、pin、哈希、计数。等宽在这里不是「技术感」的服装，它就是代码与测量数据。
- 中文正文用系统 UI 字体栈，不引外链字体（离线可用，也与 Windows 渲染一致）。
- 微标签（`planHash`、列头、面板标题）小号大写 + 0.12em 字距；正文不加大字距。
- 定宽数字（`tabular-nums`）用在计数、时间、序号上，避免跳动。

## 结构

左侧导轨：仓库路径 → 包列表（选中整块填充赭黄）→ 底部一句内核与门面的分工。主区：标题 + 包标识 chips + 两个动作；一行 `planHash` 序列号（右端是动作数与校验数）；然后两栏——左「物料清单 / 校验 / 本机状态」，右「运行单 / 接线与环境」。

窄屏（≤1040px）单列，并把「运行单」提到最前：先看会发生什么，再看由什么组成。

## 状态颜色

`ok #2c6b4f`（完成/通过）、`warn #9a6a10`（跳过/待批准）、`bad #a63a2e`（失败）。状态点用描边圆点，成功后填充——比整行变色更省注意力，也不会把表格变成调色盘。

## 已知取舍

- 面板读 `manifest` 里的 `env` 原文做 ${vars.x} 替换只为展示；真正求值在 core 的 plan 阶段。两处逻辑若漂移，以 core 为准。
- 远程资源目前装不上（`fetch` 未实装），运行单会把它标成「跳过」并说明原因，而不是假装成功。
- 空状态只有导轨一行文字；还没有「没有整合包时引导 init」的完整首屏。
