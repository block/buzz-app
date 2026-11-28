import {
  chooseColorMode,
  openSettings,
  selectSettingsSection,
  settingsDialog,
} from "./navigation.mjs";
import { test, expect } from "./fixture.mjs";
import { npubEncode } from "nostr-tools/nip19";

test.use({ historyCounts: { alpha: 0, beta: 0 } });

test("editable instructions open formatted and scroll independently of the save footer", async ({
  page,
  app,
}) => {
  await page.setViewportSize({ width: 320, height: 850 });
  await page.emulateMedia({
    colorScheme: "light",
    reducedMotion: "no-preference",
  });
  await page.goto(app.origin);
  await openSettings(page);
  await selectSettingsSection(page, "Agent setup");
  const title = "Agent Memory";
  const instructions = settingsDialog(page).getByRole("region", {
    name: "Base instructions",
  });
  await instructions.getByRole("button", { name: /^Show all/ }).click();
  const row = instructions
    .locator('.buzz-accordion[data-variant="popout"]')
    .getByRole("button", { name: title, exact: true });
  const rowLabel = row
    .locator('span[aria-hidden="true"]')
    .filter({ hasText: title });
  const fill = (property) =>
    row.evaluate(
      (node, name) =>
        getComputedStyle(
          node.closest(".buzz-accordion-item"),
          "::before",
        ).getPropertyValue(name),
      property,
    );
  await expect(rowLabel).toHaveCSS("opacity", "1");
  expect(await fill("opacity")).toBe("0");
  const collapsedFillLeft = parseFloat(await fill("left"));
  await row.click();
  const panel = instructions.getByRole("region", { name: title, exact: true });
  const heading = panel.getByRole("heading", { name: title, exact: true });
  const editor = panel.getByRole("textbox", { name: `Your text for ${title}` });
  await expect(rowLabel).toHaveCSS("transition-property", "opacity");
  await expect(rowLabel).toHaveCSS("opacity", "0");
  expect(await fill("transition-property")).toContain("opacity");
  await expect.poll(() => fill("opacity")).toBe("1");
  expect(parseFloat(await fill("left"))).toBeLessThan(collapsedFillLeft);
  const fontSize = (locator) =>
    locator.evaluate((node) => parseFloat(getComputedStyle(node).fontSize));
  expect(await fontSize(heading)).toBeGreaterThan(await fontSize(rowLabel));
  expect((await heading.boundingBox()).y).toBeLessThan(
    (await editor.boundingBox()).y,
  );
  await row.click();
  await expect(rowLabel).toHaveCSS("opacity", "1");
  await expect(heading).toHaveCount(0);
  await row.press("Enter");
  await expect(row).toBeFocused();
  await expect(rowLabel).toHaveCSS("transition-duration", "0s");
  await expect(rowLabel).toHaveCSS("opacity", "0");
  expect(await fill("transition-duration")).toBe("0s");
  expect(await fill("opacity")).toBe("1");
  await expect(heading).toBeVisible();
  const save = panel.getByRole("button", { name: "Save", exact: true });
  const cancel = panel.getByRole("button", { name: "Cancel", exact: true });
  const actions = panel.getByRole("button", {
    name: `Options for ${title}`,
  });
  await cancel.click();
  await expect(row).toBeFocused();
  await row.press("Enter");
  const actionsBounds = await actions.boundingBox();
  const cancelBounds = await cancel.boundingBox();
  expect(actionsBounds.x + actionsBounds.width).toBeLessThan(cancelBounds.x);
  expect(actionsBounds.y).toBe(cancelBounds.y);
  const expectScrollChaining = async (body, settingsScroll) => {
    const innerMax = await body.evaluate((node) => {
      const max = node.scrollHeight - node.clientHeight;
      node.scrollTop = max - 60;
      return max;
    });
    expect(innerMax).toBeGreaterThan(1);
    await body.hover();
    // Reach the edge with real input so the browser resolves pixel rounding
    // before the next wheel event tests chaining.
    await page.mouse.wheel(0, 120);
    await expect
      .poll(() => body.evaluate((node) => node.scrollTop))
      .toBeGreaterThanOrEqual(innerMax - 1);
    const outer = await settingsScroll.evaluate((node) => ({
      top: node.scrollTop,
      max: node.scrollHeight - node.clientHeight,
    }));
    expect(outer.top).toBeLessThan(outer.max);
    await expect
      .poll(async () => {
        // Continue the gesture after the inner scroller reaches its edge.
        await page.mouse.wheel(0, 120);
        return settingsScroll.evaluate((node) => node.scrollTop);
      })
      .toBeGreaterThan(outer.top);
  };
  await expect(save).toHaveAttribute("data-variant", "prominent");
  await expect(cancel).toHaveAttribute("data-variant", "subtle");
  await expect(actions).toHaveText("Options");
  const editableHint = panel.getByText("This instruction can be changed.");
  expect((await editableHint.boundingBox()).x).toBeLessThan(
    (await cancel.boundingBox()).x,
  );
  await save.scrollIntoViewIfNeeded();
  const footerTop = (await save.boundingBox()).y;
  await editor.evaluate((node) => {
    node.scrollTop = node.scrollHeight;
  });
  await expect
    .poll(() => editor.evaluate((node) => node.scrollTop))
    .toBeGreaterThan(0);
  expect((await save.boundingBox()).y).toBe(footerTop);
  await expectScrollChaining(
    editor,
    settingsDialog(page).locator(".buzz-dialog-navigation-layout"),
  );

  await actions.press("Enter");
  const reset = page.getByRole("menuitem", {
    name: "Set to default instruction",
    exact: true,
  });
  await reset.hover();
  await expect(page.getByRole("tooltip")).toHaveText("Already set");
  await page.keyboard.press("Escape");
  await cancel.press("Enter");
  await expect(row).toBeFocused();
  await row.press("Enter");

  await editor.fill("Report milestones.");
  await editor.press("ControlOrMeta+a");
  await editor.press("ControlOrMeta+b");
  await expect(editor.locator("strong")).toHaveText("Report milestones.");
  await save.click();
  await expect(row).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByText("Instruction saved.")).toBeVisible();
  await expect(row).toBeFocused();
  await row.press("Enter");
  await expect(
    panel.getByRole("heading", { name: `${title} (Modified)` }),
  ).toBeVisible();
  await expect(editor.locator("strong")).toHaveText("Report milestones.");

  await actions.click();
  await page.getByRole("menuitem", { name: "Disable", exact: true }).click();
  await expect(row).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByText("Instruction disabled.")).toBeVisible();
  await expect(row).toBeFocused();
  await row.press("Enter");
  await expect(
    panel.getByRole("heading", { name: `${title} (Disabled)` }),
  ).toBeVisible();
  const disabledText = panel.locator("[data-instruction-reading-area]");
  await row.press("Tab");
  await expect(disabledText).toBeFocused();
  await disabledText.press("End");
  await expect
    .poll(() => disabledText.evaluate((node) => node.scrollTop))
    .toBeGreaterThan(0);
  await expect(save).toBeDisabled();
  await expect(cancel).toBeVisible();
  await actions.press("Space");
  await page
    .getByRole("menuitem", { name: "Enable", exact: true })
    .press("Enter");
  await expect(row).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByText("Instruction enabled.")).toBeVisible();
  await expect(row).toBeFocused();
  await row.press("Enter");
  await expect(editor).toBeEditable();
  await expect(save).toBeDisabled();

  const pasted = "Report milestones.\nMention blockers.";
  await editor.press("ControlOrMeta+a");
  await editor.evaluate((node, text) => {
    const clipboardData = new DataTransfer();
    clipboardData.setData("text/plain", text);
    node.dispatchEvent(
      new ClipboardEvent("paste", {
        bubbles: true,
        cancelable: true,
        clipboardData,
      }),
    );
  }, pasted);
  await save.click();
  await expect(row).toHaveAttribute("aria-expanded", "false");
  await row.press("Enter");
  await expect(editor).toHaveValue(pasted);

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await selectSettingsSection(page, "Appearance");
  await chooseColorMode(page, "Dark");
  await page.getByRole("button", { name: "Increase interface size" }).click();
  await selectSettingsSection(page, "Agent setup");
  const readOnly = instructions.getByRole("button", {
    name: "Trust",
    exact: true,
  });
  const readOnlyLabel = readOnly
    .locator('span[aria-hidden="true"]')
    .filter({ hasText: "Trust" });
  await readOnly.click();
  await expect(readOnlyLabel).toHaveCSS("transition-duration", "0s");
  await expect(readOnlyLabel).toHaveCSS("opacity", "0");
  const readingPanel = instructions.getByRole("region", {
    name: "Trust",
    exact: true,
  });
  const readingHeading = readingPanel.getByRole("heading", {
    name: "Trust",
    exact: true,
  });
  const readingBody = readingPanel.locator("[data-instruction-reading-area]");
  expect(await fontSize(readingHeading)).toBeGreaterThan(
    await fontSize(readOnlyLabel),
  );
  expect((await readingHeading.boundingBox()).y).toBeLessThan(
    (await readingBody.boundingBox()).y,
  );
  await expect(
    readingPanel.getByRole("button", { name: "Options for Trust" }),
  ).toHaveCount(0);
  await readOnly.press("Tab");
  await expect(readingBody).toBeFocused();
  await expect(readingBody).toHaveCSS("outline-style", "solid");
  await expect(readingBody).toHaveCSS("mask-image", "none");
  await readingBody.press("End");
  await expect
    .poll(() => readingBody.evaluate((node) => node.scrollTop))
    .toBeGreaterThan(0);
  await expectScrollChaining(
    readingBody,
    settingsDialog(page).locator(".buzz-dialog-navigation-detail"),
  );
});

