import {
  chooseColorMode,
  closeSettings,
  openSettings,
  selectSettingsSection,
  settingsDialog,
} from "./navigation.mjs";
import { test, expect } from "./fixture.mjs";

test.use({ historyCounts: { alpha: 1 }, launchAnimation: true });

const themeKey = "buzz-theme.v1";
const accentKey = "buzz-accent.v1";

const frameParts = (page) => [
  page.locator("header.shell-header"),
  page.locator("nav.shell-side-dock"),
  page.locator("#shell-navigation"),
];

const background = (locator) =>
  locator.evaluate((node) => getComputedStyle(node).backgroundColor);

const resolved = (page, variable, scope = "html") =>
  page.evaluate(
    ([name, selector]) => {
      const probe = document.createElement("span");
      probe.style.backgroundColor = `var(${name})`;
      document.querySelector(selector).append(probe);
      const color = getComputedStyle(probe).backgroundColor;
      probe.remove();
      return color;
    },
    [variable, scope],
  );

async function appearance(page) {
  await openSettings(page);
  await expect(
    settingsDialog(page).getByRole("button", {
      name: "Close Settings",
      exact: true,
    }),
  ).toBeFocused();
  await selectSettingsSection(page, "Appearance");
}

const radios = (page) =>
  page
    .getByRole("radiogroup", { name: "Theme", exact: true })
    .getByRole("radio");

async function expectFramed(page, framed) {
  for (const part of frameParts(page)) {
    if (framed) {
      await expect(part).toHaveAttribute("data-theme-frame", "");
      await expect(part).toHaveClass(/\bdark\b/);
      await expect(part).toHaveAttribute("data-color-mode", "dark");
    } else {
      await expect(part).not.toHaveAttribute("data-theme-frame", "");
      await expect(part).not.toHaveAttribute("data-color-mode", /.*/);
    }
  }
}

const FRAMED_THEMES = [
  {
    id: "relax",
    label: "Relax",
    description: "Deep plum frame around a bright, open workspace.",
    light: {
      sidebar: "rgb(76, 28, 72)",
      canvas: "rgb(59, 18, 56)",
      selected: "rgb(246, 231, 242)",
    },
    dark: {
      sidebar: "rgb(33, 22, 33)",
      canvas: "rgb(23, 15, 23)",
      selected: "rgb(107, 52, 102)",
    },
  },
  {
    id: "utmost",
    label: "Utmost",
    description:
      "A steady navy sidebar, a crisp white page and a confident blue.",
    light: {
      sidebar: "rgb(27, 49, 82)",
      canvas: "rgb(20, 36, 63)",
      selected: "rgb(59, 108, 216)",
    },
    dark: {
      sidebar: "rgb(22, 32, 55)",
      canvas: "rgb(14, 21, 37)",
      selected: "rgb(60, 107, 217)",
    },
  },
];
const UNFRAMED_THEMES = [
  "troupe",
  "cacophony",
  "cable",
  "baton",
  "howdy",
  "tundra",
];
const THEME_COUNT = 1 + FRAMED_THEMES.length + UNFRAMED_THEMES.length;

