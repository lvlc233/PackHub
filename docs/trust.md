# 可见性、鉴权与许可

三件事分开管，别混成一个「权限系统」：

| 问题 | 谁负责 | 答案 |
|---|---|---|
| 谁能**看到/拿到**这个包 | 代码托管（GitHub / GitLab / Gitea）的仓库权限 | PackHub 不自建账号，只认「你能 clone 这个 registry 吗」 |
| 装的时候**凭什么下载** | 环境变量 / 本机凭证文件 / git credential helper | manifest 只声明**需要哪个**凭证，绝不写值 |
| 有没有**权利再分发** | 包作者 + registry 审查 | `license` 字段 + vendored 内容的来源许可 |

## 一、可见性：三档，靠分发通道区分

| 档位 | 放在哪 | 谁能装 | 索引 |
|---|---|---|---|
| `public` | 公共 registry（静态 Pages） | 所有人 | 公开 `index.json` |
| `internal` | 公司内网 registry（同一个仓库格式，换个 host） | 有仓库权限的人 | 内网 `index.json` |
| `private` | 只在本地 / 私有仓库，不发布 | 自己 | 无 |

要点：

1. **registry 就是 git 仓库 + `index.json`**，所以「内网 registry」不是一个新系统，只是把同样的目录放到公司的 GitLab 上。PackHub 不区分，只认 URL。
2. **默认 `private`**，要发布必须显式写 `visibility: public`。默认公开迟早会泄露一次。
3. 静态索引没法做「部分可见」：内网 registry 的索引对能访问的人就是全量。真要做细粒度，得靠 git 仓库的分支/权限，不要在 PackHub 里发明 ACL。

## 二、鉴权：只声明，不保存

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

## 四、信任：verified 之外再加 signature（未实装）

`verified` 只证明「在干净环境装得上、校验过」，不证明「这是谁发的」。内网场景需要后者：

- `packhub publish` 用 minisign 签 manifest 的哈希；
- registry 配置里列允许的签名公钥；
- `install` 时校验签名，签名者不在允许列表就拒绝（或降级为需要 `--allow-unverified`）。

不在 0.x 范围内，但 schema 里预留 `signatures` 字段，避免以后破坏格式。

## 五、配置放哪

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

## 六、这次要落的最小实现

1. schema 加 `metadata.visibility`（默认 `private`）与 `resources[].auth`（只存变量名）。
2. 下载时按 `auth` 取环境变量拼请求头；401/403 报错指名变量；错误信息脱敏。
3. 测试：本地 http 服务校验 Authorization；缺凭证时错误信息包含变量名；带 token 但 401 时不打印 token。
4. 文档：上面这套写进 `authoring.md` 的来源一节。

签名、license 自动检查、内网 registry 示例，留给后续。
