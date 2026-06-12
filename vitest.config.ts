import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      lib: resolve(__dirname, 'src/lib'),
    },
  },
  test: {
    globals: true,
    environment: 'jsdom',
    include: ['src/**/*.spec.ts'],
    clearMocks: true,
    testTimeout: 10_000,
    coverage: {
      enabled: true,
      provider: 'v8',
      reporter: ['html', 'text'],
      reportsDirectory: 'coverage',
      include: ['src/lib/**/*.{js,ts}'],
      exclude: [
        'src/lib/**/*.spec.ts',
        'src/lib/**/*.d.ts',
        'src/lib/**/*index.ts',
        'src/lib/core/5.di/**/*',
        'src/lib/testing/**/*',
      ],
      thresholds: {
        branches: 80,
        functions: 80,
        lines: 80,
      },
    },
  },
});
