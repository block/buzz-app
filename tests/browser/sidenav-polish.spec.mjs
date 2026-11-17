import {
  closeSettings,
  conversationList,
  openChannel,
  openSettings,
  rail,
  selectCommunity,
  settingsDialog,
  settingsSections,
  settleShellToggle,
} from "./navigation.mjs";
import { test, expect } from "./fixture.mjs";

import { open, wheel } from "./timeline.mjs";
import { pauseClock } from "./clock.mjs";

// These layout/navigation journeys exercise the opt-in Bestie surface.
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const key = "buzzodz.plugins.v1";
    if (localStorage.getItem(key) === null)
      localStorage.setItem(
        key,
        JSON.stringify({ version: 2, enabled: { "buzz.bestie": true } }),
      );
  });
});

test.use({ savedSidebar: true });

// The rail's Plugins card lists primary pages, Bestie's invitation first.
const pluginsCard = (page) =>
  rail(page).locator('[data-rail-section="navigation"]');
const bestieEntry = (page) =>
  pluginsCard(page).getByRole("button", {
    name: "Create an agent",
    exact: true,
  });

// Real responsive layout owns the Settings modal and the rail. Settings has
// its own navigation; the shell sidebar toggle and the compact rail stay
// mounted behind it, inert, and work again on close.
test("Settings retains the sidebar toggle across desktop and narrow layouts", async ({
  page,
  app,
}) => {
  await open(page, app);
  const modifier = (await page.evaluate(() =>
    /Mac|iPhone|iPad/.test(navigator.platform),
  ))
    ? "Meta"
    : "Control";
  const shellRail = page.locator("#shell-rail");
  await page.getByRole("button", { name: "Hide sidebar" }).click();
  // A wide window keeps the hidden sidebar as its compact rail.
  await expect(shellRail).toHaveAttribute("data-compact", "true");
  await openSettings(page);
  const toggle = page.locator("[data-shell-sidebar-toggle]");
  const inert = () =>
    toggle.evaluate(
      (element) => !!element.closest('[aria-hidden="true"], [inert]'),
    );
  await expect(toggle).toHaveCount(1);
  await expect(toggle).toHaveAttribute("aria-label", "Show sidebar");
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  expect(await inert()).toBe(true);
  await expect(settingsSections(page)).toBeInViewport();
  await closeSettings(page);
  await expect(toggle).toHaveAccessibleName("Show sidebar");
  await expect(shellRail).toHaveAttribute("data-compact", "true");
  await toggle.click();
  await expect(shellRail).not.toHaveAttribute("data-compact");
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  const box = await toggle.boundingBox();
  expect([box.width, box.height]).toEqual([32, 32]);
  await toggle.click();
  await expect(shellRail).toHaveAttribute("data-compact", "true");

  await page.setViewportSize({ width: 600, height: 950 });
  await expect(toggle).toHaveAccessibleName("Show navigation");
  await expect(rail(page)).toBeHidden();
  // Narrow Settings stacks its own navigation; the drawer toggle stays inert.
  // The shortcut opens it without the rail's profile menu.
  await page.keyboard.press(`${modifier}+,`);
  await expect(settingsDialog(page)).toBeVisible();
  await expect(settingsSections(page)).toBeInViewport();
  await expect(toggle).toHaveAttribute("aria-label", "Show navigation");
  expect(await inert()).toBe(true);
  await closeSettings(page);
  await toggle.click();
  await expect(rail(page)).toBeVisible();
  await expect(toggle).toHaveAccessibleName("Hide navigation");
  await rail(page).locator('[data-rail-team-view="channels"]').focus();
  await page.keyboard.press("Escape");
  await expect(rail(page)).toBeHidden();
  await expect(toggle).toBeFocused();
  await page.setViewportSize({ width: 1440, height: 950 });
  await expect(toggle).toHaveAccessibleName("Show sidebar");
  await expect(shellRail).toHaveAttribute("data-compact", "true");
  await toggle.click();
  await expect(shellRail).not.toHaveAttribute("data-compact");
  await expect(rail(page)).toBeVisible();
});

