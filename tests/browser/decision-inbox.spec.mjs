import { test, expect } from "./fixture.mjs";
import { open } from "./timeline.mjs";
import { openPage } from "./navigation.mjs";

test.use({ productionBroker: true, historyCounts: { alpha: 1, beta: 1 } });

// Browser-only boundary: the built app's message menu, plugin page registration,
// source navigation and responsive surface work together.
test("capture a source message and finish its decision handoff", async ({
  page,
  app,
}, testInfo) => {
  await open(page, app);
  const source = app.append("primary", "alpha", "Pilot source message");
  const row = page.locator(
    `[data-channel-timeline] [data-message-id="${source.id}"]`,
  );
  await expect(row).toBeVisible();
  const actions = row.getByRole("button", { name: "More message actions" });
  await actions.focus();
  await actions.press("Enter");
  await page.getByRole("menuitem", { name: "Save to Decision Inbox" }).click();
  const capture = page.getByRole("dialog", { name: "Save to Decision Inbox" });
  await capture
    .getByRole("textbox", { name: "Question or decision needed" })
    .fill("Ship the pilot?");
  await capture.getByRole("textbox", { name: "Next actor" }).fill("Morgan");
  await capture.getByRole("button", { name: "Save" }).click();
  await expect(capture).toBeHidden();

  await openPage(page, "Decision Inbox");
  const inbox = page.getByRole("region", { name: "Decision Inbox" });
  await expect(inbox.getByText("Ship the pilot?")).toBeVisible();
  await expect(
    inbox.getByText("Next: Laura decides · Then: Morgan"),
  ).toBeVisible();
  await inbox.getByRole("button", { name: "Update" }).click();
  const edit = page.getByRole("dialog", { name: "Update decision" });
  await edit
    .getByRole("textbox", { name: "Decision Optional" })
    .fill("Ship tomorrow");
  await edit.getByRole("combobox", { name: "Status" }).click();
  await page
    .getByRole("option", { name: "Decision made · awaiting handoff" })
    .click();
  await edit.getByRole("button", { name: "Save" }).click();
  await expect(inbox.getByText("Next: Hand off to Morgan")).toBeVisible();
  await inbox.getByRole("button", { name: "Update" }).click();
  await edit.getByRole("combobox", { name: "Status" }).click();
  await page.getByRole("option", { name: "Handed off · done" }).click();
  await edit.getByRole("button", { name: "Save" }).click();
  await expect(inbox.getByText("Handed off to Morgan")).toBeVisible();

  const mode = testInfo.project.name === "webkit" ? "dark" : "light";
  await page.evaluate((value) => {
    document.documentElement.dataset.colorMode = value;
  }, mode);
  await page.mouse.move(0, 0);
  await page.screenshot({
    path: testInfo.outputPath(`decision-inbox-${mode}.png`),
  });
  await page.setViewportSize({ width: 480, height: 800 });
  await page.evaluate(() => {
    document.documentElement.style.fontSize = "125%";
  });
  await expect(
    inbox.getByRole("button", { name: "Open source" }),
  ).toBeVisible();
  expect(
    await inbox.evaluate(
      (element) => element.scrollWidth <= element.clientWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: testInfo.outputPath(`decision-inbox-narrow-${mode}.png`),
  });
  await inbox.getByRole("button", { name: "Open source" }).click();
  await expect(
    page.locator(`[data-message-id="${source.id}"]`).first(),
  ).toBeVisible();
});
