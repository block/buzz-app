import { defineConfig } from "@playwright/test";
import gate from "./playwright.config.mjs";

// Explicit diagnostic only; excluded from normal functional and perf inventories.
export default defineConfig({
  testDir: "./perf",
  testMatch: "columns.diagnostic.mjs",
  globalSetup: "./vite-server.mjs",
  outputDir: "../../test-results/columns",
  workers: 1,
  retries: 0,
  timeout: 180_000,
  expect: gate.expect,
  reporter: [["list"]],
  use: { ...gate.use, browserName: "chromium", trace: "off" },
});
