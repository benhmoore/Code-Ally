import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',

    // Prevent resource leaks
    pool: 'forks',
    poolOptions: {
      forks: {
        singleFork: false,
      },
    },

    // Set reasonable timeouts
    testTimeout: 15000,
    hookTimeout: 10000,

    // Limit parallelism
    fileParallelism: 4,
    maxConcurrency: 5,
  },
  resolve: {
    alias: {
      '@agent': resolve(__dirname, './src/agent'),
      '@agents': resolve(__dirname, './src/agents'),
      '@services': resolve(__dirname, './src/services'),
      '@tools': resolve(__dirname, './src/tools'),
      '@utils': resolve(__dirname, './src/utils'),
      '@config': resolve(__dirname, './src/config'),
      '@llm': resolve(__dirname, './src/llm'),
      '@security': resolve(__dirname, './src/security'),
      '@checkers': resolve(__dirname, './src/checkers'),
      '@plugins': resolve(__dirname, './src/plugins'),
      '@ui': resolve(__dirname, './src/ui'),
      '@shared': resolve(__dirname, './src/types'),
      '@cli': resolve(__dirname, './src/cli'),
    },
  },
});
