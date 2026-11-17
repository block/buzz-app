import { test, expect } from "./fixture.mjs";
import { conversationList, openPage } from "./navigation.mjs";

// Real layout cannot be inferred from jsdom.
test.use({
  productionBroker: true,
  readState: true,
  threadUnread: true,
  threadUnreadMentions: true,
  inboxDm: true,
  historyCounts: { alpha: 2, beta: 1 },
});

// Only a browser can prove that the sibling Mark as read control leaves readable
// label space when the host's interface size doubles at a narrow width.
test("narrow enlarged-text rows overlay Mark as read without erasing their labels", async ({
  page,
  app,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => {
    localStorage.setItem("buzz-font-scale.v1", "2");
  });
  await page.goto(app.origin);
  await openPage(page, "Activity");
  const list = conversationList(page);
  const items = list.getByRole("listitem");
  const check = (row) => row.getByRole("button", { name: "Mark as read" });
  await expect(items.first()).toBeVisible();
  const unread = items
    .filter({ has: page.getByRole("button", { name: "Mark as read" }) })
    .first();
  await expect(unread).toBeVisible();
  // Pin the row, which leaves that filter once it is read.
  const row = list.locator(
    await unread.evaluate((element) => {
      const [name, value] = [...element.attributes]
        .map((attribute) => [attribute.name, attribute.value])
        .find(([name]) => name.startsWith("data-activity-"));
      return `[${name}="${value}"]`;
    }),
  );
  const open = row.locator("[data-conversation-row]");
  const total = await items.count();
  const geometry = () =>
    row.evaluate((element) => {
      const open = element.querySelector("[data-conversation-row]");
      const label = open.querySelector(".navigation-item-label");
      const action = open.nextElementSibling;
      const box = (node) => {
        const { x, y, width, height } = node.getBoundingClientRect();
        return { x, y, width, height };
      };
      return {
        root: parseFloat(getComputedStyle(document.documentElement).fontSize),
        row: box(element),
        open: box(open),
        label: box(label),
        action: box(action),
      };
    });
  const measured = await geometry();
  // NavigationItem truncates long labels at enlarged text sizes; this checks
  // that Mark as read reserves no additional inline space, not full visual acceptance.
  expect(measured.label.width).toBeGreaterThanOrEqual(2 * measured.root);
  expect(measured.open.x + measured.open.width).toBe(
    measured.row.x + measured.row.width,
  );
  expect(measured.action.y).toBeGreaterThanOrEqual(measured.open.y);
  expect(measured.action.y + measured.action.height).toBeLessThanOrEqual(
    measured.open.y + measured.open.height,
  );
  await open.focus();
  await expect(check(row).locator("xpath=..")).toHaveCSS("opacity", "1");
  await expect(row.locator('[class*="_time_"]')).toHaveCSS("opacity", "0");
  await check(row).click();
  // With Unread off the row stays, read: its ✓ goes and its date returns.
  await expect(row.getByRole("img", { name: "Unread" })).toHaveCount(0);
  await expect(check(row)).toHaveCount(0);
  await expect(items).toHaveCount(total);
  await expect(row.locator('[class*="_time_"]')).toHaveCSS("opacity", "1");
  // Row actions never open a conversation.
  await expect(
    page.getByRole("region", { name: /^Conversation in / }),
  ).toHaveCount(0);
  const filters = page.getByRole("button", {
    name: "Filter and sort conversations",
    exact: true,
  });
  const menu = page.getByRole("menu", {
    name: "Filter and sort conversations",
  });
  const mentions = page
    .getByRole("tablist", { name: "Conversation view" })
    .getByRole("tab", { name: "Mentions", exact: true });
  await mentions.click();
  await expect(mentions).toHaveAttribute("aria-selected", "true");
  await filters.click();
  await menu
    .getByRole("menuitemradio", { name: "Agents", exact: true })
    .click();
  await expect(menu).toHaveCount(0);
  await filters.click();
  await expect(
    menu.getByRole("menuitemradio", { name: "Agents", exact: true }),
  ).toBeChecked();
  await page.keyboard.press("Escape");
  await expect
    .poll(() =>
      filters.evaluate((element) => element.getBoundingClientRect().right),
    )
    .toBeLessThanOrEqual(390);
});
