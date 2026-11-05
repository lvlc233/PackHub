# UI ｜本地面板：逐项验收

## 怎么验

| 编号 | 验收动作 | 现状/证据 | 缺口/下一步 |
|---|---|---|---|
| UI-01 | `packhub serve .` 打开 `/` | 左侧包列表，右侧组成/计划/校验/状态 | 空仓库只有侧栏一行提示 |
| UI-02 | 打开 `/packs`、`/packs/<scope>/<name>` | 目录与详情读 registry | 不显示 PACK.md/CHANGELOG |
| UI-03 | 打开 `/console` | 草稿、资源池、计划预览、下载 YAML；高级字段、YAML 反向编辑、多草稿、导入导出 | 见 CON-01..50 |
| UI-04 | 打开 `/forms` | 四个形态 demo | 只是 demo，不是产品入口 |
| UI-05 | 选中 skill-only 包，滚到底部 | Harness 同步卡片：两个 home、勾选、预演/同步/移除 | 含 MCP 的包只提示不支持 |
| UI-06 | 点安装/校验 | API 执行并回填步骤/状态 | 失败态只在顶部 error |
| UI-07 | 390px 宽 | Chromium 实测无横向溢出；1080px 断点单列 | 视觉基线按平台存（win32 已生成） |
| UI-08 | 键盘 Tab / 屏幕阅读器 | axe 在 390/1280 跑三页，无 serious/critical；焦点可见、跳过导航 | 没有完整键盘走查 |
| UI-09 | 后端 500/422 | 顶部与同步错误 `role=alert` + `aria-live`；按钮 `aria-busy` | 错误文案未逐条审 |
| UI-10 | 直接访问深链 | history 路由 pushState/popstate；深链与后退可用 | 没有嵌套路由 |
| UI-11 | 创作台保存 | 填目录 → 写 `packhub.yaml`；已存在 409 | 只写清单，不复制本地资源 |
| UI-12 | 面板内安装 | 保存后执行计划并回填动作 | 安装根就是 Pack 目录 |
| UI-13 | 面板内发布 | 干净安装+校验+写 registry/索引 | 发布耗时同步等待 |
| UI-14 | 创作台端到端 | `ui:audit` 真点新增资源→保存并断言文件 | 无 |
| UI-15 | 视觉回归 | 首页/目录/创作台固定视口截图，与 `test/ui-baseline/<platform>/` 比像素（阈值 2%）；`ui:baseline` 重生成 | Linux 基线未生成 |

## 结论

面板已经能完成“看清单、看计划、装、验、同步”的主路径，创作台也补齐了高级字段、YAML 反向编辑、多草稿与导入导出。视觉稳定，390px 无横向溢出，axe 无 serious/critical。它不是市场前端；市场页面需要另做。