// Real text selection and keyboard focus need a browser. Settings appearance,
// emoji actions and hosted setup states have no separate browser sweep here.
test("a failed identity copy leaves the full ID selectable and preserves keyboard focus", async ({
  page,
  app,
}) => {
  await page.goto(app.origin);
  await openSettings(page);
  await expect(settingsDialog(page).locator(":focus")).toHaveCount(1);
  await selectSettingsSection(page, "Identity");
  // Copy failure must leave the entire value selectable as ordinary text.
  const identity = page.getByRole("region", {
    name: "Identity",
    exact: true,
  });
  const copyId = identity.getByRole("button", {
    name: "Copy Buzz ID",
    exact: true,
  });
  await expect(copyId).toBeVisible();
  await page.evaluate(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async () => {
          throw new Error("Clipboard unavailable");
        },
      },
    });
  });
  await copyId.click();
  await expect(page.getByText(/Select it and copy manually/)).toBeVisible();
  // The card abbreviates the ID; clipboard failure exposes the full value below it.
  const publicKey = identity.getByText(/^Full Buzz ID:/).locator("code");
  const key = npubEncode(app.viewer);
  await expect(publicKey).toHaveText(key);
  await publicKey.click();
  await expect
    .poll(() => page.evaluate(() => window.getSelection()?.toString()))
    .toBe(key);
  await copyId.focus();
  await page.keyboard.press("Shift+Tab");
  await expect(
    identity.getByRole("button", { name: "More options", exact: true }),
  ).toBeFocused();
  await page.getByRole("dialog", { name: "Identity wasn’t copied" }).hover();
  await page
    .getByRole("dialog", { name: "Identity wasn’t copied" })
    .getByRole("button", { name: "Dismiss notification" })
    .click();
  await expect(
    page.getByRole("dialog", { name: "Identity wasn’t copied" }),
  ).toHaveCount(0);
});

test("accent controls remain keyboard reachable in narrow Settings at 200%", async ({
  page,
  app,
}) => {
  await page.setViewportSize({ width: 390, height: 900 });
  await page.goto(app.origin);
  await openSettings(page);
  await selectSettingsSection(page, "Appearance");
  for (let step = 0; step < 10; step++) {
    await page.getByRole("button", { name: "Increase interface size" }).click();
  }
  await expect(page.getByRole("status", { name: "Interface size" })).toHaveText(
    "200%",
  );
  const swatches = page
    .getByRole("region", { name: "Appearance", exact: true })
    .getByRole("button", { name: / accent color$/ });
  await expect(swatches.first()).toBeVisible();
  for (const swatch of await swatches.all()) {
    await swatch.focus();
    await expect(swatch).toBeFocused();
    await expect(swatch).toBeInViewport({ ratio: 1 });
  }
});
