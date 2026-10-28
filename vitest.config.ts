import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

const plugins = [swc.vite({ module: { type: 'es6' } })];

export default defineConfig({
  plugins,
  test: {
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/__tests__/**', 'src/main.ts'],
      thresholds: {
        lines: 80,
        branches: 80,
        'src/common/money/**': { lines: 100, branches: 100 },
      },
    },
    projects: [
      {
        test: {
          name: 'unit',
          include: ['src/**/__tests__/**/*.test.ts', 'scripts/**/*.test.ts'],
          exclude: ['src/**/__tests__/**/*.api.test.ts'],
        },
      },
      {
        test: {
          name: 'int',
          include: ['src/**/__tests__/**/*.api.test.ts', 'src/**/__tests__/**/*.db.test.ts'],
          globalSetup: ['test/helpers/global-mongo.ts'],
          testTimeout: 30000,
          hookTimeout: 120000,
          fileParallelism: false,
        },
      },
      {
        test: {
          name: 'e2e',
          include: ['test/journeys/**/*.test.ts'],
          globalSetup: ['test/helpers/global-mongo.ts'],
          testTimeout: 60000,
          hookTimeout: 120000,
          fileParallelism: false,
        },
      },
    ],
  },
});
