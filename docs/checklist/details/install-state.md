# 安装、状态与回退

## 一次安装的固定顺序

`applyPlan(plan, { root, packRoot })` 的顺序不能换：

1. 抢 `.packhub/installing.lock`（`openSync(file, 'wx')`，O_EXCL）。
2. 检查项目级所有权：这次要写的普通文件，是否已经被别的包占用。
3. 快照：把 `touchedPaths(plan)` 里已经存在的文件/目录复制到 `.packhub/snapshots/<generation>/files/`，同时复制一份当时的 `state.json`。
4. 逐条执行动作，每条写一个 `ActionOutcome`。
5. 有 `failed`：按快照恢复 `existed`、删除 `created`、不写 state、删掉本次 generation。
6. 全成功：写 state（每个包一条记录），把 generation 追加到 `state.generations`，裁到最近 5 个。

## state 里有什么

```jsonc
{
  "packs": {
    "demo/foo@0.1.0": {
      "planHash": "sha256-…",
      "installedAt": "…",
      "actions": [{ "actionId": "write#1", "op": "write", "status": "done", "target": "…" }],
      "written": [".packhub/knowledge/foo.md"],
      "plan": { "target": "dir", "actions": [], "verify": [], "excluded": [] }
    }
  },
  "generations": [{ "id": "…", "existed": [], "created": [] }]
}
```

- `written` 是这个包拥有的路径；升级时取旧版与本次的并集，旧版本 key 会被合并删除。
- `plan` 是快照：`update` 和 `verify` 在项目根上靠它工作，不再要求项目里有 `packhub.yaml`。
- `actions` 保留每种动作的结果与 `undo`（`merge.config` 用叶子键记撤销）。

## 回退

- `rollbackPack(root, id?)`：取最后一个或指定 generation，恢复 `existed`、删除 `created`、把快照里的 `state.json` 放回去。
- 一次退一个 generation；连续调用可以继续往前。
- 只保留 5 个 generation；更早的快照会被删，rollback 会报“快照已不在”。
- 没有“激活指针”，所以不能在同一目录里保留两个版本再整体切换。

## 升级

`updatePack` 顺序：

1. 取新版本到 `.packhub/packs/<name>/`（先清空旧内容，避免上一版文件残留）。
2. 安装新计划。
3. 用**安装前取出的旧计划**清理“旧计划有、新计划没有”的产物：write/link/unpack/fetch 删除；merge.config 按旧 undo 还原；register.mcp 摘条目；instruction 摘块。
4. state 里旧版本 key 已合并，`written` 去掉被清理的路径。

## 卸载

- 按 `record.written` 逆序删；目录先删子再删父。
- 配置 `.json`：只按 undo 摘自己的键、删自己的 server 条目；空了才删文件。
- 指令文件：只摘 `<!-- packhub:begin … -->` 块；块外用户内容保留。
- 从 registry 装进来的清单副本 `.packhub/packs/<name>/` 一起删。

## 已知边界

- 所有权只按动作声明的顶层路径判；两个包各装一个目录，目录内部撞文件不会提前发现。
- 崩溃残留的 `installing.lock` 要人工确认后删，没有超时回收。
- `fetch` 的缓存文件不参与 owned/清理策略；缓存会留在 `.packhub/cache/`。
- 失败回滚只覆盖本次 `touchedPaths`；`exec` 在仓库外的副作用无法撤销。
