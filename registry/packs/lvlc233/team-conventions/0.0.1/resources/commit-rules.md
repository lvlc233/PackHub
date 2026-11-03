---description: 生成符合团队约定的提交信息
---

请按以下规则生成提交信息：

1. 格式：`type(scope): summary`
2. type 取值：feat / fix / docs / refactor / test / chore
3. summary 使用祈使句、不超过 50 字符、结尾不加句号
4. 正文说明「为什么改」，不复述「改了什么」

输入：本次改动的 diff 摘要。
输出：只输出提交信息本身，不要解释。
