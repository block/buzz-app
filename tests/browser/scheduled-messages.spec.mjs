import { test, expect } from "./source-fixture.mjs";

test.use({ locale: "en-CA" });

test("schedule menu and date/time dialog retain drafts through refusal and retry", async ({
  page,
}, testInfo) => {
  let accept = false,
    calls = [];
  await page.route("**/fixture/scheduled", async (route) => {
    const body = route.request().postDataJSON();
    calls.push(body);
    await route.fulfill({
      status: accept ? 200 : 503,
      contentType: "application/json",
      body: JSON.stringify(
        accept ? { accepted: true } : { error: "Unavailable" },
      ),
    });
  });
  await page.clock.setFixedTime(new Date("2026-11-10T12:00:00Z"));
  await page.goto("/tests/fixtures/relay-composer.html?scheduled");
  const editor = page.getByRole("textbox", {
    name: "Message #General",
    includeHidden: true,
  });
  await editor.fill("Send this tomorrow");
  const trigger = page.getByRole("button", {
    name: "Schedule message",
    exact: true,
  });
  await trigger.focus();
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("menuitem", { name: /Tomorrow at/ }),
  ).toBeVisible();
  await page.getByRole("menuitem", { name: "Custom time" }).click();
  const dialog = page.getByRole("dialog", { name: "Schedule message" }),
    time = dialog.getByRole("combobox", { name: "Schedule time" });
  await expect(dialog).toBeVisible();
  await time.fill("invalid");
  await time.press("Escape");
  const submit = dialog.getByRole("button", {
    name: "Schedule message",
    exact: true,
  });
  await expect(submit).toBeDisabled();
  await dialog
    .getByRole("button", { name: "Schedule date", exact: true })
    .click();
  const calendar = page.getByRole("dialog", { name: "Choose schedule date" });
  const selected = calendar.locator('[aria-selected="true"] button');
  await selected.focus();
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("Enter");
  await time.fill("11:47 PM");
  await time.press("Tab");
  await expect(time).toHaveValue("11:47 PM");
  await expect(submit).toBeEnabled();
  for (const scale of [1, 1.5]) {
    await page.evaluate(
      (scale) => (document.documentElement.style.fontSize = `${scale * 16}px`),
      scale,
    );
    const fits = await time.evaluate((input) => {
      const style = getComputedStyle(input),
        canvas = document.createElement("canvas"),
        context = canvas.getContext("2d");
      context.font = style.font;
      return (
        context.measureText(input.value).width <=
        input.clientWidth -
          parseFloat(style.paddingLeft) -
          parseFloat(style.paddingRight) +
          1
      );
    });
    expect(fits).toBe(true);
    await page.screenshot({
      animations: "disabled",
      path: testInfo.outputPath(`schedule-${scale}.png`),
    });
  }
  await page.evaluate(() => (document.documentElement.style.fontSize = ""));
  await submit.click();
  await expect(dialog.getByRole("alert")).toBeVisible();
  await expect(editor).toHaveJSProperty("value", "Send this tomorrow");
  accept = true;
  await submit.click();
  await expect(dialog).not.toBeVisible();
  await expect(editor).toHaveJSProperty("value", "");
  expect(calls).toHaveLength(2);
  expect(calls[0]).toEqual(calls[1]);
  await expect(
    page.getByRole("status").filter({ hasText: "Your message will be sent" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "See all scheduled messages" }),
  ).toBeVisible();
  await editor.fill("Keep for later");
  await trigger.click();
  await page.keyboard.press("Escape");
  await expect(editor).toHaveJSProperty("value", "Keep for later");
});

test("cross-year date and full time have room at desktop and narrow widths", async ({
  page,
}, testInfo) => {
  await page.clock.setFixedTime(new Date("2026-11-10T12:00:00Z"));
  await page.goto("/tests/fixtures/relay-composer.html?scheduled");
  await page
    .getByRole("textbox", { name: "Message #General" })
    .fill("Next year");
  await page
    .getByRole("button", { name: "Schedule message", exact: true })
    .click();
  await page.getByRole("menuitem", { name: "Custom time" }).click();
  const dialog = page.getByRole("dialog", { name: "Schedule message" });
  await dialog
    .getByRole("button", { name: "Schedule date", exact: true })
    .click();
  const calendar = page.getByRole("dialog", { name: "Choose schedule date" });
  for (let i = 0; i < 2; i++)
    await calendar.getByRole("button", { name: /next month/i }).click();
  await calendar.getByRole("button", { name: /January 1st, 2027/ }).click();
  const date = dialog.getByRole("button", {
    name: "Schedule date",
    exact: true,
  });
  await expect(date).toContainText("2027");
  const time = dialog.getByRole("combobox", { name: "Schedule time" });
  await time.fill("10:00 AM");
  await time.press("Tab");
  for (const [width, scale] of [
    [1440, 1],
    [1440, 1.5],
    [390, 1],
    [390, 1.5],
  ]) {
    await page.setViewportSize({ width, height: 950 });
    await page.evaluate(
      (scale) => (document.documentElement.style.fontSize = `${scale * 16}px`),
      scale,
    );
    const geometry = await date.evaluate((button) => {
      const label = button.querySelector("span span"),
        caret = button.querySelector(".buzz-dropdown-chevron"),
        style = getComputedStyle(label);
      return {
        height: label.getBoundingClientRect().height,
        line: parseFloat(style.lineHeight),
        fits: button.scrollWidth <= button.clientWidth + 1,
        caretGap:
          caret.getBoundingClientRect().left -
          label.getBoundingClientRect().right,
      };
    });
    expect(geometry.fits).toBe(true);
    expect(geometry.caretGap).toBeGreaterThanOrEqual(8 * scale);
    expect(geometry.height).toBeLessThanOrEqual(geometry.line + 1);
    await page.screenshot({
      animations: "disabled",
      path: testInfo.outputPath(`schedule-cross-year-${width}-${scale}.png`),
    });
  }
});

