# registry、发布与信任[待更新]

## 版本目录

```
registry/
├── index.json
└── packs/<scope>/<name>/
    ├── <version>.phub
    └── <version>/
        ├── packhub.yaml
        ├── packhub.lock.json
        ├── packhub.signatures.json
        ├── verify.json
        ├── resources/
        ├── fragments/
        ├── overrides/
        ├── skills/
        └── glue/
```

`publishPack` 只写 `packhub.yaml` / lock / signatures，再把 vendored 目录复制进去；`.phub` 是 vendored 归档，离线可装。

## 发布流程

1. 清单校验。
2. `runPack` 在干净目录 install + verify；不 ok 拒绝。
3. `lockPack` 解析引用，比较报告与锁的 `planHash`。
4. 写版本目录 + 归档。
5. 调 `writeIndex` 重新生成 `index.json`。

已存在的版本目录默认拒绝覆盖，必须发新版本；`--force` 仅用于明确知道后果时。

## 索引门禁

`buildIndex` 对每个版本：

- 清单 schema / pin / 图校验；
- 锁存在且 `lock.planHash` 与按锁重算的计划一致（`withLockPins`）；
- `metadata.visibility === 'public'`；
- 版本目录不可变：`git show HEAD:./packs/...` 与当前文件比较（`packhub.yaml` 与 `verify.json` 都不许改）；
- `verify.json` 的 `planHash` 与计划一致且 `ok`。CI 复核用 `verify-pack --out <临时文件>`，不写回版本目录。

四项都成立才给 `trust: verified`；其余 `community`。`index.json` 是生成物，不手写。

## 签名

- `keygen` 生成 ed25519；私钥 0600。
- `sign` 签 `{pack@version, planHash}`，写入 `packhub.signatures.json`，不改 manifest；含远程引用时按发布扁平化后的计划签。
- `verify-sig` 校验；`--trusted` 只接受列表里的公钥 id。
- `runPack` 把签名结果写进报告；索引 `signers` 汇总。
- 默认安装只提示，`--require-signature` 才拒绝。**verified 不证明是谁发的**，签名才回答来源。

## 可见性

`metadata.visibility`：`public` / `unlisted` / `internal` / `private`，默认 `private`。

- `public` 才进公共索引；
- `unlisted` 不进索引，但 `add name --version --index <same>` 可直接取归档；
- `internal` 放内网 registry，同一格式；
- `private` 不发布。

## Pages / CDN

CI 把 `index.json` 与 `packs/**/*.phub` 一起作为站点产物；只传索引会让安装命令 404。Hub 只读，部署层做鉴权/限流/审计。

## 缺口

- 市场写端是单机 SQLite（WAL；旧 `.market/db.json` 自动导入），没有多实例与计费；管理前端是市场自带的 `/admin` 页。
- 签名默认不强制，由信任列表 / `requireSignature` 决定；密钥轮换留给市场平面。
- 生产部署应把发布校验放进沙箱，或只收 CI 报告。
