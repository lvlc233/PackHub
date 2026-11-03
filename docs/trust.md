# 可见性、鉴权与许可

1. packhub本体开源，提供自部署机制，部署后可以配置公开或白名单权限，相关连接需要部署者维护配置。
2. pack的一个pack具有也具有公开隐藏机制[tokne?密码?白名单?]
3. pack的资源项可能不一定公开,因此需要在配置中设定有鉴权，使客户端可以自行通过验证配置安全审核。-->暗示分多端。


## 一、可见性：四档，靠分发通道与索引区分

| 档位 | 放在哪 | 谁能装 | 索引 |
|---|---|---|---|
| `public` | 公共 registry（静态 Pages） | 所有人 | 公开 `index.json` |
| `unlisted` | 同一 registry，但**不进索引** | 知道确切包名（+ token）的人 | 无 |
| `internal` | 公司内网 registry（同一格式，换个 host） | 有仓库权限的人 | 内网 `index.json` |
| `private` | 只在本地 / 私有仓库，不发布 | 自己 | 无 |

`unlisted` 是"分享链接"的等价物：不需要知道用户是谁，只需要他知道包名。白名单做不到——那需要身份源，交给 Hub 前置的网关。

要点：

1. **registry 就是 git 仓库 + `index.json`**，所以「内网 registry」不是一个新系统，只是把同样的目录放到公司的 GitLab 上。PackHub 不区分，只认 URL。
2. **默认 `private`**，要进公共索引必须显式写 `visibility: public`；`registry:check` 会拒绝非 public 的包。默认公开迟早会泄露一次。
3. 静态索引没法做「部分可见」：内网 registry 的索引对能访问的人就是全量。真要做细粒度，得靠 git 仓库的分支/权限，不要在 PackHub 里发明 ACL。

## 二、鉴权：只声明，不保存（客户端直连为默认，Hub 代取可选）

### manifest 里写「需要什么」，不写「是什么」

```yaml
- id: internal-rules
  type: skill
  source: https://gitlab.corp.example/g/agent/rules/-/archive/abc123/rules-abc123.tar.gz
  integrity: sha256-…
  auth:
    env: GITLAB_TOKEN        # 从哪个环境变量取
    scheme: bearer           # bearer | token | basic
```

- `auth.env` 只是**变量名**。清单会进 registry、会被别人看到，写值等于泄漏。
- 缺凭证时的报错必须指名变量：`需要 GITLAB_TOKEN 才能下载 gitlab.corp.example/…（未设置）`。
- `lock.json`、`state.json`、`verify.json`、缓存目录，**任何一处都不得出现凭证**；报错信息里的 URL 要脱敏（只留 host + path）。

### 凭证从哪来（优先级从高到低）

1. 进程环境变量（CI 里最自然）：`GITLAB_TOKEN=… packhub install`
2. 本机凭证文件 `~/.packhub/credentials.json`（`0600`，不进版本库）：`{ "GITLAB_TOKEN": "…" }`
3. git credential helper（HTTPS 克隆场景，需要时再读）

### 两种取法：客户端直连 / Hub 代取

- **客户端直连（默认）**：凭证在目标机器上（环境变量），Hub 从不接触密钥。适合开发者本机与 CI。
- **Hub 代取（可选，部署者开启）**：Hub 持有资源凭证，客户端只跟 Hub 认证一次。适合内网，资源地址甚至可以不暴露。代价是 Hub 变成密钥保管处，安全责任集中，默认不开。

### 一个已知的硬边界

现在从 git 仓库直接拉**单个私有文件**没有好方案（GitHub/GitLab 的 raw 端点要 token，tarball 端点也要）。所以私有内容的推荐做法只有两条：

- 打成 archive 用 `https + auth` 下载（上面那样）；
- 或者直接 **vendored 进包**，包本身放内网 registry——装的人只需要能访问内网 registry，不需要各自的仓库 token。

## 三、许可与再分发

`vendored` 会把别人的内容复制进你的包。所以发布前要能回答：

1. 包里每个资源的上游许可是什么？（`license` 字段目前只有包级，资源级还没做）
2. 上游许可允许再分发吗？（MIT/CC-BY 一般可以，带 `NonCommercial`、`NoDerivatives` 的不行）
3. 包自己的许可（`metadata.license`）是否覆盖了 vendored 内容？冲突时以更严格者为准。

现在只做到了「包级 license 字段 + 文档提醒」，**没有自动检查**。计划里加一条 `license-check` 探针：vendored 资源的来源仓库里若有 `LICENSE`，抓下来判断是否允许再分发；不允许就报错。这条不急，但必须在「有人开始 vendored 别人的 skill」之前有。

## 四、Hub 的职责边界

Hub **不内置 runner**。验证交给一次性容器（CI 或临时 job）：容器里跑 `install + verify`，产出 `verify.json`，Hub 只消费报告。理由很直接——Hub 面向公网，不能执行别人写的 `exec` 与脚本。

Hub 也**不自建账号**：身份来自部署层（反向代理、SSO、静态 token 白名单），Hub 只消费身份头或 bearer token。真正的执行面（验证 runner、目标机器上的同步 agent）都在 hub-runtime 里，见 [deployment.md](deployment.md)。

## 五、信任：verified 之外再加 signature（未实装）

`verified` 只证明「在干净环境装得上、校验过」，不证明「这是谁发的」。内网场景需要后者：

- `packhub publish` 用 minisign 签 manifest 的哈希；
- registry 配置里列允许的签名公钥；
- `install` 时校验签名，签名者不在允许列表就拒绝（或降级为需要 `--allow-unverified`）。

不在 0.x 范围内，但 schema 里预留 `signatures` 字段，避免以后破坏格式。

## 六、配置放哪

```jsonc
// ~/.packhub/config.json（本机，所有项目共用）
{
  "registries": [
    { "name": "public", "url": "https://packhub.dev/index.json" },
    { "name": "corp", "url": "https://gitlab.corp.example/agent/registry/-/raw/main/index.json",
      "tokenEnv": "GITLAB_TOKEN", "trust": ["corp-release-2026"] }
  ],
  "defaultRegistry": "corp"
}
```

- 清单里不写 registry 地址；`packhub add corp/code-review` 的 `corp` 前缀解析到配置里的 registry。
- 私有 registry 的 token 只在本机配置/环境里，不进包、不进锁。

## 七、实现状态

已做：

1. `metadata.visibility` 四档（`public` / `unlisted` / `internal` / `private`），默认 `private`；`registry:check` 只放行 `public`。
2. `resources[].auth` 只存变量名与 scheme；下载时从环境变量取 token 拼请求头，401/403 报错指名变量，日志与报错都不含 token，URL 只留 host + path。
3. 测试：本地 http 服务校验 Authorization（注入 / 缺变量 / 401 不泄漏 / 枚举校验）。

未做（按优先级）：

1. ~~`unlisted` 的取包路径~~ ——已实装：`add scope/name --version x.y.z` 允许绕过索引直接取归档。
2. 签名（minisign / sigstore）：`verified` 只证明装得上，不证明谁发的。
3. 许可自动检查：`vendored` 会复制别人的内容，上游 `NonCommercial` / `NoDerivatives` 不能这么干，现在只有文档提醒。
4. 资源级 license 字段（现在只有包级）。

Hub 侧的执行面（验证 runner、同步 agent）不在这一层，见 [deployment.md](deployment.md)。
