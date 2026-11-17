import { test, expect } from "./fixture.mjs";
import { stopRoutes } from "./playwright-test.mjs";
import { open } from "./timeline.mjs";
import {
  channelRow,
  closeSettings,
  hideNarrowConversationList,
  openSettings,
  selectSettingsSection,
  settingsDialog,
  settingsSections,
  showConversationList,
} from "./navigation.mjs";

// Team's list column: its rendered width, whether or not it is reachable.
const listColumn = (page) => page.locator("[data-list-open] > :first-child");
const listWidth = (page) =>
  listColumn(page).evaluate((element) => element.getBoundingClientRect().width);

// Settings is its own rail destination: Team's list column is not mounted
// while it is open, and returns at the saved width when Settings closes.
const channels = (page) =>
  page.getByRole("list", { name: "Conversations", exact: true });
const mountedChannels = (page) =>
  page.getByRole("list", {
    name: "Conversations",
    exact: true,
    includeHidden: true,
  });

const resizeHandle = (page) =>
  page.getByRole("separator", { name: "Resize sidebar", exact: true });

// Real shell layout and route remounts must preserve the user's resized width.
test("Settings keeps the list column width across navigation and reload", async ({
  page,
  app,
}) => {
  await open(page, app);
  const handle = resizeHandle(page);
  for (const [key, width] of [
    ["Home", 220],
    ["End", 520],
  ]) {
    await handle.press(key);
    await expect.poll(() => listWidth(page)).toBe(width);
    await openSettings(page);
    await expect(mountedChannels(page)).toHaveCount(0);
    await selectSettingsSection(page, "Notifications");
    await page.reload();
    await expect(settingsDialog(page)).toBeVisible();
    await expect(mountedChannels(page)).toHaveCount(0);
    await closeSettings(page);
    await expect(channels(page)).toBeVisible();
    await expect.poll(() => listWidth(page)).toBe(width);
  }
});

// Settings has no drawer of its own; at narrow widths it stacks its
// navigation, and Team's list returns at its saved width afterwards.
test("narrow Settings keeps the saved list width for Team's list", async ({
  page,
  app,
}) => {
  await open(page, app);
  await resizeHandle(page).press("End");
  await expect.poll(() => listWidth(page)).toBe(520);
  await page.setViewportSize({ width: 600, height: 950 });
  // Too narrow for both, the list lies over the reader within its frame.
  await showConversationList(page);
  const frame = await page.locator("[data-detail-workspace]").boundingBox();
  await expect.poll(() => listWidth(page)).toBeLessThanOrEqual(frame.width);
  const conversation = page.locator("[data-list-page]");
  const contentWidth = (await conversation.boundingBox()).width;
  await channelRow(page, "beta").press("Enter");
  const composer = page.getByRole("textbox", {
    name: "Message #Beta",
    exact: true,
  });
  await expect(composer).toBeVisible();
  await hideNarrowConversationList(page);
  expect((await conversation.boundingBox()).width).toBe(contentWidth);
  await composer.click();
  await page.keyboard.type("Usable destination");
  await expect(composer).toHaveText("Usable destination");
  await composer.fill("");
  const showNavigation = page.getByRole("button", {
    name: "Show navigation",
    exact: true,
  });
  await expect(showNavigation).toBeVisible();
  await openSettings(page);
  // The workspace's drawer toggle is behind the modal; Settings keeps its own
  // section navigation in view instead of a drawer.
  await expect(showNavigation).toHaveCount(0);
  const sections = settingsSections(page);
  await expect(sections).toBeInViewport();
  const notifications = sections.getByRole("button", {
    name: "Notifications",
    exact: true,
  });
  await notifications.press("Enter");
  await expect(notifications).toHaveAttribute("aria-current", "page");
  await expect(
    page.getByRole("region", { name: "Notifications", exact: true }),
  ).toBeVisible();
  // Selecting the current section is a new attempt, not a new history visit.
  await notifications.press("Enter");
  await expect(notifications).toHaveAttribute("aria-current", "page");
  await page.goBack();
  await expect(
    sections.getByRole("button", { name: "Profile", exact: true }),
  ).toHaveAttribute("aria-current", "page");
  await closeSettings(page);
  await expect(composer).toBeVisible();
  await page.setViewportSize({ width: 1440, height: 950 });
  await showConversationList(page);
  await expect.poll(() => listWidth(page)).toBe(520);
});

test("list width survives route remounts when saving it fails", async ({
  page,
  app,
}) => {
  await open(page, app);
  await page.evaluate(() => {
    const setItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (
        key.startsWith("buzz-view.v1:") &&
        key.includes('"channel-sidebar"')
      ) {
        throw new DOMException("Storage full", "QuotaExceededError");
      }
      return setItem.call(this, key, value);
    };
  });
  await resizeHandle(page).press("End");
  await expect.poll(() => listWidth(page)).toBe(520);
  await openSettings(page);
  await expect(mountedChannels(page)).toHaveCount(0);
  // Section changes are route changes; the unsaved width survives them.
  await selectSettingsSection(page, "Notifications");
  await expect(mountedChannels(page)).toHaveCount(0);
  await closeSettings(page);
  await expect(channels(page)).toBeVisible();
  await expect.poll(() => listWidth(page)).toBe(520);
});

// Native storage delivery and rendered width across two real documents are not
// established by the component's synthetic StorageEvent tests.
test("list width updates across open windows without losing a draft", async ({
  page,
  context,
  app,
}) => {
  await open(page, app);
  const resize = resizeHandle(page);
  const composer = page.getByRole("textbox", {
    name: "Message #Alpha",
    exact: true,
  });
  await composer.fill("Keep this draft while another window resizes");
  await resize.press("End");
  await expect.poll(() => listWidth(page)).toBe(520);
  const other = await context.newPage();
  app.watchPageErrors(other);
  try {
    await open(other, app);
    await expect.poll(() => listWidth(other)).toBe(520);
    await openSettings(other);
    // Settings has no list; resize from the restored workspace.
    await closeSettings(other);
    await expect.poll(() => listWidth(other)).toBe(520);
    await resizeHandle(other).press("Home");
    await expect.poll(() => listWidth(page)).toBe(220);
    await expect(composer).toHaveText(
      "Keep this draft while another window resizes",
    );
    // A width saved while the other window shows Settings is the one its
    // list returns with.
    await openSettings(other);
    await resize.press("ArrowRight");
    await expect.poll(() => listWidth(page)).toBe(236);
    await closeSettings(other);
    await expect.poll(() => listWidth(other)).toBe(236);
    await openSettings(other);
    await other.reload();
    await expect(settingsDialog(other)).toBeVisible();
    await expect(mountedChannels(other)).toHaveCount(0);
    await closeSettings(other);
    await expect.poll(() => listWidth(other)).toBe(236);
  } finally {
    await stopRoutes(context);
    await other.close();
  }
});
