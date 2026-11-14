import { test, expect } from "./fixture.mjs";
import { channelRow, rail } from "./navigation.mjs";
import { openSoloList, showChannels } from "./rail-helpers.mjs";
import { virtuaIdle } from "./timeline.mjs";
import { holdMenuExit, opened } from "./menu-motion.mjs";

const chatId = "33333333-3333-4333-8333-333333333333";
test.use({
  productionBroker: true,
  channelIds: ["alpha", "beta", chatId],
  channelNames: { [chatId]: "Solo conversation" },
  soloChannels: [chatId],
  ownSoloChannels: [chatId],
  historyCounts: { alpha: 1, beta: 0, [chatId]: 0 },
});

// Browser-only contract: native word selection and CSS selection suppression
// cannot be exercised by jsdom. Existing menu tests cover action dispatch and
// focus restoration, not accidental text highlighting.
async function textPosition(label) {
  return label.evaluate((element) => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    for (let text = walker.nextNode(); text; text = walker.nextNode()) {
      const start = text.textContent.search(/\S/);
      if (start < 0) continue;
      const range = document.createRange();
      range.setStart(text, start);
      range.setEnd(text, start + 1);
      const glyph = range.getBoundingClientRect();
      const box = element.getBoundingClientRect();
      return {
        x: glyph.x + glyph.width / 2 - box.x,
        y: glyph.y + glyph.height / 2 - box.y,
      };
    }
    throw new Error("Selection target has no text");
  });
}

// Every conversation row shares one menu; it has no name of its own.
function rowMenu(page) {
  return page.getByRole("menu").filter({
    has: page.getByRole("menuitem", { name: "Add to section", exact: true }),
  });
}

async function expectNoSelection(page, label) {
  await label.dblclick({ position: await textPosition(label) });
  expect(await page.evaluate(() => window.getSelection()?.toString())).toBe("");
}

test("navigation menus do not highlight labels while message text and editors remain selectable", async ({
  page,
  app,
}) => {
  await page.goto(app.origin);
  await showChannels(page);
  const channel = channelRow(page, "alpha");
  await channel.click();
  const composer = page.getByRole("textbox", {
    name: "Message #Alpha",
    exact: true,
  });
  await expect(composer).toBeVisible();
  const channelLabel = channel.getByText("#Alpha", { exact: true });
  await expectNoSelection(page, channelLabel);
  await channelLabel.click({
    button: "right",
    position: await textPosition(channelLabel),
  });
  const channelMenu = rowMenu(page);
  await expect(channelMenu).toBeVisible();
  expect(await page.evaluate(() => window.getSelection()?.toString())).toBe("");
  await page.keyboard.press("Escape");
  await expect(channelMenu).toHaveCount(0);

  // Rail section titles have their own style, outside NavigationItem.
  const section = rail(page)
    .locator('[data-rail-section="team"]')
    .getByRole("button", { name: "Team", exact: true });
  await expectNoSelection(page, section);
  await section.click({
    button: "right",
    position: await textPosition(section),
  });
  expect(await page.evaluate(() => window.getSelection()?.toString())).toBe("");
  await page.keyboard.press("Escape");

  const event = app.append("primary", "alpha", "Selectable message content");
  const message = page
    .locator(`[data-channel-timeline] [data-message-id="${event.id}"]`)
    .getByText("Selectable message content", { exact: true });
  await expect(message).toBeVisible();
  await virtuaIdle(page);
  await message.dblclick({ position: await textPosition(message) });
  expect(
    await page.evaluate(() => window.getSelection()?.toString()),
  ).toContain("Selectable");

  await composer.fill("Editable draft");
  await composer.press("ControlOrMeta+a");
  // WebKit includes the editable paragraph's trailing line break in Select All.
  await expect
    .poll(() =>
      page.evaluate(() => window.getSelection()?.toString().trimEnd()),
    )
    .toBe("Editable draft");
  await composer.press("Backspace");
  await expect(composer).toHaveText("");

  // Solo's list rows suppress selection like Team's.
  await openSoloList(page);
  const chat = channelRow(page, chatId);
  const chatLabel = chat.getByText("Solo conversation", { exact: true });
  await expect(chat).toHaveCSS("user-select", "none");
  await expectNoSelection(page, chatLabel);
  await chatLabel.click({
    button: "right",
    position: await textPosition(chatLabel),
  });
  const chatMenu = rowMenu(page);
  await expect(chatMenu).toBeVisible();
  expect(await page.evaluate(() => window.getSelection()?.toString())).toBe("");
  await page.keyboard.press("Escape");
  await expect(chatMenu).toHaveCount(0);
  expect(app.report.detailsPublications ?? []).toHaveLength(0);

  const heading = rail(page)
    .locator('[data-rail-section="solo"]')
    .getByRole("button", { name: "Solo", exact: true });
  await expectNoSelection(page, heading);
  await heading.click({
    button: "right",
    position: await textPosition(heading),
  });
  expect(await page.evaluate(() => window.getSelection()?.toString())).toBe("");
  await page.keyboard.press("Escape");
});

