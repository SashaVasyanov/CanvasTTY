// Automated tests — draft, not wired into npm scripts or CI yet.
//   npx playwright test --project=browser   — the interface in a browser (demo data)
//   tests/electron (planned)                — the real app in Electron with a throw-away profile
import { defineConfig } from '@playwright/test';

const PORT = Number(process.env.TEST_PORT || 5588);
// Windows always has Edge, so no browser download is needed there; elsewhere Playwright's Chromium
// (npx playwright install chromium). PW_CHANNEL=chrome / msedge / chromium overrides it.
const channel = process.env.PW_CHANNEL || (process.platform === 'win32' ? 'msedge' : undefined);

export default defineConfig({
  timeout: 30_000,
  expect: { timeout: 5_000 },
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['list']] : [['list']],
  outputDir: 'test-results',
  use: { trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  projects: [
    {
      name: 'browser',
      testDir: 'tests/e2e',
      fullyParallel: true,
      use: {
        baseURL: `http://127.0.0.1:${PORT}`,
        viewport: { width: 1400, height: 900 },
        channel: channel === 'chromium' ? undefined : channel,
        permissions: ['clipboard-read', 'clipboard-write'],
        locale: 'ru-RU',
      },
    },
    {
      name: 'electron',
      testDir: 'tests/electron',
      timeout: 90_000,
    },
  ],
  webServer: {
    command: `node tests/server.mjs ${PORT}`,
    url: `http://127.0.0.1:${PORT}/index.html`,
    reuseExistingServer: !process.env.CI,
    stdout: 'ignore',
  },
});
