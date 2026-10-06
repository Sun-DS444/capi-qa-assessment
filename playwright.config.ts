import { defineConfig, devices } from '@playwright/test';

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
const useMock = !process.env.BASE_URL; // only start the mock when no real env is given

export default defineConfig({
  testDir: './tests',
  fullyParallel: false,
  workers: 1, // API tests share server state; keep runs deterministic
  retries: process.env.CI ? 1 : 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'schema', testDir: './tests/schema' },
    { name: 'api', testDir: './tests/api' },
    {
      name: 'web',
      testDir: './tests/web',
      // Small, budget-phone sized viewport — matches the field reality
      use: { ...devices['Desktop Chrome'], viewport: { width: 360, height: 740 } },
    },
  ],
  webServer: useMock
    ? {
        command: 'node mock-server/server.js',
        url: `${BASE_URL}/health`,
        reuseExistingServer: !process.env.CI,
        timeout: 15_000,
      }
    : undefined,
});