for (const [index, theme] of FRAMED_THEMES.entries()) {
  const { id, label, description, light, dark } = theme;
  const pick = new RegExp(`^${label}`);
  const others = FRAMED_THEMES.filter((other) => other.id !== id);
  test(`${label} is picked by keyboard and pointer, survives reload and frames the shell only in light mode`, async ({
    page,
    app,
  }) => {
    await page.goto(app.origin);
    await expect(page.locator("html")).toHaveAttribute("data-theme", "buzz");
    await expectFramed(page, false);
    const buzzSidebar = await background(page.locator("#shell-navigation"));

    await appearance(page);
    const group = page.getByRole("radiogroup", { name: "Theme", exact: true });
    await expect(radios(page)).toHaveCount(THEME_COUNT);
    await expect(group.getByRole("radio", { name: /^Buzz/ })).toBeChecked();
    await expect(group.getByRole("radio", { name: pick })).not.toBeChecked();
    // The name and the description each have one owner; the thumbnail has none.
    await expect(
      group.getByRole("radio", { name: pick }),
    ).toHaveAccessibleDescription(description);
    await expect(group.locator("svg:not([aria-hidden='true'])")).toHaveCount(0);

    const cardLook = (themeId) =>
      group.locator(`svg[data-theme="${themeId}"]`).evaluate((node) => {
        const style = getComputedStyle(node);
        return ["--surface-sidebar", "--surface-message-own"]
          .map((slot) => style.getPropertyValue(slot))
          .join(" ");
      });
    const previews = async () =>
      Object.fromEntries(
        await Promise.all(
          ["buzz", ...FRAMED_THEMES.map((t) => t.id), ...UNFRAMED_THEMES].map(
            async (themeId) => [themeId, await cardLook(themeId)],
          ),
        ),
      );
    const cards = await previews();
    expect(
      new Set(Object.values(cards)).size,
      "every card previews a different sidebar and own-message fill",
    ).toBe(THEME_COUNT);

    await group.getByRole("radio", { name: /^Buzz/ }).focus();
    for (let step = 0; step <= index; step += 1)
      await page.keyboard.press("ArrowRight");
    await expect(group.getByRole("radio", { name: pick })).toBeChecked();
    await expect(group.getByRole("radio", { name: pick })).toBeFocused();
    await expect(page.locator("html")).toHaveAttribute("data-theme", id);
    expect(await page.evaluate((k) => localStorage.getItem(k), themeKey)).toBe(
      id,
    );
    expect(
      await page.evaluate((k) => localStorage.getItem(k), accentKey),
      "choosing a theme writes only the theme key",
    ).toBeNull();
    await expect(
      page.getByRole("button", { name: "Theme accent color" }),
    ).toHaveAttribute("aria-pressed", "true");

    expect(
      await previews(),
      "each card previews its own theme, not the page theme",
    ).toEqual(cards);

    await expectFramed(page, true);
    const frameSidebar = await resolved(
      page,
      "--surface-sidebar",
      "#shell-navigation",
    );
    expect(frameSidebar).toBe(light.sidebar);
    expect(
      await background(page.locator("#shell-navigation .panel[data-sidebar]")),
    ).toBe(frameSidebar);
    expect(frameSidebar).not.toBe(buzzSidebar);
    expect(await resolved(page, "--bg-app", "header.shell-header")).toBe(
      light.canvas,
    );
    expect(
      await resolved(page, "--surface-sidebar-selected", "#shell-navigation"),
    ).toBe(light.selected);
    for (const other of others)
      expect(frameSidebar).not.toBe(other.light.sidebar);

    // The main pane and portaled UI keep the page mode.
    const mainPane = page.locator("main, [data-shell-main]").first();
    await expect(mainPane).not.toHaveAttribute("data-theme-frame", "");
    expect(await resolved(page, "--surface-panel", "body")).toBe(
      "rgb(255, 255, 255)",
    );
    await page.getByRole("combobox", { name: "Mode", exact: true }).click();
    const listbox = page.getByRole("listbox");
    await expect(listbox).toBeVisible();
    await expect(listbox).not.toHaveAttribute("data-theme-frame", "");
    expect(
      await listbox.evaluate((node) => ({
        inFrame: node.closest("[data-theme-frame]") !== null,
        popover: getComputedStyle(node).getPropertyValue("--surface-popover"),
      })),
    ).toEqual({
      inFrame: false,
      popover: await page.evaluate(() =>
        getComputedStyle(document.documentElement).getPropertyValue(
          "--surface-popover",
        ),
      ),
    });
    await page.keyboard.press("Escape");

    await group.getByText("Buzz", { exact: true }).click();
    await expect(group.getByRole("radio", { name: /^Buzz/ })).toBeChecked();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "buzz");
    await expectFramed(page, false);
    expect(await background(page.locator("#shell-navigation"))).toBe(
      buzzSidebar,
    );
    await group.getByText(label, { exact: true }).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", id);

    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("data-theme", id);
    await expectFramed(page, true);
    await expect(page.locator("html")).toHaveAttribute("data-accent", "theme");

    await expect(
      settingsDialog(page).getByRole("button", {
        name: "Close Settings",
        exact: true,
      }),
    ).toBeFocused();
    await selectSettingsSection(page, "Appearance");
    await expect(group.getByRole("radio", { name: pick })).toBeChecked();
    await chooseColorMode(page, "Dark");
    await expectFramed(page, false);
    await expect(page.locator("html")).toHaveAttribute(
      "data-color-mode",
      "dark",
    );
    expect(await resolved(page, "--surface-sidebar", "#shell-navigation")).toBe(
      dark.sidebar,
    );
    expect(await resolved(page, "--bg-app", "header.shell-header")).toBe(
      dark.canvas,
    );
    expect(
      await resolved(page, "--surface-sidebar-selected", "#shell-navigation"),
    ).toBe(dark.selected);
    await chooseColorMode(page, "Light");
    await expectFramed(page, true);
    await closeSettings(page);
    await expect(page.locator("#shell-navigation")).toHaveAttribute(
      "data-theme-frame",
      "",
    );
  });
}

