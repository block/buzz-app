import { test, expect } from "./fixture.mjs";
import { open, settle } from "./timeline.mjs";
import { watchPageErrors } from "./page-errors.mjs";

// The default fixture broker writes only kind 9; reacting needs kinds 7 and 5.
test.use({ productionBroker: true, historyCounts: { alpha: 3, beta: 1 } });

const composer = (page) =>
  page.getByRole("textbox", { name: "Message #Alpha", exact: true });
const picker = (page) =>
  page.getByRole("dialog", { name: "React to latest message" });
const search = (page) => page.getByRole("searchbox", { name: "Search emoji" });
const pickThumbsUp = async (page) => {
  await search(page).fill("thumbsup");
  await page.locator("em-emoji-picker .category button").first().click();
};

test("the keyboard shortcut toggles a reaction on the newest message and returns focus", async ({
  page,
  app,
}) => {
  const errors = watchPageErrors(page);
  await open(page, app);
  const timeline = page.locator("[data-channel-timeline]");
  const latest = app.append("primary", "alpha", "React to me", true);
  const row = timeline.locator(`[data-message-id="${latest.id}"]`);
  await expect(row).toBeVisible();
  await settle(page);
  await composer(page).fill("Draft stays");
  await page.keyboard.press("ControlOrMeta+Shift+\\");
  await expect(picker(page)).toBeVisible();
  // Reacting is emoji-only; the insert picker's GIF tab stays out of this mode.
  await expect(page.getByRole("tab", { name: "GIF", exact: true })).toHaveCount(
    0,
  );
  // Anchored above the composer form, aligned to its left edge like Slack.
  const form = page.locator("form").filter({ has: composer(page) });
  const formBox = await form.boundingBox();
  const pickerBox = await picker(page).boundingBox();
  expect(pickerBox.y + pickerBox.height).toBeLessThanOrEqual(formBox.y);
  expect(Math.abs(pickerBox.x - formBox.x)).toBeLessThanOrEqual(2);
  await pickThumbsUp(page);
  await expect(picker(page)).toHaveCount(0);
  await expect(composer(page)).toBeFocused();
  await expect(composer(page)).toContainText("Draft stays");
  await expect(
    row.getByRole("button", { name: "👍: You", exact: true }),
  ).toBeVisible();
  // The pill renders from the optimistic outbox; publication can lag it.
  await expect
    .poll(
      () =>
        app.report.publications.filter(({ event }) => event.kind === 7).length,
    )
    .toBe(1);
  const added = app.report.publications.find(
    ({ event }) => event.kind === 7,
  ).event;
  expect(added.content).toBe("👍");
  expect(added.tags).toContainEqual(["e", latest.id]);
  // The same selection removes the existing own reaction.
  await page.keyboard.press("ControlOrMeta+Shift+\\");
  await pickThumbsUp(page);
  await expect(
    row.getByRole("button", { name: "👍: You", exact: true }),
  ).toHaveCount(0);
  await expect
    .poll(
      () =>
        app.report.publications.filter(({ event }) => event.kind === 5).length,
    )
    .toBe(1);
  // Escape returns to the composer without reacting.
  await page.keyboard.press("ControlOrMeta+Shift+\\");
  await expect(picker(page)).toBeVisible();
  await page.screenshot({
    path: test.info().outputPath("react-to-latest-picker.png"),
  });
  await page.keyboard.press("Escape");
  await expect(picker(page)).toHaveCount(0);
  await expect(composer(page)).toBeFocused();
  expect(
    app.report.publications.filter(({ event }) => event.kind === 7),
  ).toHaveLength(1);
  expect(errors.unexplained()).toEqual([]);
});
