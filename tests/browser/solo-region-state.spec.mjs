import { test, expect } from "./fixture.mjs";
import { setPluginEnabled } from "./plugin-settings.mjs";
import {
  closeSettings,
  newChat,
  openSettings,
  selectSettingsSection,
} from "./navigation.mjs";
import { showRail, soloRow } from "./rail-helpers.mjs";

const alpha = "33333333-3333-4333-8333-333333333333";
const beta = "44444444-4444-4444-8444-444444444444";

test.use({
  pluginFixtures: true,
  historyCounts: { alpha: 0, beta: 0 },
});

// Real storage events between windows and app startup are outside jsdom's
// boundary. The rail renders no source component, so read the source's state.
const savedState = (page) =>
  page.evaluate(() => {
    try {
      return window.fixtureSoloRegion?.state().get();
    } catch {
      return undefined;
    }
  });

test("region state follows a headless write and a write in another window", async ({
  page,
  app,
  context,
}) => {
  const url = `${app.origin}/?solo-region-fixture&region-state-fixture`;
  await page.goto(url);
  await newChat(page);
  await page.evaluate(() => {
    const fixture = window.fixtureSoloRegion;
    if (!fixture.state().set({ filter: "running" }))
      throw new Error("Write failed");
    fixture.status("ready");
  });
  await expect.poll(() => savedState(page)).toEqual({ filter: "running" });
  const other = await context.newPage();
  await other.goto(url);
  await newChat(other);
  await other.evaluate(() => {
    const fixture = window.fixtureSoloRegion;
    if (!fixture.state().set({ filter: "needs-you" }))
      throw new Error("Write failed");
  });
  await expect.poll(() => savedState(page)).toEqual({ filter: "needs-you" });
  await page.reload();
  await expect.poll(() => savedState(page)).toEqual({ filter: "needs-you" });
  await page.evaluate(() => window.fixtureSoloRegion.status("ready"));
  await expect.poll(() => savedState(page)).toEqual({ filter: "needs-you" });
});

test.describe("disabled plugin chat fallback", () => {
  test.use({
    productionBroker: true,
    channelIds: [alpha, beta],
    channelNames: { [alpha]: "Alpha", [beta]: "Beta" },
    soloChannels: [alpha],
    ownSoloChannels: [alpha],
    historyCounts: { [alpha]: 1, [beta]: 0 },
  });

  // The rail renders no source UI. A source that does not hide its chats
  // leaves them in the Solo card, so a classified chat stays there while its
  // plugin turns off and on, and the open conversation keeps its history.
  test("keeps a classified chat in Solo while its plugin turns off and on", async ({
    page,
    app,
  }) => {
    await page.goto(`${app.origin}/?solo-region-fixture`);
    await newChat(page);
    await page.evaluate(async (id) => {
      await window.fixtureSoloRegion.createWorkspace();
      await window.fixtureSoloRegion.classify(id);
    }, alpha);

    const row = soloRow(page, alpha);
    await expect(row).toHaveCount(1);
    await row.click();

    const history = page.getByRole("region", {
      name: "Channel message history",
      exact: true,
    });
    await expect(history.locator("[data-message-id]")).toHaveCount(1);
    const messageId = await history
      .locator("[data-message-id]")
      .getAttribute("data-message-id");

    for (const enabled of [false, true]) {
      await openSettings(page);
      await selectSettingsSection(page, "Manage plugins");
      await setPluginEnabled(page, "Solo region fixture", enabled);
      await closeSettings(page);

      await showRail(page);
      await expect(row).toHaveCount(1);
      await expect(
        page.getByText("The plugin for these chats is off.", { exact: true }),
      ).toHaveCount(0);
      await expect(history.locator("[data-message-id]")).toHaveAttribute(
        "data-message-id",
        messageId,
      );
    }
  });
});
