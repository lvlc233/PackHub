# 仓库（registry）

## 1. 三个面

| 面 | 谁 | 做什么 | 不能做什么 |
|---|---|---|---|
| 内容平面 | 静态目录（git / 对象存储 + CDN） | 存版本目录、`.phub` 归档、`index.json`；发布后不可变 | 不执行包、不接收上传 |
| 写平面 | `@packhub/market`（独立服务） | 账号、上传、审核、下架、评分、统计 | 不在服务器上执行上传者的代码 |
| 读平面 | `@packhub/hub`（只读 HTTP）+ CLI | 索引、包/资源数据、计划预览；`add` / `search` / `update` | 不执行安装 |

三者的交点只有不可变的版本目录与归档；谁写的、谁读的都不改包格式。

## 2. 目录与文件

仓库的存储结构约定

```
<registry>/
├── index.json                         # 生成物，不手写
├── packs/<scope>/<name>/
│   ├── <version>.phub                 # 归档（add 取的就是它）
│   └── <version>/                     # 版本目录（发布后不可改）
│       ├── packhub.yaml
│       ├── packhub.lock.json
│       ├── packhub.signatures.json    # 有签名时
│       ├── verify.json                # 有验证报告时；ok 且 planHash 对齐才算 verified
│       ├── PACK.md / CHANGELOG.md     # 有就复制
│       └── <vendored 条目>            # resources/ fragments/ overrides/ skills/ glue/ external/ ……
```

## 3. 发布（`packhub publish`）



## 4. 索引（`index.json`）


## 5. 市场（写端）

端点（`packages/market/src/server.ts`）：->不抽象为协议吗?然后再转化实现;不应该是内核,我们这边不负责实现这个的应该

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/accounts` | 注册；token 只返回一次，服务端只存 sha256 |
| GET | `/api/me` | Bearer token → `{id, name, scope}` |
| GET | `/api/search?q=` | 索引 + 下载量 / 7 日趋势 / 均分与评论 |
| GET | `/api/packs?name=&version=` | 清单、锁、报告、审核状态、下载量、评分、PACK.md / CHANGELOG |
| GET | `/download?name=&version=` | `.phub`；下架后 410 |
| POST | `/api/publish` | 请求体是 `.phub`；解包 → 跑 `publishPack` |
| POST | `/api/ratings` | 1..5 分 + 评论；一账号一票 |
| GET | `/api/admin/{stats,queue}` | `x-market-admin` |
| POST | `/api/admin/review` | approve / reject |
| POST | `/api/admin/rotate` | 轮换管理 token |
| POST | `/api/yank` | 目录与归档移入 `.market/quarantine/`，索引重建 |
| GET | `/admin` | 管理页（页面公开，数据接口要 token） |

上传校验（`server.ts:288-310`）：清单合法；只能发自己 scope；`visibility` 只接受 `public` / `unlisted`；拒绝 `install.exec`；拒绝 `command` / `scenario` / `mcp-ready` 三类执行型检查。

审核：`--require-review` 时先写 `.market/staging/`，批准才移到 registry 并重建索引；拒绝只删这一版与它的归档。管理 token 首次启动落 `.market/admin.json`（只存 sha256），approve / reject / rotate 写 `.market/admin-audit.jsonl`。

存储：`.market/market.db`（SQLite，WAL）；旧 `.market/db.json` 首次打开自动导入并改名 `.migrated`。

## 6. 读取（Hub）

- 路由：`/api/registry`、`/api/registry/pack`、`/api/registry/resources`、`/api/plan`、`/api/health`。
- 鉴权：只绑回环；对外监听必须配 `--token` / `PACKHUB_HUB_TOKEN` / `--user-header`，否则拒绝启动（fail-closed）。除 `/api/health` 外都要鉴权，接受 `Authorization: Bearer` 或 `x-packhub-token`。
- 限流：每 IP 每分钟 240，超了 429；每次请求写一行审计。
- 缓存：JSON 带 ETag / Cache-Control，条件请求 304。
- 分发：没有静态站产物；registry 目录（`index.json` + `packs/**/*.phub`）放哪都行，由 CLI 直接读或自行托管 HTTP。

## 7. 来源、鉴权与私有仓库

来源形态：`npm:`、`pypi:`、`github:`、`https:`、`./`；`add` 另外接受 `.phub` 与 `git+https://`。v0 不做跨包引用（`packhub://` 已移除）。

