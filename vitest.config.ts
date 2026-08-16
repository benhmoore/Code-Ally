import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',

    // Grants the system temp dir to path authorization; see the file for why
    // this is explicit setup rather than an env-var check inside PathSecurity.
    setupFiles: ['./vitest.setup.ts'],

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

    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'lcov'],
      include: ['src/**'],
      exclude: ['src/**/__tests__/**', 'src/agents/**', 'dist/**'],
      // A ratchet rather than a hand-picked target: vitest writes the measured
      // numbers back into this file, so coverage can never regress below where
      // it stands today, and rises as tests are added. Hand-picked thresholds
      // would either fail immediately or be too slack to mean anything.
      thresholds: {
        autoUpdate: true,
        lines: 42.52,
        functions: 68.28,
        branches: 73.2,
        statements: 42.52,
      },
    },
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
      '@marketplace': resolve(__dirname, './src/marketplace'),
      '@mcp': resolve(__dirname, './src/mcp'),
      '@ui': resolve(__dirname, './src/ui'),
      '@shared': resolve(__dirname, './src/types'),
      '@cli': resolve(__dirname, './src/cli'),
    },
  },
});