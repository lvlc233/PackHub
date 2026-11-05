# registry、发布与信任

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
- 版本目录不可变：`git show HEAD:./packs/...` 与当前文件比较；
- `verify.json` 的 `planHash` 与计划一致且 `ok`。

四项都成立才给 `trust: verified`；其余 `community`。`index.json` 是生成物，不手写。

## 签名

- `keygen` 生成 ed25519；私钥 0600。
- `sign` 签 `{pack@version, planHash}`，写入 `packhub.signatures.json`，不改 manifest。
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

- 没有多 registry 选择/优先级；只有 `PACKHUB_INDEX` 或一个默认索引。
- 没有下架/撤回流程；版本不可变与下架需要 tombstone 或可见性标记。
- 市场元数据（下载量、评分、审核状态）没有；索引只有包与版本。
- 签名默认不强制，信任列表没有持久配置。
