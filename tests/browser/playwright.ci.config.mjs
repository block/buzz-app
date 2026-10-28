import { defineConfig } from "@playwright/test";
import config from "./playwright.config.mjs";

// Linux WebKit is built without MediaRecorder. Those cases run with the local
// config in the required macOS job; Chromium still records on Linux.
// The documented @local-webkit measurements remain local-only.
export default defineConfig({
  ...config,
  projects: config.projects.map((project) => {
    const excluded = [/@local-only/];
    if (project.grepInvert) excluded.push(...[project.grepInvert].flat());
    if (project.name === "webkit-measurements") excluded.push(/@local-webkit/);
    if (project.name === "webkit") excluded.push(/@media-recorder/);
    return { ...project, grepInvert: excluded };
  }),
});
