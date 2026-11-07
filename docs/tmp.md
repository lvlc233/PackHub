

已完成
已完成，用时 2分29秒
分开看，这三种都有，但只有一处是明确 bug。

一、明确 bug：packhub pack 不检查本地来源。 我实测了 examples/doc-review（四条资源全是 ./）：

代码块


✓ tmp\dr.phub（2 KB）
包含：packhub.yaml、packhub.lock.json（reference 模式，装的时候要联网取资源）
归档里真就只有这两个文件，resources/、skills/ 全不在。而提示语里的“装的时候要联网取资源”对本地来源是假的——./resources/review-rubric.md 既不在归档里也不在网络上，装到 write 那步就会 ENOENT，然后回滚。也就是说这个命令会产出一个必然装不上、当场不报错的文件，还附一句误导。修法很小：packArchive 里扫一遍有没有 ./ 来源，有就要求 --vendored，或者至少把提示语换成“这个包里还有本地资源，没带 --vendored 装不上”。

二、门禁漏洞，算半个 bug：版本目录只拷五个目录，但没人校验资源是否落在里面。 publish.ts 第 146 行拷的是 resources、fragments、overrides、skills、glue；.phub 却是按顶层条目全量打（pack.ts 36-42）。一个把说明放在 assets/ 的包能过 publish（publish 在原目录跑 run，文件都在），版本目录缺文件，之后 registry:verify-all 从版本目录装才失败——失败被推后到 CI。这条是我读代码推的，没有真造一个包去跑。文档侧也对不齐：authoring.md 第 457、548 行只写 resources/、fragments/，实现拷五个，dist/ 又一律跳过，这三处口径不一样。

三、产品遗漏，不是 bug：本地来源跨机器没有字节校验。 锁里 integrity: null（这是刻意的，注释写了“不假装锁住”）、fetchPack 下载归档不传 expected integrity、签名只覆盖清单与 planHash。合起来的事实是“registry 即信任”，但这句话没有出现在任何文档里，而周边文案（锁、签名、完整性）很容易让人以为字节也被保护了。要不要补，是产品决定：给归档加一条哈希进索引，或让 publish 把本地资源的 sha256 写进锁——两种都不难，但要先决定信任模型。

顺序上我建议先修第一条，它不需要任何设计决定，且今
==

==需优化
打包没有完全考虑到自动发送远程的事情，项目目前仅仅只是打包，远程分发被设计成「静态文件 + 一套约定」，没有去接现成的包生态（npm、GitHub Releases、OCI、任何 registry API）。
README.md:110：Hub 是静态仓库与只读站点，“不执行包，也不接收安装请求”。
README.md:448 与 README.md:459：市场拆内容平面/市场平面；服务端不跑上传者的代码，带 install.exec、command、mcp-ready 的包直接拒绝——这是唯一一条明确写出来的理由（安全）。
README.md:270：静态站必须把 packs/**/*.phub 一起发布，否则 404——说明分发的形态就是文件加约定。
README.md:290：npx packhub 依赖发布到 npm 的 CLI，“本仓库当前从源码运行”；PackHub-功能全量清单.md:225 把 CLI 未发 npm 标成 [na]。也就是说 npm 这条线指的是这个工具自己还没上，不是包。
contract.md:247：Hub 保持只读，写操作在独立服务里，包格式不变。
registry-trust.md:63：Pages/CDN 的部署方式。
trust.md:21：“当前定位是开发者工具，不是托管平台；密钥轮换与组织级分发仍留给市场平面。”
==


==
接线的内容是否存在过度?
==

==
清单:接线

composition:
  needs:
    - capability: skill:doc_review
      requires: [doc:lint, knowledge:review_rubric, prompt:reader_brief]
      bind: doc-review

存在冗余性;这个字段，它的判定全都能从资源级推出来。计划删除
==

==
资源级的顺序就是 dependsOn，它是局部的边。优先级是三层：

