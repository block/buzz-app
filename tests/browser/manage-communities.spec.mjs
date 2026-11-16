import { test, expect } from "./fixture.mjs";
import {
  closeSettings,
  openCommunityPicker,
  settingsDialog,
} from "./navigation.mjs";

// Browser-only boundary: shell history and nested modal focus across real
// service removal, selection fallback and durable device inventory updates.
// Pending/failure permutations live in the mounted component tests.
test("manage saved communities preserves navigation, keyboard focus and Personal space", async ({
  page,
  app,
}) => {
  const leaveRequests = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.endsWith("/leave"))
      leaveRequests.push(request.url());
  });
  await page.goto(app.origin);
  await page.getByRole("button", { name: "Alpha", exact: true }).click();
  await page.getByRole("button", { name: "Beta", exact: true }).click();
  const picker = await openCommunityPicker(page);
  // Visibility precedes Base UI's next-frame initial focus. Send navigation
  // keys only after the switcher owns focus, especially in Linux WebKit.
  await expect(
    picker.getByRole("button", { name: "Personal space", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("End");
  const manage = picker.getByRole("button", {
    name: "Manage communities…",
    exact: true,
  });
  await expect(manage).toBeFocused();
  await page.keyboard.press("Enter");
  const list = page.getByRole("region", {
    name: "Saved communities",
    exact: true,
  });
  await expect(list).toBeVisible();
  await expect(list.getByText("Personal space", { exact: true })).toBeVisible();
  await expect(
    list.getByRole("button", { name: /Remove Personal space/ }),
  ).toHaveCount(0);
  await page.screenshot({
    path: test.info().outputPath("manage-list-light.png"),
  });
  await page.goBack();
  await expect(settingsDialog(page)).toHaveCount(0);
  await page.goForward();
  await expect(list).toBeVisible();
  const removeSecondary = list.getByRole("button", {
    name: "Remove Secondary — https://secondary.example from this device",
    exact: true,
  });
  await removeSecondary.focus();
  await page.keyboard.press("Enter");
  const confirm = page.getByRole("alertdialog", {
    name: "Remove Secondary from this device?",
  });
  await expect(confirm).toContainText("saved drafts or data");
  await expect(confirm).toContainText("Your membership won’t change.");
  await expect(
    confirm.getByRole("button", { name: "Cancel", exact: true }),
  ).toBeFocused();
  await page.screenshot({
    path: test.info().outputPath("manage-confirmation.png"),
  });
  await page.keyboard.press("Escape");
  await expect(removeSecondary).toBeFocused();
  // Exercise both theme surfaces, wrapping controls and enlarged text in the
  // actual Settings host. Theme/text changes are local to this browser context.
  for (const [theme, width, fontSize] of [
    ["dark", 1280, "16px"],
    ["light", 480, "20px"],
    ["dark", 480, "20px"],
  ]) {
    await page.setViewportSize({ width, height: 850 });
    await page.evaluate(
      ({ theme, fontSize }) => {
        document.documentElement.dataset.colorMode = theme;
        document.documentElement.style.fontSize = fontSize;
      },
      { theme, fontSize },
    );
    await removeSecondary.scrollIntoViewIfNeeded();
    await expect(removeSecondary).toBeVisible();
    const overflow = await list.evaluate(
      (element) => element.scrollWidth > element.clientWidth,
    );
    expect(overflow).toBe(false);
    await page.screenshot({
      path: test.info().outputPath(`manage-${theme}-${width}.png`),
    });
  }
  await page.setViewportSize({ width: 1280, height: 850 });
  await removeSecondary.focus();
  await page.keyboard.press("Enter");
  await confirm
    .getByRole("button", { name: "Remove from this device", exact: true })
    .focus();
  await page.keyboard.press("Enter");
  await expect(confirm).toHaveCount(0);
  await expect(list.getByText("Secondary", { exact: true })).toHaveCount(0);
  const removePrimary = list.getByRole("button", {
    name: "Remove Primary — https://primary.example from this device",
    exact: true,
  });
  await expect(removePrimary).toBeFocused();
  await removePrimary.press("Enter");
  const activeConfirm = page.getByRole("alertdialog", {
    name: "Remove Primary from this device?",
  });
  await activeConfirm
    .getByRole("button", { name: "Remove from this device", exact: true })
    .press("Enter");
  await expect(activeConfirm).toHaveCount(0);
  await expect(list).toBeVisible();
  await expect(list.getByRole("button")).toHaveCount(0);
  await expect(
    page.getByRole("button", {
      name: "Community switcher: Communities",
      includeHidden: true,
      exact: true,
    }),
  ).toBeVisible();
  expect(leaveRequests).toHaveLength(0);
  await closeSettings(page);
  const reopened = await openCommunityPicker(page);
  await reopened
    .getByRole("button", { name: "Manage communities…", exact: true })
    .click();
  await expect(list).toBeVisible();
  await closeSettings(page);
  await page.goBack();
  await page.goForward();
  await expect(settingsDialog(page)).toHaveCount(0);
});
