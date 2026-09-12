import { test, expect } from "./fixture.mjs";
import { open } from "./timeline.mjs";
const history = (page) =>
  page.getByRole("region", { name: "Channel message history" });

test.use({ productionBroker: true });
test("presence: production conversation routes, seed, conflicting live repair and navigation", async ({
  page,
  app,
}, testInfo) => {
  await open(page, app);
  const online = history(page).locator('[data-presence-status="online"]');
  await expect(online.first()).toBeVisible();
  const reads = () =>
    app.report.queries.filter(({ filter }) => filter.kinds?.includes(20001));
  expect(reads().length).toBeGreaterThan(0);
  expect(reads().every(({ filter }) => filter.authors.length <= 256)).toBe(
    true,
  );
  const count = reads().length;
  // The real profile panel shares the timeline's author, not another read owner.
  const sockets = app.relay.sockets.length;
  await history(page)
    .getByRole("button", { name: /^View .* profile$/ })
    .first()
    .click();
  const profile = page.getByRole("complementary", {
    name: "Profile",
    exact: true,
  });
  await expect(
    profile.getByRole("img", { name: "Online", exact: true }),
  ).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("presence-profile.png") });
  await profile.getByRole("button", { name: "Close channel panel" }).click();
  await expect(profile).toHaveCount(0);
  expect(app.relay.sockets).toHaveLength(sockets);
  expect(reads()).toHaveLength(count);
  app.presence("online");
  await expect(online.first()).toBeVisible();
  expect(reads()).toHaveLength(count);
  app.presence("away");
  await expect(
    history(page).locator('[data-presence-status="away"]').first(),
  ).toBeVisible();
  // A delayed conflicting heartbeat cannot turn a snapshot-confirmed Away green.
  app.presence("online", false);
  await expect(online).toHaveCount(0);
  await expect(
    history(page).locator('[data-presence-status="away"]').first(),
  ).toBeVisible();
  const presenceRoute = () =>
    app.relay.sockets
      .flatMap((s) => [...s.routes.values()])
      .filter((f) => f.kinds.includes(20001));
  await page.getByRole("button", { name: "Home", exact: true }).first().click();
  await expect.poll(() => presenceRoute().length).toBe(0);
  // Agent Activity's separately owned route survives presence demand teardown.
  expect(app.relay.hasRoute("primary", "observer")).toBe(true);
  expect(app.relay.sockets).toHaveLength(sockets);
  expect(app.report.presencePublications.length).toBeGreaterThan(0);
  const starts = reads().map((r) => r.at);
  for (let i = 1; i < starts.length; i++)
    expect(starts[i] - starts[i - 1]).toBeGreaterThanOrEqual(4900);
});