写了 composition.order → 以它为准。这时 dependsOn 不再参与排序，只用来查冲突；未在 order 里列出的资源按清单顺序追加到尾部。
没写 order → 按 dependsOn 做拓扑排序，没有依赖关系的资源按清单顺序排。
两者都没有 → 纯清单顺序。
但这里有个真实缺口，我刚测了。清单是 a、b，b dependsOn a，而 composition.order 只写了 [b]（a 没列）：

代码块


write#1          write          .packhub/knowledge/b.md
write#2          write          .packhub/knowledge/a.md
b 排到了它依赖的 a 前面，没有报错。

原因是冲突检查只在“两边都出现在 order 里”时才比位置：order-violates-dependency 的判断要求 dependsOn 的两端都能在 order 里找到下标，找不到就跳过。于是部分声明 order 时，dependsOn 的保证会被静默丢掉——既没排序，也没报错。

所以这条规则实际是：order 要么列全，要么别写。 只写一部分比不写更危险，因为你以为依赖还有效，实际已经失效了。
==似乎存在bug


==
| `paths` | 包 | `{ 名: 相对路径 }` | 包统一路径表，资源里用 `${paths.名}` 引用 | `bad-path`（绝对路径或含 `..`） |

计划移除,因为似乎和vars重复在功能上
==

==安装命令
| `target.server` | 只物化到 `.packhub/`，不写宿主指令面；给 CI / 容器 |

疑似不存在任何差异、拟定移除。
==

==需要优化
问题不在“target”这个词好不好，而在这个轴混了两件事。

现在的五个值其实是两根轴：

落给谁：dsh、codex、claude-code——决定配置写哪、指令文件叫什么、skills 放哪。
装成什么形态：dir（项目内物化）、server（容器物化）——决定要不要碰宿主指令面。
==

==
安装的时候，dir和server似乎有点多余
删除server
==

==
安装的时候如果不指定 --tagger或pack本身没有指定,那么它首先会直接默认的方式安装。

==

==
packhub的全局安装不应该只有skill和mcp
==

==
PackHub 目前缺少对资源间协作关系的表达机制，尚无法定义不同资源如何分工、配合、相互约束并共同形成整体能力，而不仅仅是完成依赖、配置与集成。
==



