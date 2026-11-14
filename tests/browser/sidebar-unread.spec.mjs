import { channelRow, rail } from "./navigation.mjs";
import { test as base, expect } from "./fixture.mjs";
import { streamEvidence } from "./stream-evidence.mjs";
import {
  conversationAction,
  conversationActions,
  openInView,
  showRail,
} from "./rail-helpers.mjs";

// Preserve the failing handoff and capture original-reader delivery on Linux.
const test = base.extend({
  streamEvidence: [streamEvidence, { auto: true }],
});
test.use({
  productionBroker: true,
  readState: true,
  largeSidebar: true,
  sidebarUnread: true,
  historyCounts: { alpha: 20, beta: 20 },
  // Hide conversation, which replaced the sidebar's own Close conversation.
  channelLifecycle: true,
});
const showDms = async (page) => {
  await showRail(page);
  await rail(page).locator('[data-rail-team-view="dms"]').click();
};
const hide = async (page) => {
  await conversationActions(page).click();
  await conversationAction(page, "Hide conversation").click();
  await page
    .getByRole("dialog", { name: "Hide conversation" })
    .getByRole("button", { name: "Hide conversation", exact: true })
    .click();
  await expect(
    page.getByRole("dialog", { name: "Hide conversation" }),
  ).toHaveCount(0);
};

test("DM hide removes its Team row and a new message restores it", async ({
  page,
  app,
}) => {
  await page.goto(app.origin);
  await openInView(page, "dms", "dm-030");
  const dm = channelRow(page, "dm-030");
  await expect(page.getByRole("textbox", { name: /^Message / })).toBeVisible();
  await hide(page);
  await expect(dm).toHaveCount(0);
  await page.reload();
  await showDms(page);
  await expect(channelRow(page, "dm-031")).toBeVisible();
  await expect(dm).toHaveCount(0);

  // Cached paint is intentionally earlier than fresh live subscription ownership.
  await expect.poll(() => app.relay.hasRoute("primary", "dm-030")).toBe(true);
  app.append("primary", "dm-030", "A new live DM", true, false);
  await expect(dm).toBeVisible();
  await dm.click();
  await expect(page.getByRole("textbox", { name: /^Message / })).toBeVisible();
  await hide(page);
  await expect(dm).toHaveCount(0);
  app.append("primary", "dm-030", "A DM missed while closed", false, false);
  await page.reload();
  await showDms(page);
  await expect(channelRow(page, "dm-031")).toBeVisible();
  await expect(dm).toBeVisible();
});
