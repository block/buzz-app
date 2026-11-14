import { test, expect } from "./fixture.mjs";
import { clickRow, open } from "./timeline.mjs";

test.use({
  productionBroker: true,
  readState: true,
  threadUnread: true,
  historyCounts: { alpha: 20 },
});

// Close other tabs keeps the right-clicked tab open, selected and focused.
test("a tab's Close other tabs keeps only that tab", async ({
  page,
  app,
}, testInfo) => {
  await open(page, app);
  const roots = app.histories
    .get("primary/alpha")
    .filter((row) => row.content.startsWith("Thread root"));
  const side = page.locator("[data-panel-workspace]");
  const threadTabs = side.locator('[role="tab"][data-tab-value^="thread:"]');
  expect(roots).toHaveLength(2);
  for (const [index, root] of roots.entries()) {
    await clickRow(
      page,
      page
        .locator(
          `[data-channel-timeline="alpha"] [data-message-id="${root.id}"]`,
        )
        .getByRole("button", { name: /^View thread:/ }),
    );
    await expect(threadTabs).toHaveCount(index + 1);
  }
  // The second thread is selected; keep the first, unselected one.
  const kept = threadTabs.first();
  const keptValue = await kept.getAttribute("data-tab-value");
  await expect(kept).toHaveAttribute("aria-selected", "false");
  await kept.click({ button: "right" });
  const menu = page.getByRole("menu", { name: /^Actions for .* tab$/ });
  // The popup can paint before its animation-frame focus handoff completes.
  await expect(menu).toBeFocused();
  await expect(menu.getByRole("menuitem")).toHaveText([
    "Rename tab",
    "Close other tabs",
    "Close all tabs",
  ]);
  // Capture the resting menu and tab layout, not their entry motion.
  await page.waitForFunction(() =>
    document.getAnimations().every((motion) => motion.playState !== "running"),
  );
  await page.screenshot({ path: testInfo.outputPath("close-others-menu.png") });
  await menu.getByRole("menuitem", { name: "Close other tabs" }).click();
  await expect(menu).toBeHidden();
  await expect(threadTabs).toHaveCount(1);
  await expect(threadTabs).toHaveAttribute("data-tab-value", keptValue);
  await expect(threadTabs).toHaveAttribute("aria-selected", "true");
  await expect(threadTabs).toBeFocused();
  // The channel stays open beside the kept thread.
  await expect(
    page.getByRole("textbox", { name: "Message #Alpha", exact: true }),
  ).toBeVisible();
});
