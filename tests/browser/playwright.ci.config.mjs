import { defineConfig } from "@playwright/test";
import config from "./playwright.config.mjs";

// Keep the full local gate unchanged. Only documented WebKit cases leave CI;
// their Chromium counterparts and all other WebKit journeys remain required.
export default defineConfig({
  ...config,
  projects: config.projects.map((project) =>
    project.name === "webkit-measurements"
      ? { ...project, grepInvert: /@local-webkit/ }
      : project,
  ),
});
