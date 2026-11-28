import { test, expect } from "./fixture.mjs";
import { open } from "./timeline.mjs";

test.use({
  pluginFixtures: true,
  enabledPlugins: ["fixture.link-previews"],
  historyCounts: { alpha: 1, beta: 1 },
});

test("a link preview opens its link in the browser unless a panel takes it", async ({
  page,
  app,
}) => {
  // The notes fixture's catch-all panel would take every link.
  await page.addInitScript(() => {
    const key = "buzzodz.plugins.v1";
    const stored = JSON.parse(localStorage.getItem(key) ?? "{}");
    stored.enabled = { ...stored.enabled, "fixture.notes": false };
    localStorage.setItem(key, JSON.stringify(stored));
  });
  // The opened page loads from here rather than the network.
  await page
    .context()
    .route("https://previews.example/**", (route) =>
      route.fulfill({ contentType: "text/html", body: "<p>Opened</p>" }),
    );
  await open(page, app);
  const plain = "https://previews.example/doc";
  const paneled = "https://previews.example/paneled";
  const message = app.append(
    "primary",
    "alpha",
    `See ${plain} and ${paneled}.`,
  );
  const row = page.locator(
    `[data-channel-timeline] [data-message-id="${message.id}"]`,
  );
  const card = (url) =>
    row.getByRole("button", { name: `Preview of ${url}`, exact: true });
  await expect(card(plain)).toBeVisible();

  // No panel takes it, so it opens outside Buzz as clicking the link does.
  const popup = page.waitForEvent("popup");
  await card(plain).click();
  const opened = await popup;
  await expect(opened).toHaveURL(plain);
  await opened.close();

  // A panel takes this one, and nothing opens in the browser.
  const popups = [];
  page.on("popup", (opened) => popups.push(opened));
  await card(paneled).click();
  await expect(page.getByText("Paneled preview panel")).toBeVisible();
  expect(popups).toHaveLength(0);
});
