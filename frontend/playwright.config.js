import { defineConfig, devices } from '@playwright/test';
import { BACKEND_PORT, FRONTEND_PORT, E2E_MONGO_URI } from './e2e/env.js';

/**
 * Browser end-to-end tests for PayGuard's critical workflows.
 *
 * Starts its own backend (port 5100, database payguard_e2e, dropped and
 * seeded first) and Vite dev server (port 5174), against a MongoDB replica set
 * with transactions required, exactly like development and production.
 *
 *   npm run test:e2e
 *
 * Locally the installed Microsoft Edge is used; CI uses Playwright's Chromium.
 * Override with PLAYWRIGHT_CHANNEL (e.g. "chrome") or E2E_MONGO_URI.
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: Boolean(process.env.CI),
  timeout: 120_000,
  expect: { timeout: 20_000 },
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : [['list']],
  globalTeardown: './e2e/global-teardown.js',
  use: {
    ...devices['Desktop Chrome'],
    viewport: { width: 1440, height: 1000 },
    channel: process.env.PLAYWRIGHT_CHANNEL || (process.env.CI ? undefined : 'msedge'),
    baseURL: `http://localhost:${FRONTEND_PORT}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: [
    {
      command: 'node scripts/e2e-server.mjs',
      cwd: '../backend',
      url: `http://localhost:${BACKEND_PORT}/api/health`,
      reuseExistingServer: false,
      timeout: 120_000,
      stdout: 'pipe',
      env: {
        PORT: String(BACKEND_PORT),
        NODE_ENV: 'development',
        MONGO_URI: E2E_MONGO_URI,
        REQUIRE_TRANSACTIONS: 'true',
        RATE_LIMIT_ENABLED: 'false',
        FRONTEND_URL: `http://localhost:${FRONTEND_PORT}`,
        JWT_SECRET: 'e2e-only-secret-that-is-at-least-32-characters-long',
        // Test-only keys for a disposable database.
        FIELD_ENCRYPTION_KEYS: `e2e:${Buffer.from('e2e-only-field-encryption-key-32').toString('base64')}`,
        // Explicit, so backend/.env cannot select a key this server does not have.
        FIELD_ENCRYPTION_ACTIVE_KEY: 'e2e',
        FIELD_BLIND_INDEX_KEY: 'e2e-only-blind-index-secret-not-for-production',
        LOG_LEVEL: 'warn',
        STUCK_RUN_MONITOR_INTERVAL_MS: '0',
      },
    },
    {
      command: `npx vite --port ${FRONTEND_PORT} --strictPort`,
      url: `http://localhost:${FRONTEND_PORT}`,
      reuseExistingServer: false,
      timeout: 120_000,
      env: {
        VITE_API_URL: `http://localhost:${BACKEND_PORT}/api`,
        BROWSER: 'none',
      },
    },
  ],
});
