1. 制作 启动器PAL []


1. PackHub需要确保客户端的Agent Harness能够启用整合包;
  被动校验?主动校验
2. 
## Pack
Pack是PackHub的最小操作单元。
{它拥有?版本锁、安装计划、状态记录和验证报告。}
它包含一份清单包括
  - 哪些都有资源
  - 怎么下载哪些资源
  - 装完怎么验?

PackHub有Plan的概念



==todo
所以这里算bug吗?还是产品遗漏?
03:57

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