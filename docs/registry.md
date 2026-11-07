# 仓库（registry）

> 把 README「包的制作与发布 / 包市场」、contract §2/§4/§5/§9、authoring「来源 / 可见性」、功能清单 REG/HUB 里关于仓库的描述合并成一份。口径以代码为准（v0.0.1，2026-11-07）；与旧文档对不上的地方在第 9 节逐条列出，不在正文迁就旧说法。

## 1. 三个面

| 面 | 谁 | 做什么 | 不能做什么 |
|---|---|---|---|
| 内容平面 | 静态目录（git / 对象存储 + CDN） | 存版本目录、`.phub` 归档、`index.json`；发布后不可变 | 不执行包、不接收上传 |
| 写平面 | `@packhub/market`（独立服务） | 账号、上传、审核、下架、评分、统计 | 不在服务器上执行上传者的代码 |
| 读平面 | `@packhub/hub`（只读 HTTP）+ CLI | 索引、包页数据、计划预览；`add` / `search` / `update` | 不执行安装 |

三者的交点只有不可变的版本目录与归档；谁写的、谁读的都不改包格式。

## 2. 目录与文件

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

- 归档路径是约定（`packs/<name>/<latest>.phub`），不写进索引；索引里只存相对路径。
- 版本目录放：`publish` 写的清单、锁、报告，加上与 `.phub` 同一批 vendored 条目。
- **不可变检查的真实范围**：`buildIndex` 只把 `packhub.yaml` 与 `verify.json` 与 `git show HEAD` 比（`packages/registry/src/build.ts:109-120`）。registry 不是 git 仓库时这两项**静默跳过**；归档与其他文件的字节不检查。

## 3. 发布（`packhub publish`）

1. `flattenPack`：远程 `extends`、资源级 `packhub://`、包目录外的本地资源展开成自包含目录（`external/…`）。
2. `runPack`：干净临时目录里装一遍 + 跑校验；不是全 `done/noop`、或任一检查非 `pass` 就拒绝（`packages/runner/src/run.ts`）。
3. `lockPack`：解析引用、钉死版本/commit/integrity，按 `metadata.targets` 每个 target 存计划快照。
4. 报告里的 `planHash` 必须与锁一致，否则拒绝（`packages/registry/src/publish.ts:95-99`）。
5. `visibility` 必须是 `public`（`--allow-non-public` 可放宽，但索引门禁仍只收 public，见第 4 节）。
6. 写版本目录与 `<version>.phub`，再重建 `index.json`；索引失败就撤回本次写入；`--force` 覆盖旧版本时先备份、失败可恢复。

发布**不**检查：归档字节是否与上次一致、至少一条校验、`verify` 是否含执行型检查（市场才查）、本地 `extends` 能否自包含（HEAD 不能，见第 8 节）。

## 4. 索引（`index.json`）

字段（`packages/registry/src/build.ts:17-35`）：`name`、`title`、`description`、`latest`、`versions`、`targets`、`trust`、`verifiedAt`、`signers`、`keywords`、`resourceCount`、`install`、`license`、`homepage`、`authors`、`requiresAgent`。

`trust` 两档：

- `verified`：这个包的**所有**版本都有 `verify.json`、`ok: true` 且 `planHash` 与锁一致；
- `community`：其余；有报告但对不上会给 warning，按 community 处理。

门禁（`buildIndex`）：

1. 每个版本目录有 `packhub.yaml`、schema 通过；
2. 有 `packhub.lock.json`，且锁的 `planHash` 与按锁重算的计划一致；声明的每个 target 快照也要一致；
3. `visibility: public`——**unlisted / internal / private 会让整个索引报错**；
4. git 仓库里，清单与 `verify.json` 未被改动。

`install` 字段目前由生成器拼成 `npx packhub add <name>`（`build.ts:239`）。CLI 尚未发布到 npm，这条命令现在装不上包；应改成「按本机 registry 配置用 `packhub add <name>`」，或等 npm 发布后再启用。

