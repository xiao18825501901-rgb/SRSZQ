import { defineConfig } from 'vitest/config';

// SRSZQ monorepo 单测：shared（引擎/AI）+ backend（在线流程）+ frontend 纯模型层
// （BAC 时间线模型等无 DOM 依赖的 node 环境用例）
export default defineConfig({
  test: {
    environment: 'node',
    include: [
      'shared/src/**/*.test.ts',
      'backend/src/**/*.test.ts',
      'backend/src/**/*.spec.ts',
      'frontend/src/**/*.test.ts',
    ],
  },
});
