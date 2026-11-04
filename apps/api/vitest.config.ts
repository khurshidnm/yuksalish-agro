import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    globalSetup: ['./test/global-setup.ts'],
    setupFiles: ['./test/setup-env.ts'],
    pool: 'forks',
    testTimeout: 30_000,
    hookTimeout: 60_000,
    env: {
      NODE_ENV: 'test',
      BCRYPT_ROUNDS: '4',
      JOBS_ENABLED: 'false',
      STORAGE_DRIVER: 'local',
      STORAGE_DIR: '/tmp/yap-test-storage',
    },
  },
});