私有来源（authoring 里那句「私有仓库鉴权没有支持」已删；这里的写法是实际行为）：

```yaml
- id: internal-rules
  type: knowledge
  source: https://gitlab.corp.example/g/agent/rules/-/archive/abc123/rules-abc123.tar.gz
  integrity: sha256-…
  auth:
    env: CORP_GITLAB_TOKEN     # 只写变量名
    scheme: bearer             # bearer | token | basic，默认 bearer
```

- token 从环境变量或 `~/.packhub/credentials.json`（0600）取；`packhub auth set/list/remove/rotate` 管理。
- 请求头：`Bearer <token>` / `token <token>` / `Basic <token>`（`basic` 直接把 token 放进去，不是 `user:pass` 的 base64）。
- 缺变量时安装直接报「需要 CORP_GITLAB_TOKEN…」；token 不进清单、锁、state、日志。
- 已用本地 HTTP 服务实测（`packages/runtime/test/auth.test.ts`：401 → 带 Bearer 才拿到内容）。
- 限制：`git+https://` 仓库没有鉴权通道；`auth` 按资源声明，不按 host 自动匹配；npm/pypi 走公开端点。

完整性分层：npm 用 `dist.integrity`；`https` 必须带 `integrity`（缺失在 plan 阶段就拒）；`github:` 按 commit 下载归档算 sha256；本地 `./` 的 `integrity` 为 `null`（故意的，不假装锁住）。归档本身没有字节哈希进索引——**registry 即信任**；签名覆盖的是 `{pack@version, planHash}`，不是归档字节。

## 8. 归档、缓存、离线

- `.phub` = tar.gz，解包后就是 Pack 根。
  - reference 模式：清单 + 锁（+ 有签名时的 `packhub.signatures.json`）。
  - vendored 模式：再加全部顶层条目（跳过 `.packhub`、`node_modules`、`.git`、`dist`、旧归档）。
- `packhub pack` 默认自包含（`vendored`）；`--reference` 只打清单与锁，带本地 `./` 来源时直接拒绝（`pack.ts` 的 `LocalSourceNotVendoredError`）。
- 缓存按来源落在 `.packhub/cache/`；`packhub cache ls` 标引用、`cache clean [--dry-run]` 只删没被任何已装计划引用的项。
- 离线：`registry:verify-all:offline` / `verify:examples:offline` 会跳过有远程引用的包；`lock --offline` 只处理本地与已 pin 的引用。

## 9. 仍未收口的实现缺口

| 位置 | 现状 | 影响 |
|---|---|---|
| 市场 `unlisted` | 上传校验接受，`publish` 的 public 门禁与索引门禁都拒绝 | unlisted 发不进市场，也不能和索引共存；「直链分发」只对不建索引的独立 registry 成立 |
| `sign` 命令 | 没有 `--json` | 脚本拿不到结构化结果（审计文档已按现状改述） |
| 版本不可变 | 只比 `packhub.yaml` 与 `verify.json`，且只在 git 仓库里生效 | 非 git 的 registry 不做不可变检查；归档字节不校验 |
| `state` / `lock` 读取 | 不校验 `apiVersion` 主版本 | 与契约「未知主版本必须拒绝」不一致（manifest 有 schema 兜底） |

（本文其余旧说法已在 2026-11-07 的文档修订中清掉：`packhub://`、私有来源鉴权、版本目录条目、`--to .`、索引 `install` 字段、target 数与动作原语数。）
