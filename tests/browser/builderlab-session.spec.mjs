import { test as base, expect } from "./fixture.mjs";
import { stopRoutes } from "./playwright-test.mjs";
import { open } from "./timeline.mjs";
import { openSettings, selectSettingsSection } from "./navigation.mjs";

const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const test = base.extend({
  builderlab: async ({ browserName: _browserName }, use) => {
    const opened = [];
    await use({
      opened,
      open: async (url) => {
        opened.push(new URL(url));
      },
      fetch: async () => Response.json({}, { status: 503 }),
    });
  },
});
test.use({
  productionBroker: true,
  builderlabLogin: true,
  developmentReact: true,
  historyCounts: { alpha: 1, beta: 0 },
});

// Two real EventSources share the production broker; a held HTTP failure must
// not change the other page's newer pending state or replace its Cancel action.
test("a late failed login response cannot overwrite another page's pending login", async ({
  page,
  context,
  app,
  builderlab,
}) => {
  const other = await context.newPage();
  app.watchPageErrors(other);
  const failed = deferred();
  const release = deferred();
  const loginUrl = `${app.origin}/api/builderlab/login`;
  app.report.builderlabFailures = [loginUrl]; // Exactly this injected 502, once.
  await page.route(loginUrl, async (route) => {
    const response = await route.fetch();
    failed.resolve(response.status());
    await release.promise;
    await route.fulfill({ response });
  });
  const signIn = (target) =>
    target.getByRole("button", {
      name: "Sign in with Builderlab",
      exact: true,
    });
  const cancel = (target) =>
    target.getByRole("button", { name: "Cancel sign-in", exact: true });
  try {
    for (const target of [page, other]) {
      await open(target, app);
      await openSettings(target);
      await selectSettingsSection(target, "Builderlab");
      await expect(signIn(target)).toBeVisible();
    }
    await signIn(page).click();
    await expect.poll(() => builderlab.opened.length).toBe(1);
    const authorization = builderlab.opened[0];
    await fetch(
      `${authorization.searchParams.get("redirect_uri")}?state=${authorization.searchParams.get("state")}&code=failed-A`,
    );
    expect(await failed.promise).toBe(502);
    await expect(signIn(page)).toBeVisible();
    await expect(signIn(other)).toBeVisible();
    await signIn(other).click();
    await expect.poll(() => builderlab.opened.length).toBe(2);
    await expect(cancel(page)).toBeVisible();
    await expect(cancel(other)).toBeVisible();
    const delivered = page.waitForResponse(
      (response) => response.url() === loginUrl && response.status() === 502,
    );
    release.resolve();
    await (await delivered).finished();
    // Let React commit work queued by the delivered response before checking the action.
    await page.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
    );
    await expect(cancel(page)).toBeVisible();
    await expect(cancel(other)).toBeVisible();
    await expect(page.getByRole("alert")).toHaveCount(0);
    const canceled = other.waitForResponse(
      (response) => response.url() === loginUrl && response.status() === 502,
    );
    await cancel(page).click();
    await (await canceled).finished();
    await expect(signIn(page)).toBeVisible();
    await expect(signIn(other)).toBeVisible();
  } finally {
    release.resolve();
    await fetch(`${app.origin}/api/builderlab/sign-out`, {
      method: "POST",
      headers: { Origin: app.origin },
      body: "{}",
    });
    await stopRoutes(context);
    await other.close();
  }
});