test("a saved manual accent stays when the theme changes", async ({
  page,
  app,
}) => {
  await page.addInitScript(() => {
    if (localStorage.getItem("buzz-accent.v1") === null)
      localStorage.setItem("buzz-accent.v1", "cobalt");
  });
  await page.goto(app.origin);
  await expect(page.locator("html")).toHaveAttribute("data-accent", "cobalt");
  await appearance(page);
  await page
    .getByRole("radiogroup", { name: "Theme", exact: true })
    .getByText("Relax", { exact: true })
    .click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "relax");
  await expect(page.locator("html")).toHaveAttribute("data-accent", "cobalt");
  await expect(
    page.getByRole("button", { name: "Cobalt accent color" }),
  ).toHaveAttribute("aria-pressed", "true");
});

test("a theme with a light frame keeps the shell unframed in both modes and the Theme accent follows its family", async ({
  page,
  app,
}) => {
  await page.goto(app.origin);
  await appearance(page);
  const group = page.getByRole("radiogroup", { name: "Theme", exact: true });
  await group.getByText("Troupe", { exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "troupe");
  await expect(page.locator("html")).toHaveAttribute("data-accent", "theme");
  expect(await page.evaluate((k) => localStorage.getItem(k), themeKey)).toBe(
    "troupe",
  );
  expect(
    await page.evaluate((k) => localStorage.getItem(k), accentKey),
  ).toBeNull();

  await chooseColorMode(page, "Light");
  await expectFramed(page, false);
  expect(await resolved(page, "--surface-sidebar", "#shell-navigation")).toBe(
    "rgb(244, 244, 248)",
  );
  expect(await resolved(page, "--bg-app", "header.shell-header")).toBe(
    "rgb(234, 234, 240)",
  );
  expect(await resolved(page, "--accent-9")).toBe("rgb(95, 98, 194)");

  await chooseColorMode(page, "Dark");
  await expectFramed(page, false);
  expect(await resolved(page, "--surface-sidebar", "#shell-navigation")).toBe(
    "rgb(30, 30, 34)",
  );
  expect(await resolved(page, "--bg-app", "header.shell-header")).toBe(
    "rgb(17, 17, 20)",
  );
  expect(await resolved(page, "--accent-9")).toBe("rgb(98, 102, 217)");

  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "troupe");
  await expectFramed(page, false);
});

