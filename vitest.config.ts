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
    // 只跑 src 下的单测；benchmarks / e2e 不纳入 pnpm test
    include: ['src/**/*.test.ts'],
  },
});
