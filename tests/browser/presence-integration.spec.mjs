import { test, expect } from "./fixture.mjs";
import { open } from "./timeline.mjs";
const history = (page) =>
  page.getByRole("region", { name: "Channel message history" });

// A real reading journey can publish durable read intent while presence runs.
test.use({ productionBroker: true, readState: true });
test("presence: production conversation routes, seed, conflicting live repair and navigation", async ({
  page,
  app,
}, testInfo) => {
  await open(page, app);
  const presenceRoute = () =>
    app.relay.sockets
      .filter((s) => s.readyState === 1 && s.community === "primary")
      .flatMap((s) => [...s.routes.values()])
      .filter((f) => f.kinds.includes(20001));
  // The fixture's peer owns the history; inject only after live delivery exists.
  const author = app.histories.get("primary/alpha")[0].pubkey;
  await expect
    .poll(() => presenceRoute().some((f) => f.authors.includes(author)))
    .toBe(true);
  app.presence("online");
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
  // Exercise the real dwell -> journal -> encrypted HTTP publication alongside
  // presence, rather than making success depend on finishing before its debounce.
  await history(page).focus();
  await expect
    .poll(() => app.report.readPublications.length, { timeout: 12000 })
    .toBeGreaterThan(0);
  const { community, event, blob } = app.report.readPublications[0];
  expect(community).toBe("primary");
  expect(event.kind).toBe(30078);
  const messageContexts = Object.keys(blob.contexts).filter((key) =>
    key.startsWith("msg:"),
  );
  expect(messageContexts.length).toBeGreaterThan(0);
  const ids = new Set(app.histories.get("primary/alpha").map(({ id }) => id));
  for (const key of messageContexts) {
    expect(ids.has(key.slice(4))).toBe(true);
    expect(event.content).not.toContain(key.slice(4));
  }
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
