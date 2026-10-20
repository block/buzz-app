import { test, expect } from "./fixture.mjs";
import { open } from "./timeline.mjs";
import { openChannelDetails } from "./channel-details.mjs";

test.use({
  productionBroker: true,
  soloChannels: ["beta"],
  historyCounts: { alpha: 2, beta: 1 },
});

// Browser focus, modal dismissal and native editor selection require a real
// browser. The app and broker are real; upstream relay traffic is modeled.
test("search, composer and split-pane keyboard focus preserve both drafts", async ({
  page,
  app,
}) => {
  await open(page, app);
  const mod = (await page.evaluate(() =>
    /Mac|iPhone|iPad/.test(navigator.platform),
  ))
    ? "Meta"
    : "Control";
  const main = page.locator("[data-main-workspace], [data-solo-focus-pane]");
  const alpha = main.getByRole("textbox", {
    name: "Message #Alpha",
    exact: true,
  });
  await alpha.fill("Alpha draft");
  await page.keyboard.press(`${mod}+k`);
  const search = page.getByRole("dialog", { name: "Search Buzz", exact: true });
  const query = search.getByRole("combobox", {
    name: "Search Buzz",
    exact: true,
  });
  await expect(query).toBeFocused();
  await query.fill("Beta");
  const channels = search.locator(
    '[aria-label="Channels"] [data-search-result]',
  );
  await expect(channels.filter({ hasText: /Beta/ })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await page.keyboard.press("Enter");
  await expect(search).toHaveCount(0);
  const beta = main.getByRole("textbox", {
    name: "Message your agents",
    exact: true,
  });
  await expect(beta).toBeVisible();
  await page.keyboard.press(`${mod}+Shift+m`);
  await expect(beta).toBeFocused();
  await page.keyboard.type("Beta draft");
  await expect(beta).toHaveText("Beta draft");

  // Return through the same keyboard search path and restore Alpha's draft.
  await page.keyboard.press(`${mod}+k`);
  await expect(query).toBeFocused();
  await query.fill("Alpha");
  await expect(channels.filter({ hasText: /Alpha/ })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await page.keyboard.press("Enter");
  await expect(search).toHaveCount(0);
  await page.keyboard.press(`${mod}+Shift+m`);
  await expect(alpha).toBeFocused();
  await expect(alpha).toHaveText("Alpha draft");

  const link = app.append(
    "primary",
    "alpha",
    "[Open Beta](buzz://channel/beta)",
  );
  await main
    .locator(`[data-message-id="${link.id}"]`)
    .getByRole("link")
    .click();
  const side = page.locator("[data-panel-workspace]");
  const sideBeta = side.getByRole("textbox", {
    name: "Message your agents",
    exact: true,
  });
  await expect(sideBeta).toHaveText("Beta draft");

  // F8 reaches the pane's tab list; arrow keys choose another retained tab.
  await openChannelDetails(page);
  const settings = side.getByRole("tab", {
    name: "Channel settings",
    exact: true,
  });
  await expect(settings).toHaveAttribute("aria-selected", "true");
  await settings.focus();
  await page.keyboard.press(`${mod}+Shift+m`);
  await expect(settings).toBeFocused();
  await page.keyboard.press("F8");
  await expect(main.getByRole("tab", { selected: true })).toBeFocused();
  await expect(page.locator("html")).toHaveAttribute(
    "data-keyboard-navigation",
    "",
  );
  await page.keyboard.press("F8");
  await expect(settings).toBeFocused();
  await page.keyboard.press("ArrowLeft");
  await expect(
    side.getByRole("tab", { name: "Beta", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(
    side.getByRole("tab", { name: "Beta", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press(`${mod}+Shift+m`);
  await expect(sideBeta).toBeFocused();
  await page.keyboard.press("Home");
  await page.keyboard.press("Shift+ArrowRight");
  // ProseMirror adopts the browser's native selectionchange asynchronously.
  await expect
    .poll(() =>
      sideBeta.evaluate((element) => [
        element.selectionStart,
        element.selectionEnd,
      ]),
    )
    .toEqual([0, 1]);
  const selection = await sideBeta.evaluate((element) => [
    element.selectionStart,
    element.selectionEnd,
  ]);
  await page.keyboard.press("F8");
  await expect(main.getByRole("tab", { selected: true })).toBeFocused();
  await page.keyboard.press(`${mod}+Shift+m`);
  await expect(alpha).toBeFocused();
  await page.keyboard.press("Shift+F8");
  await expect(side.getByRole("tab", { selected: true })).toBeFocused();
  await page.keyboard.press(`${mod}+Shift+m`);
  await expect(sideBeta).toBeFocused();
  expect(
    await sideBeta.evaluate((element) => [
      element.selectionStart,
      element.selectionEnd,
    ]),
  ).toEqual(selection);
  await expect(alpha).toHaveText("Alpha draft");
  await expect(sideBeta).toHaveText("Beta draft");

  // A collapsed pane keeps its draft mounted but cannot receive shortcut focus.
  const toggle = page.getByRole("button", {
    name: "Toggle tab pane",
    exact: true,
  });
  await toggle.click();
  await expect(side).toBeHidden();
  await page.keyboard.press("F8");
  await expect(main.getByRole("tab", { selected: true })).toBeFocused();
  await page.keyboard.press(`${mod}+Shift+m`);
  await expect(alpha).toBeFocused();
  await toggle.click();
  await expect(sideBeta).toHaveText("Beta draft");

  await page.keyboard.press(`${mod}+k`);
  await expect(query).toBeFocused();
  await query.fill("Keep search focus");
  await page.keyboard.press(`${mod}+Shift+m`);
  await page.keyboard.press("F8");
  await expect(query).toBeFocused();
  await expect(query).toHaveValue("Keep search focus");
});

test.extend({ companionFixture: true })(
  "companion overlays exclude the covered main focus targets",
  async ({ page, app }, testInfo) => {
    await page.setViewportSize({ width: 600, height: 900 });
    await open(page, app);
    const mod = await page.evaluate(() =>
      /Mac|iPhone|iPad/.test(navigator.platform) ? "Meta" : "Control",
    );
    const main = page.locator("[data-main-workspace]");
    const composer = main.getByRole("textbox", {
      name: "Message #Alpha",
      exact: true,
    });
    await composer.fill("Alpha draft");
    await page
      .getByRole("button", { name: "Companion fixture", exact: true })
      .click();
    const companion = page.getByRole("complementary", {
      name: "Companion fixture",
      exact: true,
    });
    await expect(companion).toBeVisible();
    for (const target of [
      composer,
      main.getByRole("tab", { selected: true }),
    ]) {
      await expect
        .poll(() =>
          target.evaluate((element) => {
            const bounds = element.getBoundingClientRect();
            return !!document
              .elementFromPoint(
                bounds.x + bounds.width / 2,
                bounds.y + bounds.height / 2,
              )
              ?.closest('aside[aria-label="Companion fixture"]');
          }),
        )
        .toBe(true);
    }
    for (const start of [
      companion.getByRole("button", { name: "Close Companion fixture panel" }),
      page.getByRole("button", { name: "Search Buzz", exact: true }),
    ]) {
      await start.focus();
      await page.keyboard.press(`${mod}+Shift+m`);
      await expect(start).toBeFocused();
      await page.keyboard.press("F8");
      await expect(start).toBeFocused();
      await expect(composer).toHaveText("Alpha draft");
    }
    await companion
      .getByRole("button", { name: "Close Companion fixture panel" })
      .click();
    await page.keyboard.press(`${mod}+Shift+m`);
    await expect(composer).toBeFocused();
    await expect(composer).toHaveText("Alpha draft");

    // Pointer-to-keyboard focus uses the shared ring in both themes, across
    // layout breakpoints and with enlarged text.
    const tab = main.getByRole("tab", { selected: true });
    for (const mode of ["light", "dark"]) {
      await page.evaluate((mode) => {
        document.documentElement.dataset.colorMode = mode;
        document.documentElement.style.setProperty("--buzz-text-scale", "2");
      }, mode);
      for (const width of [600, 900, 1440]) {
        await page.setViewportSize({ width, height: 900 });
        await tab.click();
        await expect(page.locator("html")).not.toHaveAttribute(
          "data-keyboard-navigation",
          "",
        );
        await page.keyboard.press("F8");
        await expect(tab).toBeFocused();
        await expect(tab).toHaveCSS("outline-style", "solid");
        await expect(tab).toHaveCSS("outline-width", "2px");
        if (testInfo.project.name === "chromium")
          await page.screenshot({
            path: testInfo.outputPath(`focus-${mode}-${width}.png`),
          });
      }
    }
  },
);

test("pane focus preserves F6 notification recovery", async ({ page, app }) => {
  await open(page, app);
  const mod = await page.evaluate(() =>
    /Mac|iPhone|iPad/.test(navigator.platform) ? "Meta" : "Control",
  );
  const link = app.append(
    "primary",
    "alpha",
    "[Open Beta](buzz://channel/beta)",
  );
  await page
    .locator(`[data-message-id="${link.id}"]`)
    .getByRole("link")
    .click();
  const side = page.locator("[data-panel-workspace]");
  const composer = side.getByRole("textbox", {
    name: "Message your agents",
    exact: true,
  });
  await composer.fill("Toast draft");
  await composer.evaluate((input) => {
    // Exercise the real attachment rejection without allocating a huge buffer.
    const file = new File(["x"], "large.pdf", { type: "application/pdf" });
    Object.defineProperty(file, "size", { value: 501 * 1024 * 1024 });
    const data = new DataTransfer();
    data.items.add(file);
    input.dispatchEvent(
      new ClipboardEvent("paste", {
        bubbles: true,
        cancelable: true,
        clipboardData: data,
      }),
    );
  });
  const notices = page.getByRole("region", { name: "App notifications" });
  await expect(
    notices.getByText("Could not attach file", { exact: true }),
  ).toBeVisible();
  const toastCoversComposer = () =>
    composer.evaluate((element) => {
      const bounds = element.getBoundingClientRect();
      return !!document
        .elementFromPoint(
          bounds.x + bounds.width / 2,
          bounds.y + bounds.height / 2,
        )
        ?.closest('[aria-label="App notifications"]');
    });
  await expect.poll(toastCoversComposer).toBe(true);
  for (const key of ["F6", "Shift+F6"]) {
    await composer.focus();
    await page.keyboard.press(key);
    await expect(notices.locator("ol")).toBeFocused();
  }
  await page.keyboard.press("F8");
  await expect(
    page
      .locator("[data-main-workspace], [data-solo-focus-pane]")
      .getByRole("tab", { selected: true }),
  ).toBeFocused();
  await page.keyboard.press("F8");
  await expect(side.getByRole("tab", { selected: true })).toBeFocused();
  await page.keyboard.press(`${mod}+Shift+m`);
  await expect(composer).toBeFocused();
  await expect(composer).toHaveText("Toast draft");

  // The toast can also cover a dock that covers the main composer. Search
  // through that stack: ignoring just the top toast must not expose the main.
  await page.setViewportSize({ width: 600, height: 900 });
  await expect.poll(toastCoversComposer).toBe(true);
  const search = page.getByRole("button", { name: "Search Buzz", exact: true });
  await search.focus();
  await page.keyboard.press(`${mod}+Shift+m`);
  await expect(search).toBeFocused();
  await page.keyboard.press("F8");
  await expect(side.getByRole("tab", { selected: true })).toBeFocused();
  await page.keyboard.press(`${mod}+Shift+m`);
  await expect(composer).toBeFocused();
  await expect(
    notices.getByText("Could not attach file", { exact: true }),
  ).toBeVisible();
});

test("pane and composer shortcuts exclude fully and partially covered targets", async ({
  page,
  app,
}) => {
  await open(page, app);
  const mod = await page.evaluate(() =>
    /Mac|iPhone|iPad/.test(navigator.platform) ? "Meta" : "Control",
  );
  const main = page.locator("[data-main-workspace], [data-solo-focus-pane]");
  const alpha = main.getByRole("textbox", {
    name: "Message #Alpha",
    exact: true,
  });
  await alpha.fill("Alpha draft");
  const link = app.append(
    "primary",
    "alpha",
    "[Open Beta](buzz://channel/beta)",
  );
  await main
    .locator(`[data-message-id="${link.id}"]`)
    .getByRole("link")
    .click();
  const side = page.locator("[data-panel-workspace]");
  const beta = side.getByRole("textbox", {
    name: "Message your agents",
    exact: true,
  });
  await beta.fill("Beta draft");
  const exposed = (locator) =>
    locator.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      const front = document.elementFromPoint(
        rect.x + rect.width / 2,
        rect.y + rect.height / 2,
      );
      return (
        !!front &&
        element
          .closest("[data-main-workspace], [data-panel-workspace]")
          ?.contains(front)
      );
    });
  for (const width of [900, 600]) {
    await page.setViewportSize({ width, height: 900 });
    await expect.poll(() => exposed(alpha)).toBe(false);
    await beta.focus();
    await page.keyboard.press("F8");
    const focused = page.locator(":focus");
    await expect.poll(() => exposed(focused)).toBe(true);
    await page.keyboard.press(`${mod}+Shift+m`);
    await expect.poll(() => exposed(focused)).toBe(true);
    await page.keyboard.type("x");
    await expect(alpha).toHaveText("Alpha draft");
    // Outside both panes, a covered main composer must not claim the shortcut.
    const search = page.getByRole("button", {
      name: "Search Buzz",
      exact: true,
    });
    await search.focus();
    await page.keyboard.press(`${mod}+Shift+m`);
    await expect(search).toBeFocused();
    await expect(alpha).toHaveText("Alpha draft");
  }
});
