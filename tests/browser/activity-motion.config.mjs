import { defineConfig } from "@playwright/test";
import gate from "./playwright.config.mjs";

// Explicit diagnostic only; excluded from normal functional and perf inventories.
export default defineConfig({
  testDir: "./perf",
  testMatch: "activity-motion.diagnostic.mjs",
  globalSetup: "./vite-server.mjs",
  outputDir: "../../test-results/activity-motion",
  workers: 1,
  retries: 0,
  timeout: 120_000,
  expect: gate.expect,
  reporter: [["list"]],
  use: { ...gate.use, trace: "off" },
  projects: ["chromium", "webkit"].map((browserName) => ({
    name: browserName,
    use: { browserName },
  })),
});