// Browser-only: a modal menu removes native hover, and its exit is asynchronous.
// Observe the first rendered open state rather than imposing a wall-time budget.
test("context menus appear immediately and retain their source highlight through dismissal", async ({
  page,
  app,
}) => {
  await page.goto(app.origin);
  await showChannels(page);
  await channelRow(page, "alpha").click();
  const composer = page.getByRole("textbox", {
    name: "Message #Alpha",
    exact: true,
  });
  await expect(composer).toBeVisible();
  const exit = await holdMenuExit(page);
  try {
    const source = channelRow(page, "beta");
    const menu = rowMenu(page);
    const background = () =>
      source.evaluate((element) => getComputedStyle(element).backgroundColor);
    await source.hover();
    await expect.poll(background).not.toBe("rgba(0, 0, 0, 0)");
    const hover = await background();
    // Capture paint on mounting and state changes, before entrance could finish.
    await page.evaluate(() => {
      window.__contextEntrance = [];
      const sample = () => {
        const popup = [...document.querySelectorAll('[role="menu"]')].find(
          (el) => el.textContent.includes("Add to section"),
        );
        if (!popup || popup.hasAttribute("data-ending-style")) return;
        const style = getComputedStyle(popup);
        if (style.visibility !== "hidden")
          window.__contextEntrance.push({
            opacity: style.opacity,
            filter: style.filter,
            transform: style.transform,
            transition: style.transitionDuration,
          });
      };
      window.__contextObserver = new MutationObserver(sample);
      window.__contextObserver.observe(document.body, {
        childList: true,
        attributes: true,
        subtree: true,
      });
    });
    await source.getByText("#Beta", { exact: true }).click({ button: "right" });
    await opened(menu);
    const samples = await page.evaluate(() => {
      window.__contextObserver.disconnect();
      return window.__contextEntrance;
    });
    expect(samples.length).toBeGreaterThan(0);
    for (const sample of samples)
      expect(sample).toEqual({
        opacity: "1",
        filter: "none",
        transform: "none",
        transition: "0s",
      });
    await expect(source).not.toHaveAttribute("aria-current", "page");
    await expect(channelRow(page, "alpha")).toHaveAttribute(
      "aria-current",
      "page",
    );
    // The pointer is now over the menu, not the row; menu presence owns the fill.
    await menu.getByRole("menuitem").first().hover();
    await expect.poll(background).toBe(hover);
    await menu.press("Escape");
    await exit.held(menu);
    expect(await background()).toBe(hover);
    // Hold the exit itself, not only its lifetime: context dismissal fades
    // without the movement or blur retained by ordinary dropdowns.
    await expect(menu).toHaveCSS("filter", "none");
    await expect(menu).toHaveCSS("transform", "none");
    await expect(menu).toHaveCSS("transition-property", "opacity");
    expect(
      await menu.evaluate((element) =>
        element
          .getAnimations()
          .map((animation) => animation.transitionProperty),
      ),
    ).toEqual(["opacity"]);
    await exit.release();
    await expect(menu).toHaveCount(0);
    // Dismissal can restore keyboard focus or leave the pointer over the row.
    // Neither is menu presence, and both legitimately keep a hover treatment.
    await page.mouse.move(1400, 900);
    await page
      .getByRole("button", { name: "Search Buzz", exact: true })
      .focus();
    await expect.poll(background).toBe("rgba(0, 0, 0, 0)");
    await source.focus();
    await source.press("Shift+F10");
    await opened(menu);
    await menu.getByRole("menuitem").first().focus();
    expect(await background()).toBe(hover);
    await menu.press("Escape");
    await exit.held(menu);
    await exit.release();
    await expect(menu).toHaveCount(0);
    await expect(source).toBeFocused();
  } finally {
    await exit.release();
  }
});
