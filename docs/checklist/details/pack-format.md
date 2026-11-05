# PKG ｜清单与格式：逐项验收

## 怎么验

| 编号 | 验收动作 | 现状/证据 | 缺口/下一步 |
|---|---|---|---|
| PKG-01 | 在 `packhub.yaml` 里加一个未知键，跑 `pnpm packhub plan .` | 报 `schema` 错误；`additionalProperties:false` | 无 |
| PKG-02 | 分别写六种 `type`，跑 `plan` | 六种都有动作映射；`tool` 解包后在 binDir 生成可执行 wrapper | 无 |
| PKG-03 | 声明 `targets: [dir]`，跑 `install --target codex` | 报“没有声明 target codex” | 全局 target 的声明语义未区分项目/全局 |
| PKG-04 | 两个候选占同一槽位，只绑一个，跑 `plan --json` | 未绑定的进 `excluded`；换 `bindings` 哈希变化 | 单候选槽位无法证明替换价值 |
| PKG-05 | 把 `paths.x` 写成 `../out` 或绝对路径 | `bad-path`，plan 失败 | 无 |
| PKG-06 | 写 `needs` 但无人 `provides` | `unmet-need`；`optional` 资源会跳过；`composition.order` 与 `dependsOn` 矛盾报错 | 无 |
| PKG-07 | 写 `overrides` 改资源 pin | 计划用覆盖后的值，清单上游不变 | 覆盖冲突只在 plan 阶段发现 |
| PKG-08 | 两个 overlay 改同一文件；一个 overlay 盖生成物 | 前者 `overlay-conflict`，后者 `overlay-shadows` 警告 | 覆盖层不能声明“只盖某类文件”的规则 |
| PKG-09 | 不写 `visibility` 发布 | 默认 `private`，`registry:check` 拒绝 | 四档在 Hub/索引侧只实现 public 门禁 |
| PKG-10 | `keygen` + `sign` 后看清单/旁挂文件 | 签名写 `packhub.signatures.json`，不改清单 | 默认不强制，见 TRU-04 |
| PKG-11 | 写 `extends: ../base` 或 `packhub://demo/base@1.0.0` 跑 plan | 本地继承直接合并；远程父包从 registry 取到子包缓存再合并，planHash 稳定；publish 自动扁平化 | 无（编程调用需先 flattenPack） |
| PKG-12 | 写 `targets: [server]` 与资源级 `targets` | server 只物化，不写指令面；未命中资源进 excluded | 裁剪维度只有 target |
| PKG-13 | 在项目放 `.packhub/local.yaml` | 覆盖 pin/绑定/paths/vars/env；不进锁 | 优先级只有“本地覆盖清单” |
| PKG-14 | 放 `PACK.md` / `CHANGELOG.md` 发布 | 复制进版本目录，Hub/市场 API 返回，包页渲染 | 索引不内嵌全文 |
| PKG-15 | 写 `state` 块，在 config/env 里用 `${state.<id>}` | 生成 `state.dir`，默认 `.packhub/state/<id>`；安装建目录，卸载默认保留 | 状态目录内容由资源/Agent 自己管 |

## 结论

格式层已覆盖当前安装语义：`extends`、server profile、本地覆盖、包说明与 `state` 都已兑现，不存在“声明了但没行为”的字段。
