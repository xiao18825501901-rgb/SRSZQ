import { defineConfig } from 'vitest/config';

// SRSZQ monorepo 单测：shared（引擎/AI）+ backend（在线流程）均在 node 环境运行
export default defineConfig({
  test: {
    environment: 'node',
    include: ['shared/src/**/*.test.ts', 'backend/src/**/*.test.ts', 'backend/src/**/*.spec.ts'],
  },
});
