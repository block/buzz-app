import { test, expect } from "./fixture.mjs";
const pulse = (page) =>
  page
    .getByRole("navigation", { name: "Pages", exact: true })
    .getByRole("button", { name: "Pulse", exact: true });

test("Pulse opens shared threads, follows edits, purges revoked sources and unloads independently", async ({
  page,
  app,
}, testInfo) => {
  // Only model the upstream root/traversal response; the thread owner, composer,
  // verification and application remain real. Publication is not exercised here.
  await page.route("**/api/relay/primary/query", async (route) => {
    const filters = route.request().postDataJSON();
    if (
      filters.some((filter) => filter.ids || filter.depth_limit !== undefined)
    ) {
      const root = app.histories.get("primary/alpha").at(-1);
      const events = filters.some((filter) => filter.ids?.includes(root.id))
        ? [root]
        : [];
      return route.fulfill({ json: events });
    }
    return route.continue();
  });
  await page.goto(app.origin);
  await pulse(page).click();
  await expect(
    page.getByRole("article", { name: "Activity in Alpha" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Open thread / reply" }).click();
  const thread = page.getByRole("complementary", {
    name: "Thread",
    exact: true,
  });
  await expect(thread).toBeVisible();
  const reply = thread.getByRole("textbox", {
    name: "Reply to thread",
    exact: true,
  });
  await reply.fill("A separate reply draft");
  await page.screenshot({ path: testInfo.outputPath("pulse-thread.png") });
  await page.getByRole("button", { name: "Close thread", exact: true }).click();
  await expect(
    page.getByRole("textbox", { name: "Message #Alpha" }),
  ).toHaveValue("");
  await page.getByRole("button", { name: "Back to Pulse" }).click();
  const root = app.histories.get("primary/alpha").at(-1);
  app.edit("primary", "alpha", root, "An updated Pulse source");
  await expect(
    page.getByRole("article", { name: "Activity in Alpha" }),
  ).toContainText("An updated Pulse source");
  await page.getByRole("button", { name: "Open thread / reply" }).click();
  await expect(reply).toHaveValue("A separate reply draft");
  await page.getByRole("button", { name: "Back to Pulse" }).click();
  app.omitChannel("alpha");
  await page.getByRole("button", { name: "Refresh Pulse" }).click();
  await expect(
    page
      .getByRole("navigation", { name: "Pulse conversations" })
      .getByRole("button", { name: "Alpha" }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("article", { name: "Activity in Alpha" }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Your profile" }).click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Plugins", exact: true }).click();
  await page.getByRole("switch", { name: "Enable Pulse", exact: true }).click();
  await expect(pulse(page)).toHaveCount(0);
  await page.getByRole("switch", { name: "Enable Pulse", exact: true }).click();
  await pulse(page).click();
  await expect(
    page.getByRole("article", { name: "Activity in Alpha" }),
  ).toHaveCount(0);
  await expect(
    page
      .getByRole("navigation", { name: "Pulse conversations" })
      .getByRole("button", { name: "Beta" }),
  ).toBeVisible();
});
