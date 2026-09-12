import { test, expect } from "./fixture.mjs";
import { open } from "./timeline.mjs";

test.use({ productionBroker: true, readState: true, threadUnread: true });
test("Messages receives scoped typing through authenticated live traffic and expires it without publishing", async ({
  page,
  app,
}, testInfo) => {
  await open(page, app);
  await expect
    .poll(() =>
      app.report.liveRequests.some((r) => r.filter?.["#h"]?.includes("alpha")),
    )
    .toBe(true);
  const indicator = page.getByRole("status", { name: "Typing activity" });
  app.activity({ age: 9 });
  await expect(indicator).toHaveCount(0);
  app.activity();
  await expect(indicator).toContainText("is typing…");
  app.activity({ author: 1 });
  await expect(indicator).toContainText("are typing…");
  await page.screenshot({ path: testInfo.outputPath("messages-typing.png") });
  app.activity({ kind: 9 });
  await expect(indicator).toContainText("is typing…");
  app.activity({ kind: 9, author: 1 });
  await expect(indicator).toHaveCount(0);
  app.activity(); // same-second late pulse cannot resurrect completion
  await expect(indicator).toHaveCount(0);
  const root = app.histories
    .get("primary/alpha")
    .find((e) => e.content === "Thread root 0");
  await page
    .locator(`[data-channel-timeline] [data-message-id="${root.id}"]`)
    .getByRole("button", { name: /^View thread:/ })
    .click();
  const thread = page.getByRole("complementary", {
    name: "Thread",
    exact: true,
  });
  await expect(
    thread.getByRole("textbox", { name: "Reply to thread", exact: true }),
  ).toBeVisible();
  app.activity({ root: root.id });
  await expect(
    thread.getByRole("status", { name: "Typing activity" }),
  ).toContainText("is typing…");
  await expect(indicator).toHaveCount(1);
  await page.screenshot({
    path: testInfo.outputPath("messages-thread-typing.png"),
  });
  // Real browser timer, signed timestamp TTL, no polling transport or fixture cleanup.
  await expect(indicator).toHaveCount(0, { timeout: 10000 });
  expect(app.report.publications).toEqual([]);
});
