import { fileURLToPath } from "node:url";
import { test, expect } from "./fixture.mjs";
import { clickRow, open } from "./timeline.mjs";

// Browser-only: only real history proves the media viewer adds no step to
// it, and the intro's steps anchor to the sheet's settled header.
test.use({ threadPlacement: "inline" });

const photo = [
  ["imeta", "url https://primary.example/media/photo.png", "m image/png"],
];
test("media opens fullscreen under inline, as under tabs, without a history step", async ({
  page,
  app,
  context,
}) => {
  await context.route("**/api/relay/primary/media?**", (route) =>
    route.fulfill({
      path: fileURLToPath(
        new URL("../../public/shell-gradient.png", import.meta.url),
      ),
      contentType: "image/png",
    }),
  );
  await open(page, app);
  const event = app.append(
    "primary",
    "alpha",
    "Inline media",
    true,
    true,
    undefined,
    undefined,
    photo,
  );
  app.append("primary", "alpha", "Media comment", false, true, event.id);
  const filler = "More of it follows here. ".repeat(30).trim();
  app.append(
    "primary",
    "alpha",
    `Comment findings\n\n${filler}`,
    false,
    true,
    event.id,
    undefined,
    [["audience", "details"]],
  );
  const row = page
    .getByRole("region", { name: "Channel message history" })
    .locator(`[data-message-id="${event.id}"]`);
  const steps = await page.evaluate(() => history.length);
  await clickRow(
    page,
    row.getByRole("link", { name: "Open image attachment", exact: true }),
  );
  const viewer = page.getByRole("dialog");
  await expect(viewer).toBeVisible();
  await expect(page.locator("[data-details-sheet-surface]")).toHaveCount(0);
  const comments = viewer.getByRole("complementary", {
    name: "Media comments",
  });
  await expect(
    comments.getByText("Media comment", { exact: true }),
  ).toBeVisible();
  await expect(
    comments.getByRole("textbox", { name: "Reply to thread" }),
  ).toBeVisible();
  // Details among the comments expand in place, under no dialog of their own.
  const findings = comments
    .locator("[data-message-id]")
    .filter({ hasText: "Comment findings" });
  await findings
    .getByRole("button", { name: "Show more", exact: true })
    .click();
  await expect(
    findings.getByRole("button", { name: "Show less", exact: true }),
  ).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByRole("dialog")).toHaveCount(1);
  expect(await page.evaluate(() => history.length)).toBe(steps);
  await viewer
    .getByRole("button", { name: "Close fullscreen viewer", exact: true })
    .click();
  await expect(viewer).toHaveCount(0);
  expect(await page.evaluate(() => history.length)).toBe(steps);
});

test.describe("Intro", () => {
  test.use({
    threadIntro: true,
    productionBroker: true,
    readState: true,
    threadUnread: true,
    historyCounts: { alpha: 20, beta: 1 },
  });

  test("the first inline thread introduces itself once", async ({
    page,
    app,
  }) => {
    await open(page, app);
    const [root] = app.histories
      .get("primary/alpha")
      .filter((row) => row.content.startsWith("Thread root"));
    const viewThread = page
      .locator(`[data-channel-timeline] [data-message-id="${root.id}"]`)
      .getByRole("button", { name: /^View thread:/ });
    await clickRow(page, viewThread);
    const first = page.locator('[data-inline-thread-intro="1"]');
    await expect(first).toBeVisible();
    await expect(first).toContainText("Threads now open inline");
    await first.getByRole("button", { name: "Next" }).click();
    const second = page.locator('[data-inline-thread-intro="2"]');
    await expect(second).toBeVisible();
    await expect(
      second.getByRole("switch", { name: "Open threads inline" }),
    ).toBeChecked();
    await second.getByRole("button", { name: "Got it" }).click();
    await expect(second).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(
      page.getByRole("heading", { name: "Thread", exact: true }),
    ).toHaveCount(0);
    await clickRow(page, viewThread);
    await expect(
      page.getByRole("heading", { name: "Thread", exact: true }),
    ).toBeVisible();
    await expect(page.locator("[data-inline-thread-intro]")).toHaveCount(0);
  });
});
