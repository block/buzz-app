import { defineConfig } from "@playwright/test";
import config from "./playwright.config.mjs";

// Linux WebKit is built without MediaRecorder, and its wheel scrolling exceeds
// the 120s per-test timeout on the 640-row cursor-paging measurement. Those
// WebKit cases run with the local config on the required macOS job while
// Chromium keeps them on Linux.
export default defineConfig({
  ...config,
  // Only the eight-core functional CI jobs opt into the extra worker.
  workers: Number(process.env.BUZZ_BROWSER_WORKERS || config.workers),
  projects: config.projects.map((project) =>
    project.name === "webkit-measurements"
      ? { ...project, grepInvert: /@macos-webkit/ }
      : project.name === "webkit"
        ? {
            ...project,
            grepInvert: /@classic-scrollbars|@media-recorder|@local-only/,
          }
        : project.name === "chromium"
          ? { ...project, grepInvert: /@classic-scrollbars|@local-only/ }
          : project,
  ),
});
