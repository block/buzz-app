import { test, expect } from "./fixture.mjs";
import { openPage } from "./navigation.mjs";
import { join } from "node:path";

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
  await openPage(page, "Multiplayer");
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
      page.getByRole("menu", { name: "Filter", exact: true }),
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
  await shot("06-hidden-channels");
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
    const color = await disabledActive.evaluate(
      (element) => getComputedStyle(element).color,
    );
    await expect(disabledActive.locator(".buzz-menu-trailing")).toHaveCSS(
      "color",
      color,
    );
    await expect(disabledActive.locator(".buzz-menu-item-indicator")).toHaveCSS(
      "color",
      color,
    );
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
    await route.fulfill({
      status: 502,
      contentType: "application/json",
      body: JSON.stringify({ error: "Activity unavailable" }),
    });
  });
  await page.goto(app.origin);
  await openPage(page, "Multiplayer");
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
  } finally {
    release();
  }
  await expect(
    page.getByText("Activity filters and Recent sorting may be out of date.", {
      exact: true,
    }),
  ).toBeVisible();
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
});