多 registry：`--index` 接受路径、URL 或 `~/.packhub/config.json` 里的 `registries[].name`；默认顺序是 `PACKHUB_INDEX` > `defaultRegistry` > 唯一配置项（`packages/runtime/src/config.ts:59-69`）；`search --all` 合并所有配置项。

## 5. 市场（写端）

端点（`packages/market/src/server.ts`）：

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

**实际与文档不一致**：市场声称接受 `unlisted`，但 `publishPack` 的 public 门禁会拒绝它（`publish.ts:77-80`），索引门禁也只收 public。结果：unlisted 既发不进市场，也不能和索引共存——「unlisted 直链分发」目前只对独立 registry（不建索引）成立。

## 6. 读取（Hub）

- 路由：`/api/registry`、`/api/registry/pack`、`/api/registry/resources`、`/api/plan`、`/api/health`。
- 鉴权：只绑回环；对外监听必须配 `--token` / `PACKHUB_HUB_TOKEN` / `--user-header`，否则拒绝启动（fail-closed）。除 `/api/health` 外都要鉴权，接受 `Authorization: Bearer` 或 `x-packhub-token`。
- 限流：每 IP 每分钟 240，超了 429；每次请求写一行审计。
- 缓存：JSON 与静态文件带 ETag / Cache-Control，条件请求 304。
- 部署：静态站必须把 `packs/**/*.phub` 一起发出去，否则 `add` 会 404。

## 7. 来源、鉴权与私有仓库

来源形态：`npm:`、`pypi:`、`github:`、`https:`、`packhub://`、`./`；`add` 另外接受 `.phub` 与 `git+https://`。

私有来源（**这一节替代 authoring.md:451 的旧说法**）：

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
- `packhub pack` 会先 flatten，再按 `--vendored` 打；带本地 `./` 来源却没用 `--vendored` 时应该直接拒绝（当前工作区已加此守卫，HEAD 没有）。
- 缓存按来源落在 `.packhub/cache/`；`packhub cache ls` 标引用、`cache clean [--dry-run]` 只删没被任何已装计划引用的项。
- 离线：`registry:verify-all:offline` / `verify:examples:offline` 会跳过有远程引用的包；`lock --offline` 只处理本地与已 pin 的引用。

## 9. 文档里与本文冲突、应清掉的说法

| 位置 | 旧说法 | 实际 |
|---|---|---|
| authoring.md:430 | `packhub://` 只在 schema 里声明，没有下载实现 | 已实现（ref/extends/extends-remote.test）；同一列表还漏了 `pypi:` |
| authoring.md:451 | 私有仓库鉴权没有支持 | `auth.env` 已实现并实测（第 7 节） |
| authoring.md:534 | 版本目录只要 vendored `resources/`、`fragments/` | 实际是全部顶层条目 |
| contract.md:220-223 | registry 布局只画 `resources/`、`fragments/` | 同上 |
| contract.md:264 | 市场只接受 public / unlisted | unlisted 会被 public 门禁拒绝（第 5 节） |
| contract.md:299-300 | reference 只打清单+锁；vendored 只带 5 个目录 | 还带签名；vendored 带全部顶层条目 |
| contract.md:187 | 版本目录只增不改 | `publish --force` 可覆盖同版本 |
| contract.md:3 | 六份带版本号的 JSON | 版本表 10 行，另有 credentials/trust/baseline/pal 未登记 |
| README.md:245 | `sync --to .` 装到所有支持的目标 | CLI 只接受 dsh/codex/claude-code |
| README.md:173 / build.ts:239 | CLI 未发 npm；索引却给出 `npx packhub add` | 二者只能留一个说法 |
| 系统全量审计.md:76、02-功能树.md:7 | 五个 target（含 server） | 四个 |
| 00-研究范围与方法.md:54-66 | 「仓库搭建」整段未勾 | 索引、发布门禁、不可变、下架、签名、市场都已实现，仅「unlisted 直达」等个别项不成立 |

> 备注：工作区里还有未提交的 `pack`/`flatten`/`publish` 改动（本地来源守卫、包外资源搬入 `external/local`、版本目录与归档同源）。保留时，第 8 节的打包行为按改动后成立；丢弃时按 HEAD 行为成立。
