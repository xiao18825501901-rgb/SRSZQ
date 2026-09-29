import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// SRSZQ frontend（@srszq/frontend）—— monorepo 中引用 shared 源码
const sharedSrc = fileURLToPath(new URL('../../shared/src', import.meta.url));

// 构建期源码标识：把“这一份前端产物是哪次提交构建的”写进 bundle。
// Netlify 对 GitHub 构建会注入 COMMIT_REF；本地/CI 回落到 GITHUB_SHA / VITE_SOURCE_SHA。
// 用途（B7 封版口径）：管理台可以同时显示后端 source sha 与前端构建 sha，
// 从而用同一个提交对账“Netlify 上的前端”和“VPS 上的后端”，无需人工比对文件名。
const sourceSha =
  process.env.COMMIT_REF?.trim()
  || process.env.GITHUB_SHA?.trim()
  || process.env.VITE_SOURCE_SHA?.trim()
  || 'unknown';

export default defineConfig({
  define: { __SRSZQ_SOURCE_SHA__: JSON.stringify(sourceSha) },
  plugins: [react()],
  resolve: {
    alias: [
      // @srszq/shared/game/rules → <repo>/shared/src/game/rules（Vite 自动补 .ts）
      { find: /^@srszq\/shared\/(.+)$/, replacement: `${sharedSrc}/$1` },
    ],
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    // 允许访问 workspace 内 shared/（monorepo 源码直引）
    fs: { allow: [fileURLToPath(new URL('../..', import.meta.url))] },
    watch: {
      // Windows 上编辑器原子替换（*.tmp 临时文件）会触发 chokidar EBUSY 崩溃，
      // 使用轮询并忽略临时文件避免
      usePolling: true,
      interval: 150,
      ignored: ['**/*.tmp', '**/.e2e.cjs*/**', '**/.*.tmpdir/**'],
    },
  },
  preview: {
    host: '127.0.0.1',
    port: 4173,
  },
});
