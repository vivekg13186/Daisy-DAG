// Playwright configuration for the Daisy AI Orchestrator UI suite.
//
// Two services need to be running:
//
//   1. The backend stack — Postgres + Redis + API + worker.
//      Start it with `npm run stack:up` (boots docker-compose.test.yml).
//      The bootstrap-admin env vars on the worker-test service seed
//      admin@test.local on first boot so the Playwright suite can
//      log in straight away.
//
//   2. The UI — Vite dev server. Playwright boots it for us via the
//      `webServer` config below, pointing VITE_API_URL at the test
//      API (3001) instead of the dev one (3000).
//
// Local run:
//   npm run stack:up   # one-time per session
//   npm run test:smoke
//
// CI run:
//   docker compose -f ../docker-compose.test.yml up -d --wait
//   npm ci
//   npx playwright install --with-deps chromium
//   npx playwright test smoke

import { defineConfig, devices } from "@playwright/test";

// Layer 1 is single-browser Chromium for speed. Layer 3 will fan out
// across firefox + webkit; we plug those into `projects` then.
const isCI = !!process.env.CI;

export default defineConfig({
  testDir:    ".",
  testMatch: ["smoke/**/*.spec.js", "features/**/*.spec.js", "regression/**/*.spec.js"],
  outputDir:  "test-results",
  // Per-test timeout. Smoke tests should each finish well under this;
  // 60s is enough budget for the longest happy-path that involves a
  // workflow execution round-trip.
  timeout:    60_000,
  expect:    { timeout: 5_000 },
  // Concurrency. Two workers locally keeps log noise readable; CI
  // overrides via `--workers=N` in the workflow YAML.
  workers:    isCI ? 1 : 2,
  // Fail fast in CI so a broken main doesn't keep spending compute.
  forbidOnly: isCI,
  // Retry flaky tests once on CI, never locally — a local failure is
  // information we want to see immediately.
  retries:    isCI ? 1 : 0,
  reporter:   isCI
    ? [["list"], ["html", { open: "never" }], ["github"]]
    : [["list"], ["html", { open: "never" }]],

  use: {
    baseURL:  process.env.TEST_BASE_URL || "http://localhost:5174",
    trace:    "retain-on-failure",        // huge debugging aid on flake
    screenshot: "only-on-failure",
    video:    "retain-on-failure",
    actionTimeout: 10_000,
    navigationTimeout: 15_000,
  },

  projects: [
    {
      name: "chromium",
      use:  { ...devices["Desktop Chrome"] },
    },
  ],

  // Boot the Vite dev server pointed at the test API. Playwright
  // waits for the URL to respond before starting tests, then shuts
  // it down at the end. The `VITE_API_URL` env var must match
  // whatever the frontend reads — check frontend/src/stores/auth.js.
  webServer: {
    cwd:     "../frontend",
    command: "npm run dev -- --port 5174 --strictPort",
    url:     "http://localhost:5174",
    timeout: 60_000,
    reuseExistingServer: !isCI,
    env: {
      VITE_API_URL: process.env.TEST_API_URL || "http://localhost:3001",
    },
  },
});
