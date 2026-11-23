import { defineConfig } from "@playwright/test";
import browser from "../browser/playwright.config.mjs";

// Opt-in visual review, separate from the behavioral journeys and their CI shards.
// Goldens are engine/OS-specific; never compare macOS glyphs with Linux goldens.
export default defineConfig({
  ...browser,
  testDir: ".",
  globalSetup: "../browser/vite-server.mjs",
  outputDir: "../../test-results/visual",
  workers: 1,
  snapshotPathTemplate:
    "{testDir}/snapshots/{testFilePath}/{projectName}-{platform}/{arg}{ext}",
  expect: {
    ...browser.expect,
    toHaveScreenshot: {
      animations: "disabled",
      threshold: 0,
      maxDiffPixels: 0,
    },
  },
  projects: browser.projects
    .filter(({ name }) => name === "chromium" || name === "webkit")
    .map(({ dependencies: _dependencies, ...project }) => project),
});