// The shell owns the rail's compact state; the mounted rail keeps its node
// and its resized width across it.
test("shell toggle restores the rail at its resized width", async ({
  page,
  app,
}) => {
  await open(page, app);
  const railNav = page.locator("#shell-rail");
  const workspace = page.locator(".shell-workspace");
  const handle = page.getByRole("separator", { name: "Resize app sidebar" });
  // Pseudo-element help must paint past the rail for pointer and keyboard.
  for (const activate of [
    () => handle.hover(),
    async () => {
      await page.mouse.move(0, 0);
      await page.keyboard.press("Tab");
      await handle.focus();
    },
  ]) {
    await activate();
    await expect
      .poll(() =>
        handle.evaluate((node) => {
          const help = getComputedStyle(node, "::before");
          return [help.visibility, help.opacity];
        }),
      )
      .toEqual(["visible", "1"]);
    const help = await handle.evaluate((node) => {
      const style = getComputedStyle(node, "::before");
      const rect = node.getBoundingClientRect();
      return {
        content: style.content,
        right: rect.left + parseFloat(style.left) + parseFloat(style.width),
        railRight: document.getElementById("shell-rail").getBoundingClientRect()
          .right,
      };
    });
    expect(help.content).toContain("Drag to resize");
    expect(help.right).toBeGreaterThan(help.railRight);
  }
  const railWidth = () =>
    railNav.evaluate((node) => node.getBoundingClientRect().width);
  // The rail's grid track, which the shell animates.
  const track = () =>
    workspace.evaluate((node) =>
      Number.parseFloat(getComputedStyle(node).gridTemplateColumns),
    );
  // Drag past the maximum with the pointer, which keeps motion on.
  const grip = await handle.boundingBox();
  await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
  await page.mouse.down();
  await page.mouse.move(grip.x + 400, grip.y + grip.height / 2, { steps: 4 });
  await page.mouse.up();
  await expect.poll(railWidth).toBe(440);
  await expect.poll(track).toBe(440);
  const transition = await workspace.evaluate((node) => {
    const style = getComputedStyle(node);
    return {
      property: style.transitionProperty,
      duration: style.transitionDuration,
    };
  });
  expect(transition.property).toContain("grid-template-columns");
  expect(parseFloat(transition.duration)).toBeGreaterThan(0);
  const railNode = await railNav.elementHandle();
  let compactWidth;
  // Seek paused real transitions so runner speed cannot hide an immediate
  // jump. Pause them when the toggle commits, before any frame.
  for (const label of ["Hide sidebar", "Show sidebar"]) {
    const samples = await page.evaluate(async (label) => {
      const workspace = document.querySelector(".shell-workspace");
      const button = document.querySelector(`button[aria-label="${label}"]`);
      const committed = new Promise((resolve) => {
        const observer = new MutationObserver(() => {
          observer.disconnect();
          // getAnimations() flushes style, so the toggle's transitions exist.
          const transitions = workspace
            .getAnimations()
            .filter(
              (transition) =>
                transition.transitionProperty === "grid-template-columns",
            );
          for (const transition of transitions) transition.pause();
          resolve(transitions);
        });
        observer.observe(workspace, {
          attributes: true,
          attributeFilter: ["data-rail-compact"],
        });
      });
      button.click();
      const transitions = await committed;
      try {
        if (transitions.length === 0)
          throw new Error("Missing grid-template-columns transition");
        return [0, 0.1, 0.25, 0.5, 0.75, 1].map((progress) => {
          for (const transition of transitions)
            transition.currentTime =
              transition.effect.getTiming().duration * progress;
          return Number.parseFloat(
            getComputedStyle(workspace).gridTemplateColumns,
          );
        });
      } finally {
        for (const transition of transitions) transition.finish();
        await Promise.all(transitions.map((transition) => transition.finished));
      }
    }, label);
    const hiding = label.startsWith("Hide");
    if (hiding) compactWidth = samples.at(-1);
    expect(samples[0]).toBe(hiding ? 440 : compactWidth);
    expect(compactWidth).toBeGreaterThan(0);
    expect(compactWidth).toBeLessThan(440);
    // The track leaves its extent on the first sampled step and moves
    // steadily, instead of jumping at either end.
    for (let index = 1; index < samples.length; index++) {
      const step = samples[index] - samples[index - 1];
      expect(hiding ? -step : step).toBeGreaterThan(0);
    }
    expect(samples.at(-1)).toBe(hiding ? compactWidth : 440);
  }

  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect
    .poll(() =>
      workspace.evaluate((node) => getComputedStyle(node).transitionDuration),
    )
    .toBe("0s");
  await page.emulateMedia({ reducedMotion: "no-preference" });

  await page.getByRole("button", { name: "Hide sidebar" }).click();
  await expect(railNav).toHaveAttribute("data-compact", "true");
  await expect.poll(track).toBe(compactWidth);
  await expect(
    page.getByRole("textbox", { name: "Message #Alpha", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Show sidebar" }).click();
  await expect(railNav).not.toHaveAttribute("data-compact");
  expect(await railNode.evaluate((element) => element.isConnected)).toBe(true);
  await expect.poll(railWidth).toBe(440);
  await expect.poll(track).toBe(440);
  // Portalled comboboxes temporarily hide outside regions from assistive tech.
  // That accessibility state must not override the shell's visible layout state.
  const accessibilityHiddenWidth = await railNav.evaluate(async (node) => {
    node.setAttribute("aria-hidden", "true");
    const workspace = node.closest(".shell-workspace");
    const transitions = [...node.getAnimations(), ...workspace.getAnimations()];
    for (const transition of transitions) transition.finish();
    await Promise.all(transitions.map((transition) => transition.finished));
    return node.getBoundingClientRect().width;
  });
  await expect(railNav).toHaveAttribute("data-open", "true");
  expect(accessibilityHiddenWidth).toBe(440);
  await railNav.evaluate((node) => node.removeAttribute("aria-hidden"));
});

// Native activation must survive a decorative artwork swap during a held press.
// jsdom cannot establish the browser's pointerdown/pointerup click targeting.
test("Bestie stays clickable while its invitation artwork rotates", async ({
  page,
  app,
}) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.clock.install();
  await open(page, app);
  const bestie = bestieEntry(page);
  const image = bestie.locator("img");
  await expect
    .poll(() => image.evaluate((element) => element.naturalWidth))
    .toBeGreaterThan(0);
  const source = await image.getAttribute("src");
  const bounds = await image.boundingBox();
  if (!bounds) throw new Error("Missing Bestie artwork bounds");
  await pauseClock(page);
  await page.mouse.move(
    bounds.x + bounds.width / 2,
    bounds.y + bounds.height / 2,
  );
  await page.mouse.down();
  try {
    await page.clock.runFor(5_000);
    await expect(image).not.toHaveAttribute("src", source);
  } finally {
    await page.mouse.up();
    await page.clock.resume();
  }
  await expect(bestie).toHaveAttribute("aria-current", "page");
  await expect(
    page.getByRole("region", { name: "Bestie", exact: true }),
  ).toBeVisible();
  await openChannel(page, "alpha");
  await expect(bestie).not.toHaveAttribute("aria-current");
  await bestie.focus();
  await page.keyboard.press("Enter");
  await expect(bestie).toHaveAttribute("aria-current", "page");
});

// A real grid/overlay measurement is needed: DOM presence misses implicit columns.
// Bestie leaves companion placement to the shell frame, unlike Team.
test.extend({ companionFixture: true })(
  "Bestie retains companion layout across navigation and resize",
  async ({ page, app }) => {
    await open(page, app);
    const launcher = page.locator(
      '.shell-header button[aria-label="Companion fixture"]',
    );
    const companion = page.getByRole("complementary", {
      name: "Companion fixture",
      exact: true,
    });
    const checkGeometry = async (body, overlay) => {
      await expect(companion).toBeVisible();
      await expect
        .poll(async () => {
          const card = await companion.boundingBox();
          const bounds = await body.boundingBox();
          if (!card || !bounds) return false;
          return overlay
            ? Math.abs(card.x + card.width - bounds.x - bounds.width) < 2 &&
                card.x < bounds.x + bounds.width
            : card.x >= bounds.x + bounds.width;
        })
        .toBe(true);
      await expect
        .poll(() => page.evaluate(() => document.documentElement.scrollWidth))
        .toBe(page.viewportSize().width);
    };
    const showNavigation = async () => {
      if (page.viewportSize().width > 650) return;
      await settleShellToggle(page);
      const show = page.getByRole("button", {
        name: "Show navigation",
        exact: true,
      });
      if (await show.isVisible()) await show.click();
    };
    const openBestie = async () => {
      await showNavigation();
      await bestieEntry(page).click();
      const body = page.getByRole("region", { name: "Bestie", exact: true });
      await expect(
        body.getByRole("heading", { name: "Bestie", exact: true }),
      ).toBeVisible();
      return body;
    };
    for (const width of [1440, 900, 600]) {
      await page.setViewportSize({ width, height: 950 });
      let body = await openBestie();
      await launcher.click();
      await checkGeometry(body, width <= 1000);
      await launcher.click();
      await expect(companion).not.toBeVisible();
      await openChannel(page, "alpha");
      await launcher.click();
      body = await openBestie();
      await checkGeometry(body, width <= 1000);
      await launcher.click();
    }
  },
);

// Wheel scrolling and clipping in a short viewport require a real layout engine.
test("non-ready session keeps Retry reachable while rail pages remain available", async ({
  page,
  app,
}) => {
  await page.setViewportSize({ width: 1440, height: 220 });
  await page.route("**/session", (route) => route.fulfill({ json: {} }));
  await page.goto(app.origin);
  // Team says it can't connect and offers Try again.
  await rail(page).getByRole("button", { name: "Team", exact: true }).click();
  const retry = page.getByRole("button", { name: "Try again", exact: true });
  await expect(retry).toBeAttached();
  // Whichever column holds the notice scrolls it into reach.
  const scrollerOf = async (target) => {
    await target.evaluate((element) => {
      for (const marked of document.querySelectorAll("[data-test-scroller]"))
        marked.removeAttribute("data-test-scroller");
      let scroll = element.parentElement;
      while (scroll && !/auto|scroll/.test(getComputedStyle(scroll).overflowY))
        scroll = scroll.parentElement;
      (scroll ?? document.documentElement).setAttribute(
        "data-test-scroller",
        "",
      );
    });
    return page.locator("[data-test-scroller]");
  };
  const scrollToBottom = async (target) => {
    const scroller = await scrollerOf(target);
    await scroller.hover();
    // Visibility is not input completion: focusing early interrupts WebKit's
    // smooth wheel at a visible-but-not-fully-scrolled Retry button. The shared
    // helper observes scrollend before dispatch; an already-reached edge needs
    // no gesture (and would emit no scrollend).
    if (
      await scroller.evaluate(
        (el) => el.scrollHeight - el.clientHeight - el.scrollTop > 1,
      )
    )
      await wheel(page, 800, scroller);
    await expect
      .poll(() =>
        scroller.evaluate(
          (el) => el.scrollHeight - el.clientHeight - el.scrollTop,
        ),
      )
      .toBeLessThanOrEqual(1);
    await expect
      .poll(async () => {
        const bounds = await scroller.boundingBox();
        const row = await target.boundingBox();
        return (
          !!bounds &&
          !!row &&
          row.y >= bounds.y &&
          row.y + row.height <= bounds.y + bounds.height
        );
      })
      .toBe(true);
  };
  const expectUnclippedFocus = async (button) => {
    await page.keyboard.press("Tab");
    await button.focus();
    await expect(button).toBeFocused();
    await expect
      .poll(() =>
        button.evaluate((element) => {
          const style = getComputedStyle(element);
          const extent =
            parseFloat(style.outlineWidth) + parseFloat(style.outlineOffset);
          const scroll = element.closest("[data-test-scroller]");
          if (!scroll || style.outlineStyle === "none" || extent <= 0)
            return false;
          const row = element.getBoundingClientRect();
          const clip = scroll.getBoundingClientRect();
          return (
            row.left - extent >= clip.left &&
            row.right + extent <= clip.left + scroll.clientWidth
          );
        }),
      )
      .toBe(true);
  };
  const expectRingAboveScrollEnd = () =>
    expect
      .poll(() =>
        retry.evaluate((element) => {
          const style = getComputedStyle(element);
          const extent =
            parseFloat(style.outlineWidth) + parseFloat(style.outlineOffset);
          // The page status scrolls itself; its ring stays inside that pane.
          return (
            element.getBoundingClientRect().bottom + extent <=
            element.closest("[data-test-scroller]").getBoundingClientRect()
              .bottom
          );
        }),
      )
      .toBe(true);
  await scrollToBottom(retry);
  await expectUnclippedFocus(retry);
  await expectRingAboveScrollEnd();
  // Content height can be fractional while scroll offsets snap to whole
  // pixels; hosted WebKit clipped the ring that way.
  for (const fraction of [0.3, 0.7]) {
    const layout = await page.addStyleTag({
      content: `[data-test-scroller] > * { padding-block-end: ${fraction}px; }`,
    });
    await scrollToBottom(retry);
    await expectRingAboveScrollEnd();
    await layout.evaluate((element) => element.remove());
  }
  await page.unroute("**/session");
  await retry.click();
  await expect(conversationList(page)).toBeVisible();
  await selectCommunity(page, "Personal space");
  // A short window scrolls the rail to reach Team's card.
  const team = rail(page).getByRole("button", { name: "Team", exact: true });
  await team.scrollIntoViewIfNeeded();
  await expect(team).toBeInViewport();
  await team.click();
  await expect(team).toHaveAttribute("aria-current", "page");
  await expect(
    page.getByRole("region", { name: "Channels", exact: true }),
  ).toBeVisible();
});

// Pixel positions across two community states need a real layout engine.
// Pages that need no community keep their rows where they were.
// Without a community the rail lists its pages plainly instead of in the
// community's cards, so only the header keeps its place.
test("Personal space preserves the rail header and keeps the global pages", async ({
  page,
  app,
}) => {
  await page.setViewportSize({ width: 1200, height: 800 });
  await open(page, app);
  const rows = ["Reminders", "Agents", "Workflows"].map((name) =>
    rail(page).getByRole("button", { name, exact: true }),
  );
  const header = () =>
    rail(page)
      .getByRole("navigation", { name: "Communities" })
      .evaluate((element) => {
        const frame = element
          .closest('[aria-label="Apps"]')
          .getBoundingClientRect();
        const box = element.getBoundingClientRect();
        return {
          left: box.x - frame.x,
          top: box.y - frame.y,
          width: box.width,
        };
      });
  for (const row of rows) await expect(row).toBeVisible();
  const community = await header();
  await selectCommunity(page, "Personal space");
  await expect(
    page.getByRole("button", { name: "Community switcher: Personal space" }),
  ).toBeVisible();
  for (const row of rows) await expect(row).toBeVisible();
  expect(await header()).toEqual(community);
});
