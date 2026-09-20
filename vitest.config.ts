import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',

    // Grants the system temp dir to path authorization; see the file for why
    // this is explicit setup rather than an env-var check inside PathSecurity.
    setupFiles: ['./vitest.setup.ts'],

    // Agent worktrees hold whole checkouts of this repo. Without this the
    // runner collects their tests too and reports another branch's state as
    // this one's.
    exclude: ['**/node_modules/**', '**/dist/**', '.claude/worktrees/**'],

    // Prevent resource leaks
    pool: 'forks',

    // Set reasonable timeouts
    testTimeout: 15000,
    hookTimeout: 10000,

    // Limit parallelism
    maxWorkers: 4,
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
      //
      // Last re-baselined for Vitest 5, whose AST-based V8 remapping counts
      // functions and branches differently from the v8-to-istanbul mapping
      // these floors were first measured under.
      thresholds: {
        lines: 53,
        functions: 57,
        branches: 45,
        statements: 52,
      },
    },
  },
  resolve: {
    alias: {
      '@agent': resolve(import.meta.dirname, './src/agent'),
      '@agents': resolve(import.meta.dirname, './src/agents'),
      '@services': resolve(import.meta.dirname, './src/services'),
      '@tools': resolve(import.meta.dirname, './src/tools'),
      '@utils': resolve(import.meta.dirname, './src/utils'),
      '@config': resolve(import.meta.dirname, './src/config'),
      '@llm': resolve(import.meta.dirname, './src/llm'),
      '@security': resolve(import.meta.dirname, './src/security'),
      '@checkers': resolve(import.meta.dirname, './src/checkers'),
      '@plugins': resolve(import.meta.dirname, './src/plugins'),
      '@marketplace': resolve(import.meta.dirname, './src/marketplace'),
      '@mcp': resolve(import.meta.dirname, './src/mcp'),
      '@ui': resolve(import.meta.dirname, './src/ui'),
      '@shared': resolve(import.meta.dirname, './src/types'),
      '@cli': resolve(import.meta.dirname, './src/cli'),
    },
  },
});