==
| 编号 | 验收动作 | 现状/证据 | 缺口/下一步 |
|---|---|---|---|
| HUB-01 | `curl /api/registry` `/api/registry/pack` | 200，只读 | 无写/安装接口 |
| HUB-03 | `POST /api/plan` 传草稿 | 返回计划；不落盘；1 MB body 上限 | 依赖服务端 `packDir`，overlay 遍历需限界 |
| HUB-04 | `packhub hub . --host 0.0.0.0` 不带 token | 拒绝启动 | 需要部署层配 token/身份头 |
| HUB-05 | 高频请求 | 429 + `retry-after` | 限流按内存，重启清零 |
| HUB-06 | 配 `--audit logs.jsonl` 请求一次 | 一行 JSON：时间/IP/用户/方法/路径/状态 | 没有日志轮转 |
| HUB-09 | `docker build` | 只读端镜像，CMD 起 hub | 镜像包含开发依赖 |
| HUB-10 | 找上传/发布接口 | Hub 没有；写端在 `@packhub/market` | 市场是独立进程 |
| HUB-11 | 找账号/组织 | 市场账号即 scope，token 认证 | 没有组织/成员 |
| HUB-12 | 找搜索/统计 | 市场 `/api/search` 带下载量、趋势、评分/评论 | 没有组织/成员 |
| CLI-04 | 用不存在的包/错误 target | 0 成功 / 1 业务失败 / 2 用法与校验；缺清单/坏 target/校验失败有测试 | 位置参数写成 `--dir` 会直接报未知参数（避免静默跑在 cwd） |
| CLI-05 | `init` / `resource add` / `slot swap` | 保留注释；重名加后缀；swap 只改一行 | 不推断 type |
| CLI-06 | `discover` 关键词 | 搜资源目录/npm，`--add` 直接写清单；`search --all` 跨 registry | 目录需要作者维护 |
| CLI-07 | `auth set/list/remove/rotate` | 凭据库 0600；环境变量优先 | 无 token 轮换策略 |
| CLI-08 | `rollback` / `uninstall` / `update` / `versions` / `activate` | 都能跑；update 清旧产物，activate 整版切换 | 版本镜像用硬链接共享字节，不支持时复制 |
| CLI-09 | `sync --to dsh,codex,claude-code` | skills + AGENTS/CLAUDE + codex TOML MCP；dry-run/remove | DSH/Claude 全局 MCP 无 adapter |
| CLI-12 | `packhub --version` | 0.0.1；未发布 npm，自更新无渠道（设计边界） | 发 npm 后再做 |
| TRU-01 | `keygen` → `sign` → `verify-sig` | ed25519 签 `{pack@version,planHash}`，可验；远程引用按扁平化计划签验 | 无密钥托管/轮换 |
| TRU-02 | 看私钥文件权限 | keygen 以 0600 写（POSIX） | Windows 权限语义弱 |
| TRU-03 | `sign` 后看清单 | 签名写 `packhub.signatures.json`，不改 manifest | 版本目录不可变因此受益 |
| TRU-04 | `add` 一个无签名包 | 有信任列表就强制；`--allow-unsigned` 显式降级；trust.json 可设 requireSignature | 无签名仍是默认放行 |
| TRU-05 | `packhub trust add/remove/list` | 持久列表，安装默认使用 | 无组织级分发 |
| TRU-06 | `auth set` 后 `auth list` | 掩码；env 优先；0600 | 无轮换/过期 |
| TRU-07 | 401 下载失败 | 报错指名变量；URL 去查询串 | 第三方日志可能泄漏 |
| TRU-08 | `licenses` 扫本地资源 | 本地猜 SPDX；`--online` 读 npm registry license | github/https 仍看不到 |
| TRU-09 | vendored GPL 内容 | 策略 JSON：allow/deny/copyleft/NC/ND/requireSpdx | 不做法律解释 |
| TRU-10 | `visibility: private` 发布 | registry 门禁拒绝 | unlisted/internal 分发靠 URL/内网 |
| TRU-11 | 安装操作审计 | add/install/update 写 `~/.packhub/audit.jsonl`，`packhub audit` 查看 | 没有轮转与签名 |
| PKG-03 | 声明 `targets: [dir]`，跑 `install --target codex` | 报“没有声明 target codex” | 全局 target 的声明语义未区分项目/全局 |
| PKG-04 | 两个候选占同一槽位，只绑一个，跑 `plan --json` | 未绑定的进 `excluded`；换 `bindings` 哈希变化 | 单候选槽位无法证明替换价值 |
| PKG-07 | 写 `overrides` 改资源 pin | 计划用覆盖后的值，清单上游不变 | 覆盖冲突只在 plan 阶段发现 |
| PKG-08 | 两个 overlay 改同一文件；一个 overlay 盖生成物 | 前者 `overlay-conflict`，后者 `overlay-shadows` 警告 | 覆盖层不能声明“只盖某类文件”的规则 |
| PKG-09 | 不写 `visibility` 发布 | 默认 `private`，`registry:check` 拒绝 | 四档在 Hub/索引侧只实现 public 门禁 |
| PKG-11 | 写 `extends: ../base` 或 `packhub://demo/base@1.0.0` 跑 plan | 本地继承直接合并；远程父包从 registry 取到子包缓存再合并，planHash 稳定；publish 自动扁平化 | 无（编程调用需先 flattenPack） |
| PKG-12 | 声明 `targets: [dir, dsh]`，给某条资源写 `targets: [dir]` | dsh 上该资源进 excluded；dir 上两条都装 | 裁剪维度只有 target |
| PKG-13 | 在项目放 `.packhub/local.yaml` | 覆盖 pin/绑定/vars/env；不进锁 | 优先级只有“本地覆盖清单” |
| PKG-14 | 放 `PACK.md` / `CHANGELOG.md` 发布 | 复制进版本目录，Hub/市场 API 返回，包页渲染 | 索引不内嵌全文 |
| PKG-15 | 写 `state` 块，在 config/env 里用 `${state.<id>}` | 生成 `state.dir`，默认 `.packhub/state/<id>`；安装建目录，卸载默认保留 | 状态目录内容由资源/Agent 自己管 |
| PLN-01 | 构造含六类资源 + overlay + exec 的包 | 十种动作都能生成（含 `link.bin` / `state.dir`）；`instruction` 在 dsh/codex/claude 下自动追加 | `probe` 不是 plan 动作 |
| PLN-03 | 写 `dependsOn` 成环；写 `composition.order` 与依赖矛盾 | `dependency-cycle` / `order-violates-dependency` | 顺序算法只做拓扑，不并行 |
| PLN-04 | 写 `needs` 无提供方 | `unmet-need` | 能力名没有集中注册表 |
| PLN-05 | 槽位两个候选只绑一个 | 未绑定进 `excluded`；动作里没有 | 单候选无法演示 swap |
| PLN-06 | 两动作写同一文件；两 config 改同一键；overlay 盖生成物 | 前两者 error，最后 warning | 跨包冲突不在 plan 内 |
| PLN-07 | 两台机器跑同一清单（同 target） | `planHash` 一致；实测 Windows 与 registry 记录一致 | 依赖 Node 的 JSON 规范化，无版本号 |
| PLN-08 | `lock --target dsh` 后看 lock | 每个声明的 target 各有一份 `plans` 快照；主快照由 `--target` 指定 | 旧锁只有一份快照 |
| PLN-09 | 在 verify/args/config 里用 `${target.*}` | 插值生效；未知 target 报错 | 可用变量没有集中文档清单 |
| PLN-13 | `target: server` 与资源级 `targets` | 未命中资源进 `excluded`（`target-mismatch`）；server 不写指令面 | 只有这一种裁剪维度 |
| PLN-11 | `POST /api/plan` 草稿 | 返回 plan + issues，不落盘 | 与 CLI 共用 buildPlan，但 target 校验在 planFor |
| PLN-12 | `install --dry-run` / `add --dry-run` | 不写项目；`add` 取包在临时目录 | dry-run 仍可能访问网络 |
| REF-02 | 写 `@main`、`@latest`、`^1.0.0`、无 integrity 的 https | plan 阶段分别报 `unpinned-source` / `http-missing-integrity` | 规则在 `ref.ts`，测试覆盖 |
| REF-03 | `packhub lock` 后看 `resolved[]` | 分支→commit、范围→版本、https→sha256、pypi→sdist | 解析失败只 warn，锁保留 null |
| REF-04 | 下载 npm/https 后看 `integrity` | npm 用 `dist.integrity`；https 下载时算 sha256；github 用 commit 的 tarball 算 sha256 | 大仓库 lock 会多一次下载 |
| REF-05 | 私有 https 配 `auth.env`，不设变量安装 | 报错指名变量；设环境变量或 `auth set` 后成功 | 没有 token 轮换策略 |
| REF-06 | `lock` 后 `diff` | lock 带主 `plan` 与每个 target 的 `plans` 快照，diff 按本次 target 比 | 旧锁只有一份快照 |
| REF-07 | `lock --offline` | 不联网，未解析项保留并 warn | 没有“部分联网”模式 |
| REF-08 | `pypi:` 纯 wheel 包 | 明确拒绝，只收 sdist | wheel 解包未做 |
| REF-09 | `packhub://scope/name@ver#path` | 资源级引用取归档内文件/目录到缓存并改写成本地路径；`add` 等价 registry 安装；publish 自动扁平化 | lock 要求先 vendored |
| REF-10 | 多次安装后看 `.packhub/cache` | `cache ls` 标引用，`cache clean [--dry-run]` 只删无引用项 | 没有按时间/大小策略 |
| REF-11 | 设 `HTTPS_PROXY` 拉索引/下载 | 下载与索引请求走代理 | 第三方脚本不继承 |
| REF-12 | 锁后改清单再 `add` | 有 `plans[target]` 时报目标计划不一致；旧锁报 `lock-mismatch`；`diff` 能看出差异 | 没有自动重锁提示 |
==