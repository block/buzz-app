import { test, expect } from "./source-fixture.mjs";
import { watchPageErrors } from "./page-errors.mjs";

// One transparent pixel stands in for every map tile.
const TILE = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64",
);

test.use({ viewport: { width: 1440, height: 800 } });

test("people and an agent share views, and followers see what the driver does", async ({
  page,
}, testInfo) => {
  const errors = watchPageErrors(page);
  const tiles = [];
  await page.route("https://tile.openstreetmap.org/**", (route) => {
    tiles.push(new URL(route.request().url()).pathname);
    return route.fulfill({ contentType: "image/png", body: TILE });
  });
  await page.route("https://pages.example/**", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<body style="font:16px system-ui;padding:2rem"><h1>${new URL(route.request().url()).pathname}</h1></body>`,
    }),
  );
  await page.goto("/tests/fixtures/canvas.html");
  const ada = page.getByRole("region", { name: "Ada's screen" });
  const ben = page.getByRole("region", { name: "Ben's screen" });
  await expect(ada.getByRole("status")).toHaveText(
    "Nobody is driving. Changes are shared with everyone.",
  );
  await page.screenshot({ path: testInfo.outputPath("canvas-empty.png") });

  // Ada drives a browser; Ben is taken where she goes and cannot steer.
  await ada.getByRole("button", { name: "Take control" }).click();
  await ada.getByRole("button", { name: "Browser" }).click();
  await ada
    .getByRole("textbox", { name: "Shared address" })
    .fill("pages.example/roadmap");
  await ada.getByRole("button", { name: "Go" }).click();
  await expect(ben.getByRole("status")).toHaveText("Following Ada.");
  await expect(
    ben.frameLocator("iframe").getByRole("heading", { name: "/roadmap" }),
  ).toBeVisible();
  await expect(
    ben.getByRole("textbox", { name: "Shared address" }),
  ).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("canvas-browser.png") });

  // An agent waits its turn, then drives a map with markers.
  await expect(
    page.evaluate(() =>
      window.canvasFixture.agent("canvas_open", {
        type: "map",
        state: { center: [-122.4194, 37.7749], zoom: 12 },
      }),
    ),
  ).rejects.toThrow("Someone else is driving");
  await ada.getByRole("button", { name: "Stop driving" }).click();
  const scene = await page.evaluate(async () => {
    await window.canvasFixture.agent("canvas_drive", { drive: true });
    return window.canvasFixture.agent("canvas_open", {
      type: "map",
      title: "Coffee near the office",
      state: {
        center: [-122.4194, 37.7749],
        zoom: 13,
        markers: [
          { coordinates: [-122.4313, 37.7739], label: "Roastery" },
          { coordinates: [-122.4089, 37.7835], label: "Espresso bar" },
        ],
      },
    });
  });
  expect(scene.views.at(-1).shows).toContain(
    "2 markers: Roastery; Espresso bar",
  );
  for (const seat of [ada, ben]) {
    await expect(seat.getByRole("status")).toHaveText("Following Scout.");
    await expect(
      seat.getByRole("tab", { name: "Coffee near the office" }),
    ).toHaveAttribute("aria-selected", "true");
    await expect(seat.getByText("Espresso bar")).toBeVisible();
  }
  expect(tiles.some((path) => path.startsWith("/13/"))).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("canvas-agent-map.png") });

  // Ben looks around alone: his zoom is his, until he takes control.
  await ben.getByRole("button", { name: "Stop following" }).click();
  await ben.getByRole("button", { name: "Zoom in" }).click();
  await expect(ben.getByRole("status")).toHaveText(
    "Looking around on your own. Scout is driving.",
  );
  await expect
    .poll(() => tiles.some((path) => path.startsWith("/14/")))
    .toBe(true);
  expect(
    (await page.evaluate(() => window.canvasFixture.agent("canvas_read")))
      .views[1].state.zoom,
  ).toBe(13);
  await page.screenshot({ path: testInfo.outputPath("canvas-roaming.png") });
  await ben.getByRole("button", { name: "Take control" }).click();
  await expect(ada.getByRole("status")).toHaveText("Following Ben.");
  expect(
    (await page.evaluate(() => window.canvasFixture.agent("canvas_read")))
      .views[1].state.zoom,
  ).toBe(14);
  expect(errors.unexplained()).toEqual([]);
});
