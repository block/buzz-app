import { test, expect } from "./fixture.mjs";
import {
  closeSettings,
  openPage,
  openSettings,
  selectSettingsSection,
  sendOnlyTo,
} from "./navigation.mjs";
import { setPluginEnabled } from "./plugin-settings.mjs";
import { settle } from "./timeline.mjs";

const chat = "33333333-3333-4333-8333-333333333333";
const agent =
  "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
test.use({
  productionBroker: true,
  localAgentActivity: "resumable",
  channelIds: [chat],
  channelNames: { [chat]: "Project planning" },
  soloChannels: [chat],
  ownSoloChannels: [chat],
  sessionMembers: { [chat]: [agent] },
  historyCounts: { [chat]: 1 },
});

// App composition: real Solo admission, live work projection and popover controls.
// The fixture holds external work at an explicit handover boundary.
test("Solo follow-ups share one agent Activity row", async ({
  page,
  app,
}, testInfo) => {
  await page.goto(app.origin);
  await openPage(page, "Messages");
  await page
    .getByRole("navigation", { name: "Solo conversations" })
    .locator(`[data-solo-channel-id="${chat}"]`)
    .click();
  await expect
    .poll(() => page.evaluate(() => !!window.localAgentFixture))
    .toBe(true);
  await sendOnlyTo(
    page,
    page.getByRole("button", { name: /Change agents$|^Choose agent$/ }),
    { name: "Local tester", pubkey: agent },
  );
  const editor = page.getByRole("textbox", {
    name: "Message your agents",
    exact: true,
  });
  await editor.fill("Review the project plan");
  await editor.press("Enter");
  await expect
    .poll(() => page.evaluate(() => window.localAgentFixture.pending().length))
    .toBe(1);
  const first = await page.evaluate(
    () => window.localAgentFixture.pending()[0],
  );
  await page.evaluate((id) => {
    window.localAgentFixture.handover(id);
    window.localAgentFixture.step(id, "Read", "notes.txt");
  }, first);
  await editor.fill("Also check the schedule");
  await editor.press("Enter");
  await expect
    .poll(() => page.evaluate(() => window.localAgentFixture.pending().length))
    .toBe(2);
  const activity = page.locator("[data-conversation-activity]");
  // Live message bubbles own the working cue. Without that plugin, the host
  // fallback still groups continuous Solo work into one actionable row.
  await expect(
    page.getByRole("button", { name: /^View agent activity:/ }),
  ).toHaveCount(1);
  const second = await page.evaluate(
    () => window.localAgentFixture.pending()[1],
  );
  await page.evaluate((id) => {
    window.localAgentFixture.handover(id);
    window.localAgentFixture.step(id, "Read", "follow-up.txt");
  }, second);
  await expect(
    page.getByRole("button", {
      name: "View agent activity: Local tester, Reading notes.txt",
      exact: true,
    }),
  ).toHaveCount(1);
  await settle(page);
  await page.screenshot({
    path: testInfo.outputPath("solo-followups-message-bubble.png"),
  });
  await expect(activity).toHaveCount(0);
  await openSettings(page);
  await selectSettingsSection(page, "Manage plugins");
  await page
    .getByRole("button", { name: "Manage plugins", exact: true })
    .click();
  await setPluginEnabled(page, "Agent Activity", false);
  await closeSettings(page);
  await activity
    .getByRole("button", { name: "Reading notes.txt", exact: true })
    .click();
  const stop = page.getByRole("button", {
    name: "Stop Local tester",
    exact: true,
  });
  await expect(stop).toHaveCount(1);
  await expect(page.getByText(/^Thread ·/)).toHaveCount(0);
  for (const colorScheme of ["light", "dark"]) {
    await page.emulateMedia({ colorScheme });
    for (const width of [390, 1280]) {
      await page.setViewportSize({ width, height: 720 });
      await expect(stop).toBeVisible();
      await expect
        .poll(async () => (await stop.boundingBox())?.x ?? -1)
        .toBeGreaterThanOrEqual(0);
      await expect
        .poll(async () => {
          const box = await stop.boundingBox();
          return box ? box.x + box.width : Number.POSITIVE_INFINITY;
        })
        .toBeLessThanOrEqual(width);
      await page.screenshot({
        path: testInfo.outputPath(`solo-activity-${colorScheme}-${width}.png`),
      });
    }
  }
  await stop.focus();
  await page.keyboard.press("Enter");
  await expect
    .poll(() => page.evaluate(() => window.localAgentFixture.stopped()))
    .toEqual([first]);
  await expect(stop).toHaveCount(1);
  await expect(
    activity.getByRole("button", {
      name: "Reading follow-up.txt",
      exact: true,
    }),
  ).toBeVisible();
});
