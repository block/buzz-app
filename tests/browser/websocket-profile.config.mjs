import { defineConfig } from "@playwright/test";
// Opt-in matched before/after experiment, not another parallel CI journey.
export default defineConfig({
  testDir: ".",
  testMatch: "websocket-actions.profile.mjs",
  outputDir: "../../test-results/ws-profile",
  workers: 1,
  retries: 0,
  timeout: 90000,
  expect: { timeout: 15000 },
  reporter: [["list"]],
  use: {
    headless: true,
    viewport: { width: 1440, height: 950 },
    locale: "en-US",
    timezoneId: "UTC",
    serviceWorkers: "block",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "chromium", use: { browserName: "chromium" } },
    {
      name: "webkit",
      use: { browserName: "webkit" },
      dependencies: ["chromium"],
    },
  ],
});
