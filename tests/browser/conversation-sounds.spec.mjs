import { openChannelDetails } from "./channel-details.mjs";
import { test, expect } from "./fixture.mjs";
import { open } from "./timeline.mjs";

test.use({
  dmLabels: true,
  historyCounts: { alpha: 1, beta: 1 },
  video: "on",
});

// Real channel/DM details wiring, keyboard interaction and reload persistence
// need the full app. Notification eligibility/audio policy lives in service tests.
test("channel and DM sound choices stay independent and survive reload", async ({
  page,
  app,
}, info) => {
  await open(page, app);
  const sidebar = page.getByRole("navigation", { name: "Subscribed channels" });
  const panel = page.getByRole("complementary", {
    name: "Channel settings",
    exact: true,
  });
  const picker = panel.getByRole("combobox", {
    name: "Notification sound",
    exact: true,
  });
  async function details(name) {
    await sidebar.getByRole("button", { name, exact: true }).click();
    await openChannelDetails(page);
    await expect(picker).toBeVisible();
  }
  async function choose(name) {
    await picker.click();
    await page.getByRole("option", { name, exact: true }).click();
    await expect(picker).toHaveText(name);
    // Base UI retains a hidden popup; wait for its exit before capturing it.
    await expect(
      page.getByRole("listbox", { includeHidden: true }),
    ).toBeHidden();
  }
  await openChannelDetails(page);
  await expect(picker).toHaveText("Use default");
  const preview = page.waitForResponse(
    (response) => response.url().endsWith("/sounds/ping.mp3") && response.ok(),
  );
  await choose("ping");
  await preview;
  await page.screenshot({ path: info.outputPath("channel-ping.png") });
  await details("Beta");
  await expect(picker).toHaveText("Use default");
  // The keyboard must be able to select Silent, not just pointer interaction.
  await picker.focus();
  await picker.press("Enter");
  const silent = page.getByRole("option", { name: "Silent", exact: true });
  await expect(silent).toBeVisible();
  await page.keyboard.press("Home");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(picker).toHaveText("Silent");
  await details("Alice Fixture");
  await expect(picker).toHaveText("Use default");
  await choose("boo");
  await page.screenshot({ path: info.outputPath("dm-boo.png") });
  await page.reload();
  // Details panes are visit-local; reopen it before checking the saved choice.
  await details("Alice Fixture");
  await expect(picker).toHaveText("boo");
  await details("Alpha");
  await expect(picker).toHaveText("ping");
  await choose("Use default");
  await details("Beta");
  await expect(picker).toHaveText("Silent");
  await details("Alpha");
  await expect(picker).toHaveText("Use default");
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(page.locator("html")).toHaveAttribute("data-color-mode", "dark");
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(picker).toBeInViewport({ ratio: 1 });
  await choose("Silent");
  await page.screenshot({ path: info.outputPath("channel-dark-narrow.png") });
});
