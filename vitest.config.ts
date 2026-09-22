import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
      '@deerflow-harness': path.resolve(__dirname, 'src/deerflow-harness'),
    },
  },
  test: {
    environment: 'node',
    // 测试文件约定在 src 各目录的 __tests__/ 子目录（与被测代码同域、不同层）
    include: ['src/**/__tests__/**/*.test.ts'],
  },
});
