import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests/browser',
  projects: [
    { name: 'workspace', testMatch: 'workspace.spec.ts' },
    {
      name: 'features',
      testIgnore: 'workspace.spec.ts',
      dependencies: ['workspace'],
    },
  ],
  fullyParallel: false,
  workers: 1,
  timeout: 90_000,
  use: {
    baseURL: 'http://127.0.0.1:4411',
    actionTimeout: 15000,
    viewport: { width: 1440, height: 1000 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: 'node --import tsx tests/browser-server.ts',
    url: 'http://127.0.0.1:4411/api/health',
    reuseExistingServer: false,
    timeout: 20_000,
  },
});
