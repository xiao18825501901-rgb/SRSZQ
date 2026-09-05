import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// SRSZQ frontend（@srszq/frontend）—— monorepo 中引用 shared 源码
const sharedSrc = fileURLToPath(new URL('../../shared/src', import.meta.url));
export default defineConfig({
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
