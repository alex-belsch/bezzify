import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts', 'dashboard/src/**/*.test.ts'],
    env: {
      APP_SECRET: 'test-secret-0123456789abcdefghijklmnopqrstuvwxyz',
      LOG_LEVEL: 'error',
      DISABLE_JOBS: '1',
      PUBLIC_URL: 'https://t.example.de',
    },
    testTimeout: 30_000,
    pool: 'forks',
  },
});
