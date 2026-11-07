import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/**/test/**/*.test.ts', 'apps/**/test/**/*.test.ts'],
    environment: 'node',
    // 端到端用例会起服务、跑真安装；并发跑全量时 5s 默认值不够，超时不是产品失败
    testTimeout: 20_000,
  },
});