test("Cacophony keeps its frame in the page mode and stacks three distinct dark layers", async ({
  page,
  app,
}) => {
  await page.goto(app.origin);
  await appearance(page);
  const group = page.getByRole("radiogroup", { name: "Theme", exact: true });
  await group.getByText("Cacophony", { exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "cacophony");
  await expect(page.locator("html")).toHaveAttribute("data-accent", "theme");

  await expectFramed(page, false);
  expect(await resolved(page, "--surface-sidebar", "#shell-navigation")).toBe(
    "rgb(240, 241, 245)",
  );
  expect(await resolved(page, "--bg-app", "header.shell-header")).toBe(
    "rgb(225, 227, 234)",
  );
  expect(await resolved(page, "--accent-9", "body")).toBe("rgb(95, 85, 250)");

  await chooseColorMode(page, "Dark");
  await expectFramed(page, false);
  const layers = {
    canvas: await resolved(page, "--bg-app", "header.shell-header"),
    sidebar: await resolved(page, "--surface-sidebar", "#shell-navigation"),
    main: await resolved(page, "--surface-panel", "body"),
  };
  expect(layers).toEqual({
    canvas: "rgb(18, 19, 24)",
    sidebar: "rgb(25, 26, 33)",
    main: "rgb(32, 33, 43)",
  });
  const brightness = (color) =>
    color.match(/\d+/g).reduce((sum, channel) => sum + Number(channel), 0);
  expect(brightness(layers.canvas)).toBeLessThan(brightness(layers.sidebar));
  expect(brightness(layers.sidebar)).toBeLessThan(brightness(layers.main));
  const bubbles = {
    received: await resolved(page, "--bubble-received", "body"),
    own: await resolved(page, "--bubble-neutral", "body"),
  };
  expect(bubbles).toEqual({
    received: "rgb(44, 46, 56)",
    own: "rgb(58, 60, 69)",
  });
  expect(
    new Set([...Object.values(bubbles), layers.main]).size,
    "the bubbles and the main pane are three distinct steps",
  ).toBe(3);
  expect(
    await background(page.locator("#shell-navigation .panel[data-sidebar]")),
  ).toBe(layers.sidebar);
  expect(await resolved(page, "--accent-9", "body")).toBe("rgb(95, 85, 250)");
});

test("Cable fills own bubbles with green under the Theme accent and yields to a manual accent", async ({
  page,
  app,
}) => {
  await page.goto(app.origin);
  await appearance(page);
  const group = page.getByRole("radiogroup", { name: "Theme", exact: true });
  await expect(group.getByRole("radio", { name: /^Cable/ })).not.toBeChecked();
  await expect(
    group.getByRole("radio", { name: /^Cable/ }),
  ).toHaveAccessibleDescription("Airy sky blue with fresh green replies.");
  await group.getByText("Cable", { exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "cable");
  await expect(page.locator("html")).toHaveAttribute("data-accent", "theme");
  await expectFramed(page, false);

  const ownBubble = async () => ({
    fill: await resolved(page, "--surface-message-own"),
    text: await resolved(page, "--text-message-own"),
  });
  expect(await ownBubble()).toEqual({
    fill: "rgb(232, 247, 219)",
    text: "rgb(31, 51, 19)",
  });
  expect(await resolved(page, "--accent-9")).toBe("rgb(16, 123, 187)");

  await chooseColorMode(page, "Dark");
  expect(await ownBubble()).toEqual({
    fill: "rgb(42, 78, 114)",
    text: "rgb(238, 245, 252)",
  });
  await chooseColorMode(page, "Light");

  await page.getByRole("button", { name: "Cobalt accent color" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-accent", "cobalt");
  const accentBubble = await ownBubble();
  expect(accentBubble.fill).toBe(await resolved(page, "--accent-4"));
  expect(accentBubble.fill).not.toBe("rgb(232, 247, 219)");

  await page.getByRole("button", { name: "Theme accent color" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-accent", "theme");
  expect((await ownBubble()).fill).toBe("rgb(232, 247, 219)");
});

test("Baton keeps its frame on the page mode and changes accent between modes", async ({
  page,
  app,
}) => {
  await page.goto(app.origin);
  await appearance(page);
  const group = page.getByRole("radiogroup", { name: "Theme", exact: true });
  await group.getByText("Baton", { exact: true }).click();
  await expect(group.getByRole("radio", { name: /^Baton/ })).toBeChecked();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "baton");
  expect(await page.evaluate((k) => localStorage.getItem(k), themeKey)).toBe(
    "baton",
  );
  await expect(
    page.getByRole("button", { name: "Theme accent color" }),
  ).toHaveAttribute("aria-pressed", "true");

  await chooseColorMode(page, "Light");
  await expectFramed(page, false);
  expect(await resolved(page, "--surface-sidebar", "#shell-navigation")).toBe(
    "rgb(255, 255, 255)",
  );
  expect(await resolved(page, "--bg-app", "header.shell-header")).toBe(
    "rgb(196, 193, 184)",
  );
  expect(await resolved(page, "--accent-9")).toBe("rgb(16, 16, 138)");
  expect(await resolved(page, "--border-standard")).toBe("rgb(128, 128, 128)");
  expect(
    (
      await group
        .locator('svg[data-theme="relax"]')
        .evaluate((node) =>
          getComputedStyle(node).getPropertyValue("--border-standard"),
        )
    ).trim(),
    "a card keeps its own hairline instead of the page theme's",
  ).toBe("#e6dfe5");

  await chooseColorMode(page, "Dark");
  await expectFramed(page, false);
  expect(await resolved(page, "--surface-sidebar", "#shell-navigation")).toBe(
    "rgb(8, 8, 8)",
  );
  expect(await resolved(page, "--bg-app", "header.shell-header")).toBe(
    "rgb(30, 30, 30)",
  );
  expect(await resolved(page, "--surface-panel", "body")).toBe("rgb(0, 0, 0)");
  expect(await resolved(page, "--accent-9")).toBe("rgb(43, 209, 43)");
  expect(await resolved(page, "--border-standard")).toBe("rgb(58, 58, 58)");
});

test("Howdy gives own bubbles the mint fill only with the Theme accent", async ({
  page,
  app,
}) => {
  await page.goto(app.origin);
  await appearance(page);
  const group = page.getByRole("radiogroup", { name: "Theme", exact: true });
  await group.getByText("Howdy", { exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "howdy");
  await expect(page.locator("html")).toHaveAttribute("data-accent", "theme");
  await expect(page.locator("html")).toHaveAttribute(
    "data-color-level",
    "touch",
  );
  expect(await resolved(page, "--surface-message-own")).toBe(
    "rgb(218, 246, 208)",
  );
  expect(await resolved(page, "--surface-panel", "body")).toBe(
    "rgb(247, 243, 234)",
  );
  await expectFramed(page, false);
  const cardBubble = (theme) =>
    group
      .locator(`svg[data-theme="${theme}"]`)
      .evaluate((node) =>
        getComputedStyle(node).getPropertyValue("--surface-message-own"),
      );
  expect(
    await cardBubble("howdy"),
    "the Howdy card previews the mint fill",
  ).not.toBe(await cardBubble("buzz"));
  expect(
    await cardBubble("relax"),
    "another theme's card does not inherit the page theme's bubble",
  ).not.toBe(await cardBubble("howdy"));
  await chooseColorMode(page, "Dark");
  expect(await resolved(page, "--surface-message-own")).toBe("rgb(4, 89, 74)");
  expect(await resolved(page, "--affordance-mention-own-hover")).toBe(
    "rgb(5, 118, 98)",
  );
  await chooseColorMode(page, "Light");

  await page.getByRole("button", { name: "Cobalt accent color" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-accent", "cobalt");
  expect(await resolved(page, "--surface-message-own")).toBe(
    await resolved(page, "--accent-4"),
  );
  expect(await resolved(page, "--surface-message-own")).not.toBe(
    "rgb(218, 246, 208)",
  );
  expect(await resolved(page, "--text-metadata-own")).toBe(
    await resolved(page, "--text-metadata"),
  );
});
