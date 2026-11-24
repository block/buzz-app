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
  {
    // With the host's own browser view: one address bar, and where the driver
    // goes inside the page is where everyone goes.
    const page = await browser.newPage({ viewport: { width: 1440, height: 800 } });
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/tests/fixtures/zz-canvas-plugin.html?native`);
    const ada = page.getByRole("region", { name: "Ada's screen" });
    const ben = page.getByRole("region", { name: "Ben's screen" });
    const shows = (seat, url) => seat.locator("[data-page]").filter({ hasText: new RegExp(`^${url}$`) }).waitFor();
    await ada.getByRole("button", { name: "Take control" }).click();
    await ada.getByRole("button", { name: "Browser" }).click();
    await ada.getByRole("textbox", { name: "Shared address" }).fill("pages.example/roadmap");
    await ada.getByRole("textbox", { name: "Shared address" }).press("Enter");
    await shows(ben, "https://pages.example/roadmap");
    assert.equal(await ada.getByRole("textbox").count(), 1, "the driver has one address bar");
    assert.equal(await ben.locator("[inert] [data-native]").count(), 0, "the host hides its view inside anything inert");
    // Typing in the host's own bar moves everyone, at once.
    await ada.getByRole("textbox", { name: "Address" }).fill("https://pages.example/typed");
    await ada.getByRole("textbox", { name: "Address" }).press("Enter");
    await shows(ben, "https://pages.example/typed");
    // So does a link inside the page, once the page has settled.
    await page.waitForTimeout(4200);
    await ada.getByRole("button", { name: "A link in the page" }).click();
    await shows(ben, "https://pages.example/linked");
    // Where a follower wanders is their own business.
    await ben.getByRole("button", { name: "A link in the page" }).click();
    await page.waitForTimeout(1200);
    assert.equal((await page.evaluate(() => window.canvasHarness.agent("canvas_read"))).views[0].state.url, "https://pages.example/linked");
    // The driver's page was opened once; the follower's once per place it was sent.
    assert.equal(await page.evaluate(() => window.canvasHarness.opened()), 4);
    console.log("ok: one address bar with the host's browser view, and its navigation is shared");
  }
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
  await ada.getByRole("textbox", { name: "Shared address" }).press("Enter");
  await ben.frameLocator("iframe").getByRole("heading", { name: "Roadmap" }).waitFor();
  assert.equal(await status(ben), "Following Ada.");
  assert.equal(await ben.getByRole("textbox").count(), 0, "a follower has no address bar");
  // One view, one tab, named after it; nothing but the view's own row below.
  assert.deepEqual(await ada.getByRole("tab").allTextContents(), ["Browser"]);
  assert.equal(await ada.getByRole("tablist").count(), 1);
  // The "+" sits in the tab strip, just past the last tab.
  const plusBox = await ada.getByRole("button", { name: "Views" }).boundingBox();
  const tabBox = await ada.getByRole("tab", { name: "Browser" }).boundingBox();
  assert.ok(plusBox.x >= tabBox.x + tabBox.width && plusBox.y < tabBox.y + tabBox.height, "the + is beside the tabs");

  await assert.rejects(agent("canvas_open", { type: "map", state: { center: [0, 0], zoom: 2 } }), /Someone else is driving/);
  await agent("canvas_drive", { drive: true });
  await agent("canvas_open", { type: "map", title: "Coffee", state: { center: [-122.42, 37.77], zoom: 13, markers: [{ coordinates: [-122.42, 37.77], label: "Roastery" }] } });
  // A second view is a second tab at the top, and followers are taken to it.
  await ben.getByText("Roastery").waitFor();
  assert.deepEqual(await ben.getByRole("tab").allTextContents(), ["Browser", "Coffee"]);
  assert.equal(await ben.getByRole("tab", { name: "Coffee" }).getAttribute("aria-selected"), "true");
  assert.equal(await status(ada), "Following Scout.");

  // A follower's tab click changes nothing for anyone.
  await ben.getByRole("tab", { name: "Browser" }).click();
  await settle();
  assert.equal((await agent("canvas_read")).active, "map-1");

  // Looking around alone, then taking control, keeps what the agent added meanwhile.
  await ben.getByRole("button", { name: "Stop following" }).click();
  await ben.getByRole("tab", { name: "Coffee" }).click();
  await ben.getByRole("button", { name: "Zoom in" }).click();
  await agent("canvas_open", { type: "video", state: { url: "https://media.example/a.webm" } });
  await ada.getByRole("tab", { name: "Video" }).waitFor();
  assert.equal(await ada.getByRole("tab", { name: "Video" }).getAttribute("aria-selected"), "true");
  assert.equal(await ben.getByRole("tab").count(), 2);
  // The menu adds a view while looking around alone; it stays private.
  await ben.getByRole("button", { name: "Views" }).click();
  await page.getByRole("menuitem", { name: "New map" }).click();
  await ben.getByRole("tab", { name: "Map" }).waitFor();
  assert.equal(await ben.getByRole("tab").count(), 3);
  assert.equal(await ada.getByRole("tab").count(), 3);
  await ben.getByRole("tab", { name: "Coffee" }).click();
  await ben.getByRole("button", { name: "Take control" }).click();
  await ada.getByRole("tab", { name: "Coffee", selected: true }).waitFor();
  assert.equal(await status(ada), "Following Ben.");
  const scene = await agent("canvas_read");
  assert.deepEqual(scene.views.map((view) => view.type), ["browser", "map", "video", "map"]);
  assert.equal(scene.active, "map-1");
  assert.equal(scene.views[1].state.zoom, 14);
  assert.equal(await ben.getByRole("tab").count(), 3, "the driver keeps the tab of the view they added alone");

  // Removing a view closes its tab for everyone.
  await ben.getByRole("button", { name: "Views" }).click();
  await page.getByRole("menuitem", { name: "Remove this view for everyone" }).click();
  await ada.getByRole("tab", { name: "Coffee" }).waitFor({ state: "detached" });
  assert.equal(await ben.getByRole("tab", { name: "Coffee" }).count(), 0);
  // Removing the first view moves the next one into the canvas's own tab.
  await ben.getByRole("tab", { name: "Browser" }).click();
  await ben.getByRole("button", { name: "Views" }).click();
  await page.getByRole("menuitem", { name: "Remove this view for everyone" }).click();
  await ada.getByRole("tab", { name: "Browser" }).waitFor({ state: "detached" });
  await settle();
  assert.deepEqual(await ada.getByRole("tab").allTextContents(), ["Video"]);
  // A view nobody brought to the front is one step away, even for a follower.
  await ada.getByRole("button", { name: "Views" }).click();
  await page.getByRole("menuitem", { name: "Go to Map" }).click();
  assert.deepEqual(await ada.getByRole("tab").allTextContents(), ["Video", "Map"]);
  assert.deepEqual((await agent("canvas_read")).views.map((view) => view.id), ["video-1", "map-2"]);
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
