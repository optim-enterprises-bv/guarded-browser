import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/unit/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 600_000,
    // one file at a time: the guard test loads a ~700 MB model and the box is shared
    fileParallelism: false,
    globalSetup: ['test/unit/global-setup.ts'],
  },
});
