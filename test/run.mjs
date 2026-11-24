// Runs the built plugin.js in headless Chromium against the pretend host.
// Borrows Vite, React and Playwright from a block/buzz-app checkout (BUZZ_APP).
import { cp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import assert from "node:assert/strict";

const here = dirname(fileURLToPath(import.meta.url));
const app = resolve(here, process.env.BUZZ_APP ?? "../../.wt-canvas");
const require = createRequire(`${app}/package.json`);
const load = (name) => import(pathToFileURL(require.resolve(name)).href);
const { createServer } = await load("vite");
const { chromium } = require("@playwright/test");
const react = (await load("@vitejs/plugin-react")).default;

const fixtures = `${app}/tests/fixtures`;
const copies = [
  ["harness.html", "zz-canvas-plugin.html"],
  ["harness.jsx", "zz-canvas-plugin-harness.jsx"],
  ["../plugin.js", "zz-canvas-plugin.js"],
];
for (const [from, to] of copies) await cp(`${here}/${from}`, `${fixtures}/${to}`);
const server = await createServer({ root: app, configFile: false, envDir: false, plugins: [react()], logLevel: "error", server: { host: "127.0.0.1", port: 0 } });
await server.listen();
const browser = await chromium.launch();
try {
  for (const ui of ["", "?ui"]) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 800 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => message.type() === "error" && errors.push(message.text()));
  await page.route("https://tile.openstreetmap.org/**", (route) => route.fulfill({ contentType: "image/png", body: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "base64") }));
  await page.route("https://pages.example/**", (route) => route.fulfill({ contentType: "text/html", body: "<h1>Roadmap</h1>" }));
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/tests/fixtures/zz-canvas-plugin.html${ui}`);
  const ada = page.getByRole("region", { name: "Ada's screen" });
  const ben = page.getByRole("region", { name: "Ben's screen" });
  const status = (seat) => seat.getByRole("status").textContent();
  const agent = (name, args) => page.evaluate(([n, a]) => window.canvasHarness.agent(n, a), [name, args]);
  const settle = () => page.waitForTimeout(300);

  await ada.getByRole("button", { name: "Take control" }).click();
  await ada.getByRole("button", { name: "Browser" }).click();
  await ada.getByRole("textbox", { name: "Shared address" }).fill("pages.example/roadmap");
  await ada.getByRole("button", { name: "Go" }).click();
  await ben.frameLocator("iframe").getByRole("heading", { name: "Roadmap" }).waitFor();
  assert.equal(await status(ben), "Following Ada.");
  assert.equal(await ben.getByRole("textbox").count(), 0, "a follower has no address bar");

  await assert.rejects(agent("canvas_open", { type: "map", state: { center: [0, 0], zoom: 2 } }), /Someone else is driving/);
  await agent("canvas_drive", { drive: true });
  await agent("canvas_open", { type: "map", title: "Coffee", state: { center: [-122.42, 37.77], zoom: 13, markers: [{ coordinates: [-122.42, 37.77], label: "Roastery" }] } });
  await ben.getByText("Roastery").waitFor();
  assert.equal(await status(ada), "Following Scout.");

  // A follower's tab click changes nothing for anyone.
  await ben.getByRole("tab", { name: "Browser" }).click();
  await settle();
  assert.equal((await agent("canvas_read")).active, "map-1");

  // Looking around alone, then taking control, keeps what the agent added meanwhile.
  await ben.getByRole("button", { name: "Stop following" }).click();
  await ben.getByRole("button", { name: "Zoom in" }).click();
  await agent("canvas_open", { type: "video", state: { url: "https://media.example/a.webm" } });
  await ada.getByRole("tab", { name: "Video" }).waitFor();
  assert.equal(await ben.getByRole("tab").count(), 2);
  // The "+" menu adds a view while looking around alone; it stays private.
  await ben.getByRole("button", { name: "Add a view" }).click();
  await page.getByRole("menuitem", { name: "Map" }).click();
  assert.equal(await ben.getByRole("tab").count(), 3);
  assert.equal(await ada.getByRole("tab").count(), 3);
  await ben.getByRole("tab", { name: "Coffee" }).click();
  await ben.getByRole("button", { name: "Take control" }).click();
  await ada.getByText("Following Ben.").waitFor();
  const scene = await agent("canvas_read");
  assert.deepEqual(scene.views.map((view) => view.type), ["browser", "map", "video", "map"]);
  assert.equal(scene.active, "map-1");
  assert.equal(scene.views[1].state.zoom, 14);
  assert.deepEqual(errors.filter((text) => !/media\.example|ERR_/.test(text)), []);
  if (process.env.SHOT && !ui) await page.screenshot({ path: process.env.SHOT });
  assert.equal(await page.locator("[data-host]").count() > 0, ui !== "");
  console.log(`ok: plugin.js works against the pretend host ${ui ? "with" : "without"} host controls`);
  }
} finally {
  await browser.close();
  await server.close();
  for (const [, to] of copies) await rm(`${fixtures}/${to}`, { force: true });
}
