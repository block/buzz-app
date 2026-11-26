import { test, expect } from "./fixture.mjs";

// The fixture fails any relay read it doesn't expect, so this also proves the
// device index reads nothing of its own, not even on connect.
test.use({ productionBroker: true });
test("searching this device shows its rows on the key and the relay's below them", async ({
  page,
  app,
}) => {
  await page.addInitScript(() =>
    localStorage.setItem("buzz-search-device.v1", "on"),
  );
  await page.goto(app.origin);
  await expect(page.locator("[data-message-id]").first()).toBeVisible();
  app.append("primary", "alpha", "deploy rollback quartz");
  // Only the relay holds this one.
  app.append("primary", "alpha", "relay only quartz", false, false);
  await expect(page.getByText("deploy rollback quartz")).toBeVisible();
  await page.getByRole("button", { name: "Search Buzz", exact: true }).click();
  const input = page.getByRole("combobox", { name: "Search Buzz" });
  const rows = page.locator("[data-search-result]");
  // The relay matches substrings, so only the device finds these letters.
  await input.fill("dplyrlbk");
  await expect(
    rows.filter({ hasText: "deploy rollback quartz" }),
  ).toBeVisible();
  await input.fill("quartz");
  await expect(rows.filter({ hasText: "relay only quartz" })).toBeVisible();
  const texts = await rows.allInnerTexts();
  const at = (text) => texts.findIndex((shown) => shown.includes(text));
  expect(at("relay only quartz")).toBeGreaterThan(at("deploy rollback quartz"));
  expect(
    texts.filter((shown) => shown.includes("deploy rollback")),
  ).toHaveLength(1);
});
