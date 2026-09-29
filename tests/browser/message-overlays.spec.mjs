import { test, expect } from "./source-fixture.mjs";

// Real paint order and clipping cannot be established by DOM component tests.
test("reaction previews paint above floating message actions", async ({
  page,
}) => {
  await page.goto("/tests/fixtures/emoji.html?reactions&wrap&narrow");
  const row = page.locator("[data-message-id]").first();
  const reaction = row.locator('button[data-reaction="👍"]');
  await reaction.hover();
  const preview = page.locator('.buzz-preview-card[role="tooltip"][data-open]');
  await expect(preview).toBeVisible();
  const actions = row.getByRole("group", { name: "Message actions" });
  await expect
    .poll(() => actions.evaluate((el) => el.matches(":popover-open")))
    .toBe(true);
  // Force the real toolbar into the preview's footprint to probe paint order
  // independently of content length and font geometry. Keep its top-layer order.
  await actions.evaluate((bar) => {
    const card = document.querySelector(".buzz-preview-card[data-open]");
    const rect = card.getBoundingClientRect();
    bar.style.top = `${rect.top}px`;
    bar.style.left = `${rect.left}px`;
    bar.style.right = "auto";
  });
  await expect
    .poll(() =>
      preview.evaluate((card) => {
        const rect = card.getBoundingClientRect();
        // Supplemental cards ignore pointer input. Temporarily enable it solely
        // for this paint probe, restoring the real interaction policy afterwards.
        card.style.pointerEvents = "auto";
        const hit = document.elementFromPoint(rect.left + 10, rect.top + 10);
        card.style.pointerEvents = "";
        return card === hit || card.contains(hit);
      }),
    )
    .toBe(true);
  await page.mouse.move(0, 0);
  await expect(page.locator(".buzz-preview-card")).toHaveCount(0);
  await reaction.hover();
  await expect(preview).toBeVisible();
});

test("video speed options escape the thread and restore focus after selection and Escape", async ({
  page,
}) => {
  await page.goto("/tests/fixtures/media-review.html?thread");
  const trigger = page
    .getByRole("button", { name: "Playback speed: 1x" })
    .first();
  await expect(trigger).toBeVisible();
  // Put the speed control just below the scroller's top edge: the old inline
  // fieldset loses its upper options behind that boundary.
  await trigger.evaluate((button) => {
    const scroller = button.closest("[data-message-scroller]");
    scroller.scrollTop +=
      button.getBoundingClientRect().top -
      scroller.getBoundingClientRect().top -
      40;
  });
  await page.locator("[data-video-preview]").first().hover();
  await trigger.click();
  const menu = page.getByRole("menu", { name: /^Playback speed:/ });
  await expect(menu).toBeVisible();
  const fast = menu.getByRole("menuitemradio", { name: "2x", exact: true });
  await expect
    .poll(() =>
      fast.evaluate((item) => {
        const rect = item.getBoundingClientRect();
        const edge = document
          .querySelector("[data-message-scroller]")
          .getBoundingClientRect().top;
        const hit = document.elementFromPoint(
          rect.left + rect.width / 2,
          rect.top + rect.height / 2,
        );
        return rect.top < edge && (item === hit || item.contains(hit));
      }),
    )
    .toBe(true);
  await fast.click();
  await expect(menu).toBeHidden();
  const updated = page
    .getByRole("button", { name: "Playback speed: 2x" })
    .first();
  await expect(updated).toBeFocused();
  await expect(page.locator("video").first()).toHaveJSProperty(
    "playbackRate",
    2,
  );
  await updated.press("Enter");
  await expect(
    menu.getByRole("menuitemradio", { name: "2x", exact: true }),
  ).toHaveAttribute("aria-checked", "true");
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  await expect(updated).toBeFocused();
  await updated.click();
  await page.getByRole("heading", { name: "Video and photo review" }).click();
  await expect(menu).toBeHidden();
  await page.locator("[data-video-preview]").first().hover();
  await page
    .getByRole("button", { name: "Open video fullscreen" })
    .first()
    .click();
  const review = page.getByRole("dialog", {
    name: "Video review",
    exact: true,
  });
  const reviewSpeed = review.getByRole("button", {
    name: "Playback speed: 2x",
  });
  await reviewSpeed.focus();
  await reviewSpeed.press("Enter");
  await expect(menu).toBeVisible();
  await expect(
    menu.getByRole("menuitemradio", { name: "2x", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Home");
  await expect(
    menu.getByRole("menuitemradio", { name: "2x", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(
    menu.getByRole("menuitemradio", { name: "1.75x", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(menu).toBeHidden();
  const selected = review.getByRole("button", {
    name: "Playback speed: 1.75x",
  });
  await expect(selected).toBeFocused();
  await selected.press("Enter");
  await expect(menu).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  await expect(review).toBeVisible();
  await expect(selected).toBeFocused();
});

// Shared preview callers must retain viewport placement and non-stealing focus.
test("resolved chip previews fit narrow, intermediate and wide themed views", async ({
  page,
}) => {
  await page.goto(
    "/tests/fixtures/design-system.html#/design/components/inline-chip",
  );
  const chip = page
    .locator('button.inline-chip[data-state="resolved"]')
    .first();
  for (const [width, mode] of [
    [390, "light"],
    [900, "dark"],
    [1440, "light"],
  ]) {
    await page.setViewportSize({ width, height: 950 });
    await page.evaluate((mode) => {
      document.documentElement.classList.toggle("dark", mode === "dark");
      document.documentElement.dataset.colorMode = mode;
    }, mode);
    await chip.scrollIntoViewIfNeeded();
    await chip.focus();
    await chip.hover();
    const preview = page.locator(
      '.buzz-preview-card[role="tooltip"][data-open]',
    );
    await expect(preview).toBeVisible();
    await expect(chip).toBeFocused();
    await expect
      .poll(() =>
        preview.evaluate((card) => {
          const rect = card.getBoundingClientRect();
          return (
            rect.left >= 0 &&
            rect.right <= innerWidth &&
            rect.top >= 0 &&
            rect.bottom <= innerHeight
          );
        }),
      )
      .toBe(true);
    await page.mouse.move(0, 0);
    await chip.blur();
    await expect(page.locator(".buzz-preview-card")).toHaveCount(0);
  }
});
