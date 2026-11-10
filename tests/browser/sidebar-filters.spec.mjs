import { test, expect } from "./fixture.mjs";
import { closeSettings, openPage } from "./navigation.mjs";
import { pauseClock } from "./clock.mjs";
import { join } from "node:path";
import { fixtureRelayUrl } from "../relay-config.ts";

test.use({
  productionBroker: true,
  savedSidebar: true,
  channelIds: ["alpha", "beta", "gamma", "delta"],
  channelNames: {
    alpha: "General",
    beta: "Planning",
    gamma: "Design",
    delta: "Archive",
  },
  historyCounts: { alpha: 1, beta: 1, gamma: 1, delta: 1 },
});

// Browser-only contract: nested menu focus, modal save/recovery and the real
// broker's encrypted preference readback must agree after a document reload.
test("section filters save activity windows and recover hidden channels", async ({
  page,
  app,
}, testInfo) => {
  const now = Math.floor(Date.now() / 1000);
  for (const [id, age] of [
    ["alpha", 60],
    ["beta", 2],
    ["gamma", 0],
    ["delta", 45],
  ]) {
    app.histories.set(`primary/${id}`, [
      app.sign({
        kind: 9,
        tags: [["h", id]],
        content: "Project update",
        created_at: now - age * 86400,
      }),
    ]);
  }
  await page.goto(app.origin);
  await openPage(page, "Messages");
  // Filters preserve the current channel; choose a different destination from
  // the row whose exclusion this journey exercises, regardless of startup order.
  await page
    .locator('[data-sidebar-section] [data-channel-id="alpha"]')
    .click();
  await expect(
    page.getByRole("textbox", { name: "Message #General" }),
  ).toBeVisible();
  const section = page.locator('[data-sidebar-section="channels"]');
  await expect(section.locator('[data-channel-id="gamma"]')).toBeVisible();
  const shot = async (name) => {
    if (
      !process.env.BUZZ_FILTER_CAPTURE_DIR ||
      testInfo.project.name !== "chromium"
    )
      return;
    await page.evaluate(async () => {
      await Promise.all(
        document
          .getAnimations()
          .filter(
            (animation) =>
              animation.effect?.getComputedTiming().iterations !== Infinity,
          )
          .map((animation) => animation.finished.catch(() => {})),
      );
    });
    await page.screenshot({
      path: join(process.env.BUZZ_FILTER_CAPTURE_DIR, `${name}.png`),
    });
  };
  const menu = async () => {
    await page
      .getByRole("button", { name: "More actions for Channels", exact: true })
      .click();
    const trigger = page.getByRole("menuitem", { name: "Filter", exact: true });
    await trigger.hover();
    await expect(
      page.getByRole("menu", { name: "Filter Channels", exact: true }),
    ).toBeVisible();
  };
  const active = async () => {
    await menu();
    await page
      .getByRole("menuitemradio", { name: /Active in the last/ })
      .click();
    await expect(
      page.getByRole("dialog", { name: "Active in the last", exact: true }),
    ).toBeVisible();
  };
  await shot("01-all");
  await menu();
  await expect(
    page.getByRole("menuitemradio", { name: "All", exact: true }),
  ).toHaveAttribute("aria-checked", "true");
  await shot("02-filter-menu");
  await page
    .getByRole("menuitemradio", { name: "Unreads", exact: true })
    .click();
  await expect
    .poll(() => app.report.sidebarPublications?.at(-1)?.blob.groups.channels)
    .toBe("unreads");
  await menu();
  await expect(
    page.getByRole("menuitemradio", { name: "Unreads", exact: true }),
  ).toHaveAttribute("aria-checked", "true");
  await shot("03-unreads");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await active();
  for (const days of [1, 7, 30, 90]) {
    const name = `${days} ${days === 1 ? "day" : "days"}`;
    await page.getByRole("radio", { name, exact: true }).click();
    await expect(
      page.getByRole("radio", { name, exact: true }),
    ).toHaveAttribute("aria-checked", "true");
    await shot(`04-dialog-${days}`);
  }
  // Cancel has no publication side effect after editing the draft.
  const beforeCancel = app.report.sidebarPublications.length;
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await menu();
  await expect(
    page.getByRole("menuitemradio", { name: "Unreads", exact: true }),
  ).toHaveAttribute("aria-checked", "true");
  expect(app.report.sidebarPublications).toHaveLength(beforeCancel);
  await page.getByRole("menuitemradio", { name: /Active in the last/ }).click();
  await page.getByRole("radio", { name: "7 days", exact: true }).click();
  await page.getByRole("button", { name: "Apply", exact: true }).click();
  await expect(
    page.getByRole("dialog", { name: "Active in the last", exact: true }),
  ).toHaveCount(0);
  await expect
    .poll(
      () =>
        app.report.sidebarPublications.at(-1)?.blob.activeWindowSeconds
          ?.channels,
    )
    .toBe(7 * 86400);
  await expect(section.locator('[data-channel-id="gamma"]')).toBeVisible();
  await expect(section.locator('[data-channel-id="delta"]')).toHaveCount(0);
  await shot("05-active");
  await page.reload();
  await expect(section.locator('[data-channel-id="gamma"]')).toBeVisible();
  await menu();
  await expect(
    page.getByRole("menuitemradio", { name: /Active in the last/ }),
  ).toHaveAttribute("aria-checked", "true");
  await expect(
    page.getByRole("menuitemradio", { name: /Active in the last/ }),
  ).toContainText("7 days");
  await expect(
    page.getByRole("menuitem", { name: "Archive", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("group", {
      name: "No activity in the last 7 days",
      exact: true,
    }),
  ).toBeVisible();
  await shot("06-hidden-channels");
  await page.emulateMedia({ colorScheme: "dark" });
  await shot("06-hidden-channels-dark");
  await page.emulateMedia({ colorScheme: "light" });
  await page.getByRole("menuitem", { name: "Archive", exact: true }).click();
  await expect(section.locator('[data-channel-id="delta"]')).toBeVisible();
  await shot("07-open-hidden-channel");
  // A failed duration save keeps the dialog draft; retry goes through the broker.
  await active();
  await page.getByRole("radio", { name: "30 days", exact: true }).click();
  let release;
  let started;
  const pending = new Promise((resolve) => {
    started = resolve;
  });
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const pattern = "**/sidebar-filter";
  await page.route(pattern, async (route) => {
    started();
    await gate;
    app.report.sidebarPreferenceFailures ??= [];
    app.report.sidebarPreferenceFailures.push(route.request().url());
    await route.fulfill({
      status: 502,
      contentType: "application/json",
      body: JSON.stringify({ error: "Filter could not be saved. Try again." }),
    });
  });
  const apply = page.getByRole("button", { name: "Apply", exact: true });
  try {
    await apply.focus();
    await apply.press("Enter");
    await pending;
    await expect(apply).toBeFocused();
    await expect(apply).toHaveAttribute("aria-disabled", "true");
    await expect(
      page.getByRole("button", { name: "Cancel", exact: true }),
    ).toBeDisabled();
    await shot("08-saving");
  } finally {
    release();
  }
  await expect(page.getByRole("alert")).toContainText(
    "Relay request failed (502)",
  );
  await expect(apply).toBeFocused();
  await expect(apply).toBeEnabled();
  await shot("09-save-error");
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(
    page.getByRole("dialog", { name: "Active in the last", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Retry filter", exact: true }),
  ).toHaveCount(0);
  await active();
  await page.getByRole("radio", { name: "30 days", exact: true }).click();
  await page.getByRole("button", { name: "Apply", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText(
    "Relay request failed (502)",
  );
  await page.unroute(pattern);
  await page.getByRole("button", { name: "Apply", exact: true }).click();
  await expect(
    page.getByRole("dialog", { name: "Active in the last", exact: true }),
  ).toHaveCount(0);
  await expect
    .poll(
      () =>
        app.report.sidebarPublications.at(-1)?.blob.activeWindowSeconds
          ?.channels,
    )
    .toBe(30 * 86400);
  await active();
  await page.emulateMedia({ colorScheme: "dark" });
  await shot("10-dialog-dark");
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await page
    .getByRole("button", { name: "More actions for Work", exact: true })
    .click();
  await page.getByRole("menuitem", { name: "Filter", exact: true }).hover();
  await page.getByRole("menuitemradio", { name: /Active in the last/ }).click();
  await page.getByRole("radio", { name: "1 day", exact: true }).click();
  await page.getByRole("button", { name: "Apply", exact: true }).click();
  const work = page.locator('[data-sidebar-section="group:work"]');
  await expect(work.locator("[data-channel-id]")).toHaveCount(0);
  await expect(work.locator("details")).toHaveAttribute("open");
  await expect(page.getByText("0 matches", { exact: true })).toHaveCount(0);
  await expect(
    page.getByText("No channels match this filter.", { exact: true }),
  ).toHaveCount(0);
  await shot("11-empty-header-dark");
  await page.emulateMedia({ colorScheme: "light" });
  await page.setViewportSize({ width: 800, height: 850 });
  await active();
  await page.evaluate(() => {
    document.documentElement.style.fontSize = "150%";
  });
  await shot("12-narrow-enlarged-text");
  await page.evaluate(() => {
    document.documentElement.style.fontSize = "";
  });
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.setViewportSize({ width: 1440, height: 950 });
  await page.getByLabel("Work", { exact: true }).click();
  await expect(work.locator("details")).not.toHaveAttribute("open");
  await shot("13-collapsed-empty");
  await page.route("**/session", async (route) => {
    const response = await route.fetch();
    await route.fulfill({
      response,
      json: { ...(await response.json()), sidebarFilterWrites: false },
    });
  });
  await page.reload();
  await page
    .getByRole("button", { name: "More actions for Work", exact: true })
    .click();
  await page.getByRole("menuitem", { name: "Filter", exact: true }).hover();
  await expect(
    page.getByRole("menuitemradio", { name: "All", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("menuitemradio", { name: /Active in the last/ }),
  ).toBeDisabled();
  await expect(
    page.getByRole("menuitem", { name: "Planning", exact: true }),
  ).toBeEnabled();
  const disabledActive = page.getByRole("menuitemradio", {
    name: /Active in the last/,
  });
  // Real CSS must mute the duration and selected check with the disabled label.
  for (const theme of ["light", "dark"]) {
    await page.emulateMedia({ colorScheme: theme });
    await expect
      .poll(() =>
        disabledActive.evaluate((element) => {
          const color = getComputedStyle(element).color;
          return [".buzz-menu-trailing", ".buzz-menu-item-indicator"].every(
            (selector) =>
              getComputedStyle(element.querySelector(selector)).color === color,
          );
        }),
      )
      .toBe(true);
  }
  await page.emulateMedia({ colorScheme: "light" });
  await shot("14-read-only-hidden-channels");
  await page.getByRole("menuitem", { name: "Planning", exact: true }).click();
  await expect(work.locator('[data-channel-id="beta"]')).toBeVisible();
});

test("failed activity reads explain the filter and recover on Retry", async ({
  page,
  app,
}, testInfo) => {
  app.histories.set("primary/delta", [
    app.sign({
      kind: 9,
      tags: [["h", "delta"]],
      content: "Old update",
      created_at: Math.floor(Date.now() / 1000) - 60 * 86400,
    }),
  ]);
  const unknown = page.locator(
    '[data-sidebar-section="channels"] [data-channel-id="delta"]',
  );
  app.histories.set("primary/gamma", [
    app.sign({
      kind: 9,
      tags: [["h", "gamma"]],
      content: "Project update",
      created_at: Math.floor(Date.now() / 1000),
    }),
  ]);
  await page.addInitScript(() =>
    localStorage.setItem("buzz-appearance.v1", "dark"),
  );
  let release;
  let started;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const requested = new Promise((resolve) => {
    started = resolve;
  });
  const pattern = "**/channel-activity";
  await page.route(pattern, async (route) => {
    started();
    await gate;
    app.report.sidebarActivityFailures ??= [];
    app.report.sidebarActivityFailures.push(route.request().url());
    // A denial: a transient failure would retry quietly first.
    await route.fulfill({
      status: 403,
      contentType: "application/json",
      body: JSON.stringify({ error: "Activity unavailable" }),
    });
  });
  await page.goto(app.origin);
  await openPage(page, "Messages");
  // Filters preserve the current channel; choose a different destination from
  // the row whose exclusion this journey exercises, regardless of startup order.
  await page
    .locator('[data-sidebar-section] [data-channel-id="alpha"]')
    .click();
  await expect(
    page.getByRole("textbox", { name: "Message #General" }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "More actions for Channels", exact: true })
    .click();
  await page.getByRole("menuitem", { name: "Filter", exact: true }).hover();
  await page.getByRole("menuitemradio", { name: /Active in the last/ }).click();
  try {
    await page.getByRole("button", { name: "Apply", exact: true }).click();
    await requested;
    await expect(
      page.getByRole("dialog", { name: "Active in the last", exact: true }),
    ).toHaveCount(0);
    await expect(unknown).toBeVisible();
  } finally {
    release();
  }
  await expect(
    page.getByText("Activity filters and Recent sorting may be out of date.", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(unknown).toBeVisible();
  if (
    process.env.BUZZ_FILTER_CAPTURE_DIR &&
    testInfo.project.name === "chromium"
  ) {
    await page.evaluate(async () => {
      await Promise.all(
        document
          .getAnimations()
          .filter(
            (animation) =>
              animation.effect?.getComputedTiming().iterations !== Infinity,
          )
          .map((animation) => animation.finished.catch(() => {})),
      );
    });
    await page.screenshot({
      path: join(
        process.env.BUZZ_FILTER_CAPTURE_DIR,
        "15-activity-read-error.png",
      ),
    });
  }
  await page.unroute(pattern);
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(
    page.locator('[data-sidebar-section="channels"] [data-channel-id="gamma"]'),
  ).toBeVisible();
  await expect(
    page.getByText("Activity filters and Recent sorting may be out of date.", {
      exact: true,
    }),
  ).toHaveCount(0);
  await expect(unknown).toHaveCount(0);
});

test.describe("filter action focus", () => {
  test.use({ readState: true });
  // Native focus handoff after a menu action unmounts its trigger is browser-owned.
  test("filtered-out row actions return focus to the owning section", async ({
    page,
    app,
  }) => {
    // Without a saved selection, startup opens whichever channel loads first,
    // which can be Archive. A short focused dwell there marks it read, and the
    // Unreads filter then hides the row this journey needs.
    await page.addInitScript(
      ({ viewer, relay }) =>
        localStorage.setItem(
          `buzz-view.v1:${JSON.stringify([`${relay}:${viewer}`, "selected-channel"])}`,
          JSON.stringify("alpha"),
        ),
      { viewer: app.viewer, relay: fixtureRelayUrl },
    );
    await page.goto(app.origin);
    await openPage(page, "Messages");
    // Filters preserve the current channel; keep it away from the row whose
    // exclusion this journey exercises.
    await page
      .locator('[data-sidebar-section] [data-channel-id="alpha"]')
      .click();
    await expect(
      page.getByRole("textbox", { name: "Message #General" }),
    ).toBeVisible();
    const channels = page.locator('[data-sidebar-section="channels"]');
    const work = page.locator('[data-sidebar-section="group:work"]');
    const row = channels.locator('[data-channel-id="delta"]');
    const filter = async (section, title, name) => {
      await section
        .getByRole("button", { name: `More actions for ${title}`, exact: true })
        .click();
      await page.getByRole("menuitem", { name: "Filter", exact: true }).hover();
      await page.getByRole("menuitemradio", { name, exact: true }).click();
    };
    await expect(row).toBeVisible();
    // Unreads keeps only rows with observed unread history; wait for it first.
    await expect(row.getByRole("img", { name: /unread/ })).toBeVisible();
    await filter(channels, "Channels", "Unreads");
    await expect(row).toBeVisible();
    await row.click({ button: "right" });
    await page
      .getByRole("menuitem", { name: "Mark as read", exact: true })
      .click();
    await expect(row).toHaveCount(0);
    await expect(channels.locator("details > summary")).toBeFocused();
    await filter(work, "Work", "Unreads");
    await filter(channels, "Channels", "All");
    await expect(row).toBeVisible();
    await row.click({ button: "right" });
    await page
      .getByRole("menuitem", { name: "Move channel", exact: true })
      .hover();
    await page
      .getByRole("menuitemradio", { name: "Work", exact: true })
      .click();
    await expect(row).toHaveCount(0);
    await expect(work.locator('[data-channel-id="delta"]')).toHaveCount(0);
    await expect(work.locator("details > summary")).toBeFocused();
  });
});

test.describe("show all conversations", () => {
  // Browser-only: real key dispatch from a row and from the composer, a host
  // rebind through Settings → Shortcuts, the checkbox's real paint in both
  // themes, and expiry through the page's own timers. Expiry uses a 5-second
  // duration saved the way Settings saves one, so the page clock stays well
  // inside the broker's 60-second read-state signing window.
  const open = async (page, app, { seconds } = {}) => {
    const now = Math.floor(Date.now() / 1000);
    for (const [id, age] of [
      ["alpha", 0],
      ["beta", 0],
      ["gamma", 0],
      ["delta", 45],
    ]) {
      app.histories.set(`primary/${id}`, [
        app.sign({
          kind: 9,
          tags: [["h", id]],
          content: "Project update",
          created_at: now - age * 86400,
        }),
      ]);
    }
    await page.addInitScript(
      ({ viewer, relay, seconds }) => {
        localStorage.setItem(
          `buzz-view.v1:${JSON.stringify([`${relay}:${viewer}`, "selected-channel"])}`,
          JSON.stringify("alpha"),
        );
        if (seconds)
          localStorage.setItem("buzz-show-all-duration.v1", String(seconds));
      },
      { viewer: app.viewer, relay: fixtureRelayUrl, seconds },
    );
    await page.goto(app.origin);
    await openPage(page, "Messages");
    await page
      .locator('[data-sidebar-section] [data-channel-id="alpha"]')
      .click();
    const composer = page.getByRole("textbox", { name: "Message #General" });
    await expect(composer).toBeVisible();
    const modifier = (await page.evaluate(() =>
      /Mac|iPhone|iPad/.test(navigator.platform),
    ))
      ? "Meta"
      : "Control";
    const channels = page.locator('[data-sidebar-section="channels"]');
    const work = page.locator('[data-sidebar-section="group:work"]');
    const design = channels.locator('[data-channel-id="gamma"]');
    const archive = channels.locator('[data-channel-id="delta"]');
    const planning = work.locator('[data-channel-id="beta"]');
    const filterMenu = async (section, title) => {
      await section
        .getByRole("button", { name: `More actions for ${title}`, exact: true })
        .click();
      await page.getByRole("menuitem", { name: "Filter", exact: true }).hover();
      await expect(
        page.getByRole("menu", { name: `Filter ${title}`, exact: true }),
      ).toBeVisible();
    };
    // The viewer wrote every message, so nothing is unread: Unreads empties
    // Work, and the last 7 days in Channels leave out Archive.
    const filter = async () => {
      await expect(planning).toBeVisible();
      await filterMenu(work, "Work");
      await page
        .getByRole("menuitemradio", { name: "Unreads", exact: true })
        .click();
      await filterMenu(channels, "Channels");
      await page
        .getByRole("menuitemradio", { name: /Active in the last/ })
        .click();
      await page.getByRole("radio", { name: "7 days", exact: true }).click();
      await page.getByRole("button", { name: "Apply", exact: true }).click();
      await filtered();
    };
    const filtered = async () => {
      await expect(design).toBeVisible();
      await expect(archive).toHaveCount(0);
      await expect(planning).toHaveCount(0);
    };
    const everything = async () => {
      await expect(archive).toBeVisible();
      await expect(planning).toBeVisible();
      await expect(design).toBeVisible();
    };
    return {
      composer,
      modifier,
      channels,
      design,
      archive,
      planning,
      filterMenu,
      filter,
      filtered,
      everything,
    };
  };

  test("pauses every section filter from the key or the menu", async ({
    page,
    app,
  }, testInfo) => {
    const {
      composer,
      modifier,
      channels,
      design,
      filterMenu,
      filter,
      filtered,
      everything,
    } = await open(page, app);
    const showAllChoice = page.getByRole("menuitemcheckbox", {
      name: "Show all conversations",
      exact: true,
    });

    // Before any filter there is nothing to pause, so nothing is offered.
    await filterMenu(channels, "Channels");
    await expect(
      page.getByRole("menuitemradio", { name: "All", exact: true }),
    ).toBeVisible();
    await expect(showAllChoice).toHaveCount(0);
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");

    await filter();
    const publications = app.report.sidebarPublications.length;

    // From a focused sidebar row: the first press shows all, the second ends it.
    await design.focus();
    await page.keyboard.press(`${modifier}+Shift+f`);
    await everything();
    await page.keyboard.press(`${modifier}+Shift+f`);
    await filtered();

    // From the composer, without touching its draft.
    await composer.fill("Keep my draft");
    await page.keyboard.press(`${modifier}+Shift+f`);
    await everything();
    await expect(composer).toBeFocused();
    await expect(composer).toHaveJSProperty("value", "Keep my draft");
    await page.keyboard.press(`${modifier}+Shift+f`);
    await filtered();
    await expect(composer).toHaveJSProperty("value", "Keep my draft");
    await expect(
      page.locator('[data-sidebar-section] [data-channel-id="alpha"]'),
    ).toBeVisible();

    // The menu checkbox toggles the same pause and shows its state, in both themes.
    await filterMenu(channels, "Channels");
    await expect(showAllChoice).toHaveAttribute("aria-checked", "false");
    await showAllChoice.click();
    await everything();
    for (const theme of ["light", "dark"]) {
      await page.emulateMedia({ colorScheme: theme });
      await filterMenu(channels, "Channels");
      await expect(showAllChoice).toBeVisible();
      await expect(showAllChoice).toHaveAttribute("aria-checked", "true");
      await expect(
        showAllChoice.locator(".buzz-menu-item-indicator"),
      ).toBeVisible();
      await expect(
        page.getByRole("menuitemradio", { name: /Active in the last/ }),
      ).toHaveAttribute("aria-checked", "true");
      if (
        process.env.BUZZ_FILTER_CAPTURE_DIR &&
        testInfo.project.name === "chromium"
      )
        await page.screenshot({
          path: join(
            process.env.BUZZ_FILTER_CAPTURE_DIR,
            `16-show-all-${theme}.png`,
          ),
        });
      await page.keyboard.press("Escape");
      await page.keyboard.press("Escape");
    }
    await page.emulateMedia({ colorScheme: "light" });
    await filterMenu(channels, "Channels");
    await showAllChoice.click();
    await filtered();
    // Pausing never saves: the only publications are the two filter choices.
    expect(app.report.sidebarPublications).toHaveLength(publications);

    // A rebound chord replaces ⌘⇧F (Ctrl+Shift+F elsewhere).
    await page.keyboard.press(`${modifier}+,`);
    await page.getByRole("button", { name: "Shortcuts", exact: true }).click();
    const region = page.getByRole("region", { name: "Shortcuts", exact: true });
    const row = region.getByRole("article", {
      name: "Show all conversations",
      exact: true,
    });
    await row
      .getByRole("button", {
        name: "Change shortcut for Show all conversations",
        exact: true,
      })
      .click();
    await expect(
      page.getByRole("textbox", {
        name: "New shortcut for Show all conversations",
      }),
    ).toBeFocused();
    await page.keyboard.press(`${modifier}+Shift+j`);
    await expect(row.getByText("Modified")).toBeVisible();
    await closeSettings(page);
    await filtered();
    // If the old chord still toggled, the new one would toggle it back off.
    await page.keyboard.press(`${modifier}+Shift+f`);
    await page.keyboard.press(`${modifier}+Shift+j`);
    await everything();
  });

  test("brings the saved filters back when the chosen duration ends, keeping the open conversation", async ({
    page,
    app,
  }) => {
    await page.clock.install();
    const { modifier, planning, filter, filtered, everything } = await open(
      page,
      app,
      { seconds: 5 },
    );
    await filter();
    await page.keyboard.press(`${modifier}+Shift+f`);
    await everything();
    // Planning is hidden by Work's Unreads filter once the pause ends.
    await planning.click();
    await expect(
      page.getByRole("textbox", { name: "Message #Planning" }),
    ).toBeVisible();
    await pauseClock(page);
    await page.clock.runFor(4_000);
    await everything();
    await page.clock.runFor(1_000);
    await page.clock.resume();
    await expect(
      page.locator(
        '[data-sidebar-section="channels"] [data-channel-id="delta"]',
      ),
    ).toHaveCount(0);
    // The open conversation stays where it was; the rest are filtered again.
    await expect(planning).toBeVisible();
    await expect(
      page.getByRole("textbox", { name: "Message #Planning" }),
    ).toBeVisible();
    await page
      .locator('[data-sidebar-section] [data-channel-id="alpha"]')
      .click();
    await filtered();
  });
});
