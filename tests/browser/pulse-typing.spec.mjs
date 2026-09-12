import { test, expect } from "./fixture.mjs";
import { open } from "./timeline.mjs";

test.use({ productionBroker: true, readState: true, threadUnread: true });
test("Pulse composes shared channel/thread typing and clears it on disconnect without publishing", async ({
  page,
  app,
}, testInfo) => {
  await open(page, app);
  await expect.poll(() => app.relay.hasRoute("primary", "alpha")).toBe(true);
  const pages = page.getByRole("navigation", { name: "Pages", exact: true });
  await pages.getByRole("button", { name: "Pulse", exact: true }).click();
  const rail = page.getByRole("navigation", { name: "Pulse conversations" });
  await rail.getByRole("button", { name: "Alpha", exact: true }).click();
  const composer = page.getByRole("textbox", {
    name: "Message #Alpha",
    exact: true,
  });
  await expect(composer).toBeVisible();
  await composer.fill("Unsent fixture draft");
  const indicator = page.getByRole("status", { name: "Typing activity" });
  const subscriptions = app.report.liveRequests.length;
  app.activity();
  await expect(indicator).toContainText("is typing…");
  await page.screenshot({
    path: testInfo.outputPath("pulse-channel-typing.png"),
  });
  await pages.getByRole("button", { name: "Messages", exact: true }).click();
  await expect(indicator).toContainText("is typing…");
  await page.getByRole("button", { name: "Go back", exact: true }).click();
  await expect(composer).toHaveValue("Unsent fixture draft");
  await expect(indicator).toContainText("is typing…");
  expect(app.report.liveRequests).toHaveLength(subscriptions);
  app.activity({ kind: 9 });
  await expect(indicator).toHaveCount(0);
  const root = app.histories
    .get("primary/alpha")
    .find((event) => event.content === "Thread root 0");
  await page
    .locator(`[data-channel-timeline] [data-message-id="${root.id}"]`)
    .getByRole("button", { name: /^View thread:/ })
    .click();
  const panel = page.getByRole("complementary", {
    name: "Thread",
    exact: true,
  });
  await expect(
    panel.getByRole("textbox", { name: "Reply to thread", exact: true }),
  ).toBeVisible();
  app.activity({ root: root.id });
  await expect(
    panel.getByRole("status", { name: "Typing activity" }),
  ).toContainText("is typing…");
  await expect(indicator).toHaveCount(1);
  await page.screenshot({
    path: testInfo.outputPath("pulse-thread-typing.png"),
  });
  app.relay.disconnect("primary");
  await expect(indicator).toHaveCount(0);
  await expect(panel).toBeVisible();
  await panel
    .getByRole("button", { name: "Close thread", exact: true })
    .click();
  await expect(composer).toHaveValue("Unsent fixture draft");
  expect(app.report.publications).toEqual([]);
});