test.describe("localized schedule values", () => {
  test.use({ locale: "fi-FI" });
  test("keeps localized quarter-hour choices valid when the date changes", async ({
    page,
  }) => {
    await page.goto("/tests/fixtures/relay-composer.html?scheduled");
    await page
      .getByRole("textbox", { name: "Message #General" })
      .fill("Tomorrow");
    await page
      .getByRole("button", { name: "Schedule message", exact: true })
      .click();
    await page.getByRole("menuitem", { name: "Custom time" }).click();
    const dialog = page.getByRole("dialog", { name: "Schedule message" });
    await dialog
      .getByRole("button", { name: "Schedule date", exact: true })
      .click();
    const calendar = page.getByRole("dialog", { name: "Choose schedule date" });
    await calendar.locator('[aria-selected="true"] button').focus();
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("Enter");
    const time = dialog.getByRole("combobox", { name: "Schedule time" });
    await expect(
      dialog.getByRole("button", { name: "Schedule message", exact: true }),
    ).toBeEnabled();
    await time.fill("");
    await dialog.getByRole("button", { name: "Choose schedule time" }).click();
    await page.getByRole("option", { name: "13.15", exact: true }).click();
    await expect(time).toHaveValue("13.15");
    await expect(
      dialog.getByRole("button", { name: "Schedule message", exact: true }),
    ).toBeEnabled();
  });
});

test("manages the scheduled queue with tab-scoped search and safe draft recovery", async ({
  page,
}, testInfo) => {
  const queue = new Map();
  await page.route("**/fixture/scheduled", async (route) => {
    const body = route.request().postDataJSON();
    if (body.action === "create")
      queue.set(body.id, {
        id: body.id,
        revision: 1,
        event: body.event,
        send_at: body.event.created_at,
        status: "scheduled",
      });
    if (body.action === "update") {
      const row = queue.get(body.id);
      queue.set(body.id, {
        ...row,
        revision: row.revision + 1,
        event: body.event,
        send_at: body.event.created_at,
      });
    }
    if (body.action === "cancel") queue.delete(body.id);
    if (body.action === "send_now") {
      const row = queue.get(body.id);
      queue.set(body.id, { ...row, status: "sent" });
    }
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(
        body.action === "list"
          ? { messages: [...queue.values()] }
          : { accepted: true },
      ),
    });
  });
  await page.goto(
    "/tests/fixtures/relay-composer.html?scheduled&scheduledPage",
  );
  await page.evaluate(() => window.composerFixture.seedScheduled());
  await page.getByRole("tab", { name: /Scheduled/ }).click();
  const list = page.getByRole("list", { name: "Scheduled messages" });
  await expect(list.getByRole("listitem")).toHaveCount(2);
  for (const mode of ["light", "dark"]) {
    await page.evaluate(
      (mode) => (document.documentElement.dataset.colorMode = mode),
      mode,
    );
    await page.screenshot({
      path: testInfo.outputPath(`scheduled-list-${mode}.png`),
      animations: "disabled",
    });
  }
  const search = page.getByRole("searchbox", {
    name: "Search scheduled messages",
  });
  await search.fill("weekly");
  await expect(list.getByRole("listitem")).toHaveCount(1);
  await search.fill("missing");
  await expect(
    page.getByText("No scheduled messages match “missing”."),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Clear search scheduled messages" })
    .click();
  const row = list.getByRole("listitem").filter({ hasText: "Review tomorrow" });
  await row.getByRole("button", { name: "Edit message", exact: true }).click();
  const edit = page.getByRole("dialog", { name: "Edit scheduled message" });
  await edit
    .getByRole("textbox", { name: "Message", exact: true })
    .fill("Updated launch notes");
  await edit.getByRole("button", { name: "Save changes" }).click();
  const updated = list
    .getByRole("listitem")
    .filter({ hasText: "Updated launch notes" });
  await expect(updated).toBeVisible();
  await updated.getByRole("button", { name: "Reschedule message" }).click();
  const reschedule = page.getByRole("dialog", { name: "Reschedule message" });
  await reschedule
    .getByRole("combobox", { name: "Schedule time" })
    .fill("10:17 AM");
  await reschedule
    .getByRole("combobox", { name: "Schedule time" })
    .press("Tab");
  await reschedule.getByRole("button", { name: "Save changes" }).click();
  await expect(reschedule).not.toBeVisible();
  await updated.getByRole("button", { name: "More message actions" }).click();
  await expect(page.getByRole("menu")).toBeVisible();
  await expect(page.getByRole("menu")).toHaveCSS("opacity", "1");
  await page.screenshot({
    path: testInfo.outputPath("scheduled-actions.png"),
    animations: "disabled",
  });
  await page
    .getByRole("menuitem", { name: "Cancel schedule and save to drafts" })
    .click();
  const confirm = page.getByRole("alertdialog");
  await confirm
    .getByRole("button", { name: "Save to drafts", exact: true })
    .click();
  await expect(page.getByRole("tab", { name: /^Drafts/ })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(
    page.getByRole("button", { name: /Continue draft.*Updated launch notes/ }),
  ).toBeVisible();
});
