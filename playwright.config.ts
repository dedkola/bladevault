import { defineConfig, devices } from '@playwright/test'

const port = 3199
const baseURL = `http://127.0.0.1:${port}`

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL,
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    command: 'node scripts/start-test-server.cjs',
    env: {
      BLADEVAULT_TEST_PORT: String(port),
    },
    gracefulShutdown: {
      signal: 'SIGTERM',
      timeout: 5_000,
    },
    reuseExistingServer: false,
    timeout: 120_000,
    url: baseURL,
  },
})
