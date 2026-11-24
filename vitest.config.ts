import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/**/test/**/*.test.ts', 'apps/**/test/**/*.test.ts'],
    environment: 'node',
    // 端到端用例会起服务、跑真安装；并发跑全量时 5s 默认值不够，20s 在机器忙时也会超
    // （同一份用例空载 4s、满载能到 20s+）。超时不是产品失败，给足余量。
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
