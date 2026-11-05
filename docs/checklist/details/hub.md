# HUB ｜只读发布端：逐项验收

## 怎么验

| 编号 | 验收动作 | 现状/证据 | 缺口/下一步 |
|---|---|---|---|
| HUB-01 | `curl /api/registry` `/api/registry/pack` | 200，只读 | 无写/安装接口 |
| HUB-02 | 打开 `/packs/<scope>/<name>` | 读真实 manifest / lock / verify | 页面不渲染 PACK.md/CHANGELOG |
| HUB-03 | `POST /api/plan` 传草稿 | 返回计划；不落盘 | 依赖服务端 `packDir`，overlay 遍历需限界 |
| HUB-04 | `packhub hub . --host 0.0.0.0` 不带 token | 拒绝启动 | 需要部署层配 token/身份头 |
| HUB-05 | 高频请求 | 429 + `retry-after` | 限流按内存，重启清零 |
| HUB-06 | 配 `--audit logs.jsonl` 请求一次 | 一行 JSON：时间/IP/用户/方法/路径/状态 | 没有日志轮转 |
| HUB-07 | `GET /api/health` | `{ok,packs,uptimeSeconds}` | 无 |
| HUB-08 | SIGTERM | 停监听、等在途请求、5 秒兜底 | 无 |
| HUB-09 | `docker build` | 只读端镜像，CMD 起 hub | 镜像包含开发依赖 |
| HUB-10 | 找上传/发布接口 | Hub 没有；写端在 `@packhub/market` | 市场是独立进程 |
| HUB-11 | 找账号/组织 | 市场账号即 scope，token 认证 | 没有组织/成员 |
| HUB-12 | 找搜索/统计 | 市场 `/api/search` 带下载量 | 没有评分/评论 |

## 结论

Hub 的“读端”已经生产化：鉴权、限流、审计、健康、优雅退出、镜像都有。它刻意没有写端；市场需要独立的发布服务，不要把 Hub 改成可写。
