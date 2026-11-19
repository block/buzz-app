import { test, expect } from "./fixture.mjs";
import { anchor, expectAnchor, open, settle, wheel } from "./timeline.mjs";

test.use({
  pluginFixtures: true,
  historyCounts: { alpha: 20, beta: 20 },
  viewport: { width: 1200, height: 650 },
});

const history = (page) =>
  page.getByRole("region", { name: "Channel message history" });
const thread = (page) =>
  page.getByRole("region", { name: "Thread messages", exact: true });
const gap = (region) =>
  region.evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop);
const reselect = (page) =>
  page.getByRole("button", { name: "Reselect transcript" }).click();

async function select(page, params) {
  expect(
    await page.evaluate(
      (params) =>
        window.fixtureNavigation.open({
          version: 1,
          kind: "page",
          pluginId: "fixture.session",
          pageId: "reader",
          route: { version: 1, params },
        }),
      params,
    ),
  ).toEqual({ status: "opened" });
}

async function expectBottom(page, region) {
  await expect.poll(() => gap(region)).toBeLessThan(4);
  await settle(page, region);
  expect(await gap(region)).toBeLessThan(4);
}

async function readEarlier(page, region) {
  await region.hover();
  await wheel(page, -450, region);
  await expect.poll(() => gap(region)).toBeGreaterThan(200);
  await settle(page, region);
}

test("a workspace opens at the end on selection and reselect, and restores reading on Back and Forward", async ({
  page,
  app,
}) => {
  const region = history(page);
  await open(page, app);
  await readEarlier(page, region);

  await select(page, { channelId: "alpha" });
  await expectBottom(page, region);
  await readEarlier(page, region);
  await reselect(page);
  await expectBottom(page, region);
  await readEarlier(page, region);
  const alpha = await anchor(page);

  await select(page, { channelId: "beta" });
  await expectBottom(page, region);
  await readEarlier(page, region);
  const beta = await anchor(page);

  await page.goBack();
  await expectAnchor(page, alpha);
  await page.goForward();
  await expectAnchor(page, beta);
});

test.describe("thread workspace", () => {
  test.use({ exactMessages: true });

  test("reselect moves the retained reader to the end and an explicit reply still wins", async ({
    page,
    app,
  }) => {
    await open(page, app);
    const region = thread(page);
    const target = { channelId: "alpha", threadId: app.exact.root.id };
    await select(page, target);
    await expectBottom(page, region);
    await readEarlier(page, region);
    await page
      .getByRole("button", { name: "Jump retained transcript" })
      .click();
    await expectBottom(page, region);
    await readEarlier(page, region);

    const messageId = app.exact.replies.at(-20).id;
    await select(page, { ...target, messageId });
    await expect(
      region.locator(`[data-message-id="${messageId}"]`),
    ).toBeInViewport();
    await settle(page, region);
    expect(await gap(region)).toBeGreaterThan(200);
  });
});
