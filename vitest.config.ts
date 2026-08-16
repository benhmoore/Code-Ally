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
      // Floors just below where coverage stands today, raised deliberately as
      // it improves. NOT `autoUpdate: true`: that re-arms each threshold at the
      // exact measured value every run, and coverage moves by ~0.01% run to run
      // (tests run in parallel and some paths are timing-dependent), so the
      // build failed on noise. A gate that cries wolf gets switched off.
      //
      // Whole numbers give roughly half a point of headroom — far below any
      // real regression, far above the jitter. These are also ratios, so
      // deleting a well-tested module lowers them without any code getting
      // worse; re-baseline in one commit and say so when that happens.
      thresholds: {
        lines: 42,
        functions: 68,
        branches: 73,
        statements: 42,
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