import { test, expect } from "./fixture.mjs";
import {
  closeSettings,
  openSettings,
  selectSettingsSection,
} from "./navigation.mjs";
import { setPluginEnabled } from "./plugin-settings.mjs";
import { open } from "./timeline.mjs";

test.use({
  pluginFixtures: true,
  enabledPlugins: ["fixture.message-link"],
  historyCounts: { alpha: 3, beta: 0 },
});

const scope = (app) => ({
  viewer: app.viewer,
  communityOrigin: "https://primary.example",
});
const state = (page) =>
  page.evaluate(() => window.fixtureNavigation.snapshot());
const offers = (page) => page.evaluate(() => window.fixtureMessageLinks.seen);
const destination = (page) =>
  page.getByText("Contributed message destination", { exact: true });
const row = (page, id) => page.locator(`[data-message-id="${id}"]`);

async function links(page, app) {
  await open(page, app);
  const root = app.append("primary", "alpha", "Original message");
  const reply = app.append(
    "primary",
    "alpha",
    "Linked reply",
    true,
    true,
    root.id,
  );
  const plain = app.append("primary", "alpha", "Standalone message");
  const href = (channel, id) => `buzz://message?channel=${channel}&id=${id}`;
  const urls = [
    `${href("alpha", reply.id)}&thread=${"f".repeat(64)}`,
    href("alpha", plain.id),
    href("beta", reply.id),
  ];
  const source = app.append(
    "primary",
    "alpha",
    urls.map((url) => `<${url}>`).join(" "),
  );
  const activate = async (index) => {
    const link = row(page, source.id).locator(`a[href="${urls[index]}"]`);
    await expect(link).toBeVisible();
    await link.press("Enter");
  };
  return { root, reply, plain, activate };
}

test("a verified link resolves in place and rechecks the message on reclick and Forward", async ({
  page,
  app,
}) => {
  const { root, reply, activate } = await links(page, app);
  const source = (await state(page)).entry;
  await activate(0);
  await expect(destination(page)).toBeVisible();
  const resolved = (await state(page)).entry;
  expect(resolved.target).toMatchObject({
    kind: "page",
    scope: scope(app),
    route: { version: 1, params: reply.id },
  });
  const admitted = {
    scope: scope(app),
    channelId: "alpha",
    messageId: reply.id,
    threadRootId: root.id,
  };
  expect(await offers(page)).toEqual([admitted]);

  // The browser address is still the exact original message link. Reopening
  // that address should make a fresh offer without adding a duplicate visit.
  const address = page.url();
  await page.evaluate((target) => window.fixtureNavigation.open(target), {
    version: 1,
    kind: "conversation",
    scope: scope(app),
    channelId: "alpha",
    messageId: reply.id,
    threadRootId: "f".repeat(64),
    messageLink: true,
  });
  await expect(destination(page)).toBeVisible();
  expect(await offers(page)).toEqual([admitted, admitted]);
  expect((await state(page)).entry.id).toBe(resolved.id);
  expect(page.url()).toBe(address);
  await page.goBack();
  await expect.poll(async () => (await state(page)).entry.id).toBe(source.id);
  await expect(destination(page)).toHaveCount(0);
  await page.goForward();
  await expect(destination(page)).toBeVisible();
  expect((await state(page)).entry.id).toBe(resolved.id);
  expect(await offers(page)).toEqual([admitted, admitted, admitted]);
});

test("declined, failed, invalid and disabled providers leave the ordinary reveal intact", async ({
  page,
  app,
}) => {
  const { plain, reply, activate } = await links(page, app);
  const linked = row(page, plain.id);
  for (const [index, mode] of ["decline", "fail", "invalid"].entries()) {
    await page.evaluate((mode) => {
      window.fixtureMessageLinks.mode = mode;
    }, mode);
    await activate(1);
    await expect(linked).toBeFocused();
    await expect.poll(async () => (await state(page)).status).toBe("opened");
    expect(await offers(page)).toHaveLength(index + 1);
  }
  // A declined reply still opens and settles when revisiting its reading place.
  await activate(0);
  await expect(row(page, reply.id)).toBeFocused();
  await expect.poll(async () => (await state(page)).status).toBe("opened");
  await page.goBack();
  await expect(linked).toBeVisible();
  await page.goForward();
  await expect.poll(async () => (await state(page)).status).toBe("opened");
  expect((await state(page)).entry.target.messageId).toBe(reply.id);
  const beforeDisable = await offers(page);
  expect(
    beforeDisable.filter(({ messageId }) => messageId === reply.id),
  ).toHaveLength(2);
  await openSettings(page);
  await selectSettingsSection(page, "Manage plugins");
  await setPluginEnabled(page, "Message link fixture", false);
  await closeSettings(page);
  await activate(1);
  await expect(linked).toBeFocused();
  await expect.poll(async () => (await state(page)).status).toBe("opened");
  expect(await offers(page)).toEqual(beforeDisable);
  await expect(destination(page)).toHaveCount(0);
});

test("denied channels and mismatched messages never reach the provider", async ({
  page,
  app,
}) => {
  const { reply, activate } = await links(page, app);
  await activate(2);
  await expect.poll(async () => (await state(page)).status).toBe("failed");
  expect((await state(page)).reason).toBe("not-found");
  expect(await offers(page)).toEqual([]);

  const result = await page.evaluate(
    (target) => window.fixtureNavigation.open(target),
    {
      version: 1,
      kind: "conversation",
      scope: scope(app),
      channelId: "5ec2e700-0000-4000-8000-000000000001",
      messageId: reply.id,
      messageLink: true,
    },
  );
  expect(result.status).toBe("failed");
  expect(await offers(page)).toEqual([]);
  await expect(destination(page)).toHaveCount(0);
});

test("leaving while a provider decides aborts its offer and ignores its late result", async ({
  page,
  app,
}) => {
  const { activate } = await links(page, app);
  await page.evaluate(() => {
    window.fixtureMessageLinks.mode = "hold";
  });
  await activate(1);
  try {
    await expect
      .poll(() => page.evaluate(() => !!window.fixtureMessageLinks.release))
      .toBe(true);
    await page.getByRole("button", { name: "Beta", exact: true }).click();
    await expect
      .poll(async () => (await state(page)).entry.target.channelId)
      .toBe("beta");
    await expect
      .poll(() =>
        page.evaluate(() => window.fixtureMessageLinks.signal.reason?.name),
      )
      .toBe("AbortError");
  } finally {
    await page.evaluate(() => window.fixtureMessageLinks.release?.());
  }
  await expect.poll(async () => (await state(page)).status).toBe("opened");
  expect((await state(page)).entry.target.channelId).toBe("beta");
  await expect(destination(page)).toHaveCount(0);
});

test("a verified reply still reveals while a legacy thread read withholds its root", async ({
  page,
  app,
}) => {
  const { reply, activate } = await links(page, app);
  let intercepted;
  const started = new Promise((resolve) => {
    intercepted = resolve;
  });
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  await page.route("**/api/relay/primary/query", async (route) => {
    if (
      !route
        .request()
        .postDataJSON()
        .some((filter) => filter.depth_limit)
    )
      return route.continue();
    intercepted();
    await held;
    await route.continue().catch(() => {});
  });
  try {
    await activate(0);
    await started;
    await expect(row(page, reply.id)).toBeFocused();
    await expect.poll(async () => (await state(page)).status).toBe("opened");
    expect(await offers(page)).toEqual([]);
  } finally {
    release();
  }
});
