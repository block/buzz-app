import { test, expect } from "./fixture.mjs";
import { openPage } from "./navigation.mjs";

const channel = "f12918e7-88d0-4ddd-aa6b-d4888ff6d3bd";
test.use({
  productionBroker: true,
  readState: true,
  inboxThreadWindow: true,
  channelIds: ["alpha", channel],
  channelNames: { [channel]: "Archived room" },
  historyCounts: { alpha: 1, [channel]: 0 },
  lifecycleVisibility: { archived: [channel], hidden: [] },
});

// The compiled app and production broker must admit archived-channel reads
// while preserving the shared composer's posting restriction and read storage.
test("reads an archived-channel mention and persists local unread without enabling replies", async ({
  page,
  app,
}) => {
  await page.goto(app.origin);
  await openPage(page, "Inbox");
  const inbox = page.getByRole("region", { name: "Inbox", exact: true });
  const rows = inbox
    .getByRole("list", { name: "Inbox conversations" })
    .getByRole("listitem");
  await expect(rows).toHaveCount(1);
  await rows.getByRole("button", { name: /^Open / }).click();
  const detail = inbox.getByRole("region", { name: "Inbox detail" });
  await expect(
    detail.locator(`[data-message-id="${app.inboxWindow.root.id}"]`),
  ).toBeVisible();
  await expect(detail.getByRole("textbox")).toBeDisabled();
  await expect(rows.getByRole("img", { name: "Unread" })).toHaveCount(0);
  await rows.getByRole("button", { name: /^Open / }).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Mark unread" }).click();
  await expect(rows.getByRole("img", { name: "Unread" })).toBeVisible();
  await expect(inbox.getByRole("alert")).toHaveCount(0);
  await page.reload();
  await openPage(page, "Inbox");
  await expect(rows).toHaveCount(1);
  await expect(rows.getByRole("img", { name: "Unread" })).toBeVisible();
  await rows.getByRole("button", { name: /^Open / }).click();
  await expect(
    detail.locator(`[data-message-id="${app.inboxWindow.root.id}"]`),
  ).toBeVisible();
  await expect(detail.getByRole("textbox")).toBeDisabled();
  await expect(inbox.getByRole("alert")).toHaveCount(0);
});
