import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
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
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
