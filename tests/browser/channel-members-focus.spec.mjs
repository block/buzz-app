import { expect, test } from "./playwright-test.mjs";
import { build, preview } from "./vite-server.mjs";
import react from "@vitejs/plugin-react";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { watchPageErrors } from "./page-errors.mjs";
import { animationsSettled } from "./animations.mjs";

let server;
let directory;
let url;

// Immutable build/server per worker; each test owns its page and fixture state.
test.beforeAll(async () => {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  directory = await mkdtemp(join(tmpdir(), "buzz-focus-"));
  const config = {
    root,
    configFile: false,
    envFile: false,
    logLevel: "error",
    plugins: [react()],
    build: {
      rollupOptions: {
        input: join(root, "tests/browser/channel-members-focus.html"),
      },
      outDir: join(directory, "dist"),
      emptyOutDir: true,
      target: "esnext",
    },
  };
  await build(config);
  server = await preview({
    ...config,
    preview: { host: "127.0.0.1", port: 0, strictPort: true },
  });
  url = `http://127.0.0.1:${server.httpServer.address().port}/tests/browser/channel-members-focus.html`;
});
test.afterAll(async () => {
  if (server) await new Promise((resolve) => server.httpServer.close(resolve));
  if (directory) await rm(directory, { recursive: true, force: true });
});

async function centerHit(control) {
  return control.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    const hit = document.elementFromPoint(
      bounds.left + bounds.width / 2,
      bounds.top + bounds.height / 2,
    );
    return hit === element || (hit !== null && element.contains(hit));
  });
}

function tabKey(browserName, backwards = false) {
  return `${browserName === "webkit" && process.platform === "darwin" ? "Alt+" : ""}${backwards ? "Shift+" : ""}Tab`;
}

test.describe("member scrolling", () => {
  test("a pointer tab change keeps the tab under the pointer and Tab reaches the first member", async ({
    page,
    browserName,
  }) => {
    await page.setViewportSize({ width: 600, height: 460 });
    await page.goto(
      `${url}?administration&editable-access&search-scale&people-scale`,
    );
    await page.evaluate(() =>
      document.documentElement.style.setProperty("--buzz-text-scale", "2"),
    );
    await page.getByRole("button", { name: "Access", exact: true }).click();
    const dialog = page.getByRole("dialog", {
      name: "Manage members",
      exact: true,
    });
    const list = dialog.getByRole("region", {
      name: "Member list",
      exact: true,
    });
    await expect(list).toHaveAttribute("data-refreshing", "false");
    await animationsSettled(dialog, { subtree: true });
    // Start partway through the list with the tab center exposed.
    await list.evaluate((element) => {
      const tabs = element.querySelector('[role="tablist"]');
      const layout = element.parentElement;
      layout.scrollTop +=
        element.getBoundingClientRect().top -
        layout.getBoundingClientRect().top;
      const bounds = tabs.getBoundingClientRect();
      element.scrollTop +=
        bounds.top - element.getBoundingClientRect().top + bounds.height / 4;
    });
    const agents = dialog.getByRole("tab", { name: /^Agents ·/ });
    expect(await centerHit(agents)).toBe(true);
    const tabs = dialog.getByRole("tablist");
    const top = (await tabs.boundingBox()).y;
    const bounds = await agents.boundingBox();
    const point = {
      x: bounds.x + bounds.width / 2,
      y: bounds.y + bounds.height / 2,
    };
    await page.mouse.click(point.x, point.y);
    await expect(agents).toHaveAttribute("aria-selected", "true");
    expect((await tabs.boundingBox()).y).toBeCloseTo(top, 0);
    expect(
      await agents.evaluate(
        (tab, { x, y }) => tab.contains(document.elementFromPoint(x, y)),
        point,
      ),
    ).toBe(true);
    const first = dialog
      .getByRole("tabpanel")
      .getByRole("button", { name: /^Open profile for / })
      .first();
    await page.keyboard.press(tabKey(browserName));
    await expect(first).toBeFocused();
    expect(await centerHit(first)).toBe(true);
  });

  test("Shift+Tab after paging reaches the selected tab and the tabs scroll away with the rows", async ({
    page,
    browserName,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(
      `${url}?administration&editable-access&search-scale&people-scale`,
    );
    await page.getByRole("button", { name: "Access", exact: true }).click();
    const dialog = page.getByRole("dialog", {
      name: "Manage members",
      exact: true,
    });
    const people = dialog.getByRole("tab", { name: /^People ·/ });
    const panel = dialog.getByRole("tabpanel", { name: /^People ·/ });
    await panel.getByRole("button", { name: "Next", exact: true }).click();
    await expect(panel.getByText("Page 2 of 2", { exact: true })).toBeVisible();
    await expect(panel).toBeFocused();
    const first = panel
      .getByRole("button", { name: /^Open profile for / })
      .first();
    expect(await centerHit(first)).toBe(true);
    expect(await centerHit(people)).toBe(true);
    await page.keyboard.press(tabKey(browserName, true));
    await expect(people).toBeFocused();
    expect(await centerHit(people)).toBe(true);
    await dialog
      .getByRole("region", { name: "Member list", exact: true })
      .evaluate((list) => {
        list.scrollTop = list.scrollHeight;
      });
    await expect(people).not.toBeInViewport();
    await panel.getByRole("button", { name: "Previous", exact: true }).click();
    await expect(panel).toBeFocused();
    expect(await centerHit(first)).toBe(true);
    expect(await centerHit(people)).toBe(true);
  });

  test("backward focus keeps all Solo channel Share buttons clear of sticky headings", async ({
    page,
    browserName,
  }) => {
    await page.goto(
      `${url}?solo&editable-access&search-scale&people-scale&solo-channels`,
    );
    await page.getByRole("button", { name: "Access", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("searchbox").fill("Destination");
    const shares = dialog
      .getByRole("region", { name: "Channels", exact: true })
      .getByRole("button", { name: /^Share #Destination/ });
    await expect(shares).toHaveCount(18);
    const list = dialog.getByRole("region", {
      name: "Member list",
      exact: true,
    });
    await list.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    await dialog
      .getByRole("button", { name: "Done", exact: true })
      .evaluate((element) => element.focus({ preventScroll: true }));
    await page.keyboard.press(tabKey(browserName, true));
    await expect(
      dialog.getByRole("button", { name: "Copy link", exact: true }),
    ).toBeFocused();
    for (let index = 17; index >= 0; index--) {
      await page.keyboard.press(tabKey(browserName, true));
      await expect(shares.nth(index)).toBeFocused();
      expect(await centerHit(shares.nth(index))).toBe(true);
    }
  });
  for (const tabbed of [true, false]) {
    test(`paging keeps focused content visible at enlarged size (${tabbed ? "tabs" : "one group"})`, async ({
      page,
    }) => {
      const { errors } = watchPageErrors(page);
      await page.setViewportSize({ width: 600, height: 460 });
      await page.goto(
        `${url}?administration&editable-access&${tabbed ? "search-scale" : "people-scale"}`,
      );
      await page.evaluate(() =>
        document.documentElement.style.setProperty("--buzz-text-scale", "2"),
      );
      await page.getByRole("button", { name: "Access", exact: true }).click();
      const dialog = page.getByRole("dialog", {
        name: "Manage members",
        exact: true,
      });
      await expect(
        dialog.getByRole("combobox", { name: "General access" }),
      ).toBeEnabled();
      const name = tabbed ? "Agents" : "People";
      if (tabbed) await dialog.getByRole("tab", { name: /^Agents ·/ }).click();
      const group = dialog.getByRole(tabbed ? "tabpanel" : "region", {
        name: tabbed ? /^Agents ·/ : "People",
        exact: !tabbed,
      });
      const pages = group.getByRole("navigation", {
        name: `${name} member pages`,
      });
      await pages.getByRole("button", { name: "Next", exact: true }).click();
      const target = tabbed
        ? group
        : group.getByRole("heading", { name: /^People ·/ });
      await expect(target).toBeFocused();
      await expect(target).toBeInViewport();
      if (!tabbed) {
        expect(errors).toEqual([]);
        return;
      }
      const first = group
        .getByRole("button", { name: /^Open profile for / })
        .first();
      expect(await centerHit(first)).toBe(true);
      await pages
        .getByRole("button", { name: "Previous", exact: true })
        .click();
      await expect(group).toBeFocused();
      expect(await centerHit(first)).toBe(true);
      expect(errors).toEqual([]);
    });
  }

  test("tab changes preserve General when the tabs are visible", async ({
    page,
  }) => {
    await page.goto(
      `${url}?administration&editable-access&search-scale&people-scale`,
    );
    await page.getByRole("button", { name: "Access", exact: true }).click();
    const dialog = page.getByRole("dialog", {
      name: "Manage members",
      exact: true,
    });
    const list = dialog.getByRole("region", {
      name: "Member list",
      exact: true,
    });
    const general = dialog.getByRole("combobox", { name: "General access" });
    await expect(list).toHaveAttribute("data-refreshing", "false");
    await expect(general).toBeInViewport();
    // The heading must not cover its own control before the member tabs.
    const generalBounds = await general.boundingBox();
    await page.mouse.click(
      generalBounds.x + generalBounds.width / 2,
      generalBounds.y + generalBounds.height / 2,
    );
    await expect(
      page.getByRole("option", { name: "Private", exact: true }),
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(general).toBeFocused();
    await dialog.getByRole("tab", { name: /^Agents ·/ }).click();
    await expect(general).toBeInViewport();
  });

  test("other-agent heading disclosure stays clickable after scrolling past the member tabs", async ({
    page,
  }) => {
    const { errors } = watchPageErrors(page);
    await page.setViewportSize({ width: 600, height: 600 });
    await page.goto(`${url}?administration&search-scale&invitation-focus`);
    await page.getByRole("button", { name: "Access", exact: true }).click();
    const dialog = page.getByRole("dialog", {
      name: "Manage members",
      exact: true,
    });
    await dialog.getByRole("searchbox").fill("Helper");
    const list = dialog.getByRole("region", {
      name: "Member list",
      exact: true,
    });
    await expect(list).toHaveAttribute("data-refreshing", "false");
    const others = dialog.getByRole("region", {
      name: "Your other agents",
      exact: true,
    });
    await others
      .getByRole("button", { name: "Show more", exact: true })
      .click();
    await others
      .getByRole("button", { name: "Show more", exact: true })
      .click();
    await list.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    const about = others.getByRole("button", {
      name: "About your other agents",
      exact: true,
    });
    // Click where the scrolled heading actually paints. Locator.click would
    // first scroll a covered sticky heading out of its pinned position.
    const bounds = await about.boundingBox();
    await page.mouse.click(
      bounds.x + bounds.width / 2,
      bounds.y + bounds.height / 2,
    );
    await expect(
      page.getByText("Your agents from other devices or earlier setups.", {
        exact: true,
      }),
    ).toBeVisible();
    expect(errors).toEqual([]);
  });

  test("member search stays visible while a short viewport roster scrolls", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 600, height: 460 });
    await page.goto(`${url}?administration&people-scale`);
    await page.getByRole("button", { name: "Access", exact: true }).click();
    const dialog = page.getByRole("dialog", {
      name: "Manage members",
      exact: true,
    });
    const list = dialog.getByRole("region", {
      name: "Member list",
      exact: true,
    });
    await expect(list).toHaveAttribute("data-refreshing", "false");
    await list.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    const search = dialog.getByRole("searchbox");
    await expect(search).toBeInViewport({ ratio: 1 });
    await search.fill("Member");
    await expect(search).toHaveValue("Member");
  });
});
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    window.copiedNpubs = [];
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (value) => window.copiedNpubs.push(value),
      },
    });
  });
});

// A real mounted member dialog and shared session, but no relay or external write.
test("identity menus preserve modal focus and addition returns focus only to its owner", async ({
  page,
}) => {
  const { errors } = watchPageErrors(page);
  for (const moved of [false, true]) {
    await page.goto(url);
    await page.getByRole("button", { name: "Access" }).click();
    const dialog = page.getByRole("dialog", { name: "Manage members" });
    const search = dialog.getByRole("searchbox");
    await search.fill("Morgan");
    const add = dialog.getByRole("button", { name: /Add Morgan/ });
    await expect(add).toBeEnabled();
    if (!moved) {
      // The Enter target uses the same neutral fill as hover.
      const fills = await dialog
        .locator("[data-highlighted]")
        .evaluate((row) => {
          const probe = (token) => {
            const element = document.createElement("div");
            element.style.background = `var(${token})`;
            row.parentElement.append(element);
            const color = getComputedStyle(element).backgroundColor;
            element.remove();
            return color;
          };
          return {
            row: getComputedStyle(row).backgroundColor,
            neutral: probe("--affordance-subtle"),
            panel: probe("--affordance-selected"),
          };
        });
      expect(fills.neutral).not.toBe(fills.panel);
      expect(fills.row).toBe(fills.neutral);
    }
    const identity = dialog.getByRole("button", {
      name: /Open profile for Morgan/,
    });
    if (!moved) {
      await animationsSettled(dialog, { subtree: true });
      await expect(add).not.toBeFocused();
      const before = await add.boundingBox();
      await identity.hover({ position: { x: 20, y: 20 } });
      const actions = dialog.getByRole("button", {
        name: "Actions for Morgan",
        exact: true,
      });
      await expect(actions).toHaveCount(0);
      expect(await add.boundingBox()).toEqual(before);
      await identity.click({ button: "right" });
      const menu = page.getByRole("menu", {
        name: "Actions for Morgan",
        exact: true,
      });
      await expect(menu.getByRole("menuitem")).toHaveText(["View profile"]);
      await opened(menu);
      await page.keyboard.press("Escape");
      await expect(identity).toBeFocused();
      await expect(dialog).toBeVisible();
      await expect(add).toBeEnabled();
      await page.mouse.move(0, 0);
      await search.focus();
      await page.keyboard.press("Tab");
      await expect(
        dialog.getByRole("button", { name: "Clear search people and agents" }),
      ).toBeFocused();
      await page.keyboard.press("Tab");
      // This fixture deliberately lacks verified role metadata. Error recovery
      // follows the search controls before the collection's identity rows.
      await expect(
        dialog.getByRole("button", { name: "Retry member data" }),
      ).toBeFocused();
      await page.keyboard.press("Tab");
      await expect(identity).toBeFocused();
      await page.keyboard.press("Tab");
      await expect(add).toBeFocused();
      await page.keyboard.press("Shift+F10");
      await opened(menu);
      await expect(menu).toBeFocused();
      await page.keyboard.press("ArrowDown");
      await expect(
        menu.getByRole("menuitem", { name: "View profile", exact: true }),
      ).toBeFocused();
      await page.keyboard.press("Escape");
      await expect(add).toBeFocused();
      await expect(
        page.getByRole("dialog", { name: "Morgan identity", exact: true }),
      ).toHaveCount(0);
    }
    await add.focus();
    await page.keyboard.press("Enter");
    await page.evaluate(() => window.focusFixture.published);
    await expect(add).toHaveAttribute("aria-disabled", "true");
    await expect(add).toBeFocused();
    if (moved) await dialog.getByRole("button", { name: "Close" }).focus();
    await page.evaluate(() => window.focusFixture.confirm());
    await expect(dialog.getByText("Morgan is in the channel.")).toBeVisible();
    await expect(
      moved ? dialog.getByRole("button", { name: "Close" }) : search,
    ).toBeFocused();
  }
  expect(errors).toEqual([]);
});

// Browser-only: retiring the idle section removes another pending Add button
// from the native dialog focus trap. Each publish has its own explicit gate.
test("overlapping idle additions restore focus when the suggestion list retires", async ({
  page,
}) => {
  const { errors } = watchPageErrors(page);
  for (const moved of [false, true]) {
    for (const rejected of [false, true]) {
      await page.goto(`${url}?idle-overlap`);
      await page.getByRole("button", { name: "Access" }).click();
      const dialog = page.getByRole("dialog", { name: "Manage members" });
      const search = dialog.getByRole("searchbox");
      const data = dialog.getByRole("region", { name: "Member list" });
      await expect(data).toHaveAttribute("data-refreshing", "false");
      const invitations = dialog.getByRole("region", {
        name: "Not in this channel",
        exact: true,
      });
      for (const index of [1, 2]) {
        const add = invitations.getByRole("button", {
          name: new RegExp(`^Add Agent ${index} `),
        });
        await add.focus();
        await page.keyboard.press("Enter");
        await expect
          .poll(() => page.evaluate(() => window.focusFixture.additions.length))
          .toBe(index);
        await expect(add).toBeFocused();
        await expect(add).toHaveAttribute("aria-disabled", "true");
      }
      const close = dialog.getByRole("button", { name: "Close", exact: true });
      if (moved) await close.focus();
      await page.evaluate(() => window.focusFixture.settleAddition(0));
      await expect(
        dialog.getByText("Agent 1 is in the channel.", { exact: true }),
      ).toBeVisible();
      await expect(invitations).toHaveCount(0);
      await expect(moved ? close : search).toBeFocused();
      await page.evaluate(
        (failure) => window.focusFixture.settleAddition(1, failure),
        rejected,
      );
      if (rejected) {
        const recovery = dialog.getByRole("alert").filter({
          hasText: "Agent 2: Addition rejected",
        });
        await expect(recovery).toBeVisible();
        await expect(
          recovery.getByRole("button", { name: "Retry adding Agent 2" }),
        ).toBeEnabled();
      } else {
        await expect(
          dialog.getByText("Agent 2 is in the channel.", { exact: true }),
        ).toBeVisible();
      }
      await expect(moved ? close : search).toBeFocused();
      await expect(invitations).toHaveCount(0);
    }
  }
  expect(errors).toEqual([]);
});

// Real hit testing cannot be checked in jsdom. Hover the identity, then
// move straight to the visible Add label without locator retries.
test("multiword candidate Add actions stay clickable", async ({ page }) => {
  const { errors } = watchPageErrors(page);
  for (const width of [390, 800, 1280]) {
    for (const index of [1, 3]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`${url}?multiple`);
      await page.getByRole("button", { name: "Access", exact: true }).click();
      const dialog = page.getByRole("dialog", {
        name: "Manage members",
        exact: true,
      });
      await dialog.getByRole("searchbox").fill("Morgan");
      await expect(
        dialog.getByRole("button", { name: /Add Morgan Field Tester/ }),
      ).toHaveCount(3);
      const name = `Morgan Field Tester ${index}`;
      const add = dialog.getByRole("button", {
        name: new RegExp(`Add ${name} `),
      });
      await expect(add).toBeEnabled();
      await animationsSettled(dialog, { subtree: true });
      const identity = dialog.getByRole("button", {
        name: new RegExp(`Open profile for ${name} `),
      });
      await identity.hover({ position: { x: 20, y: 20 } });
      const nameBounds = await identity.boundingBox();
      const addBounds = await add.boundingBox();
      expect(nameBounds.x + nameBounds.width).toBeLessThanOrEqual(addBounds.x);
      expect(
        await dialog.evaluate(
          (element) => element.scrollWidth <= element.clientWidth,
        ),
      ).toBe(true);
      const bounds = await add.getByText("Add", { exact: true }).boundingBox();
      const point = {
        x: bounds.x + bounds.width / 2,
        y: bounds.y + bounds.height / 2,
      };
      await page.mouse.move(point.x, point.y, { steps: 8 });
      expect(
        await add.evaluate(
          (element, { x, y }) =>
            element.contains(document.elementFromPoint(x, y)),
          point,
        ),
      ).toBe(true);
      await page.mouse.click(point.x, point.y);
      await expect
        .poll(() => page.evaluate(() => window.focusFixture.additions.length))
        .toBe(1);
      await page.evaluate(() => window.focusFixture.confirm());
      await expect(
        dialog.getByText(`${name} is in the channel.`, { exact: true }),
      ).toBeVisible();
    }
  }
  expect(errors).toEqual([]);
});

// Browser-only: scrolling moves real rows under a still pointer, and the wheel
// is hit tested through the top layer.
async function opened(popup) {
  await expect(popup).toHaveAttribute("data-open", "");
  await expect(popup).not.toHaveAttribute("data-starting-style");
  await expect
    .poll(() => popup.evaluate((element) => element.getAnimations().length))
    .toBe(0);
}

test("member identity geometry and separate addition focus", async ({
  page,
}) => {
  for (const moved of [false, true]) {
    await page.emulateMedia({
      reducedMotion: moved ? "reduce" : "no-preference",
    });
    await page.goto(url);
    await page.getByRole("button", { name: "Access" }).click();
    const dialog = page.getByRole("dialog", { name: "Manage members" });
    // Baselines read during the entrance translate capture its easing tail.
    await opened(dialog);
    const search = dialog.getByRole("searchbox");
    const memberRow = dialog.getByRole("listitem").first();
    await expect(memberRow).toHaveCSS("min-height", "48px");
    expect((await memberRow.boundingBox()).height).toBe(48);
    // Identities center beside the avatar and stay put on hover and focus.
    // Browser layout/focus—not jsdom—owns these geometry assertions.
    const memberName = memberRow.getByText("Carl (you)", { exact: true });
    const memberAvatar = memberRow.locator("[data-avatar-shape]");
    await search.hover();
    const nameBoundsBeforeReveal = await memberName.boundingBox();
    const rowBoundsBeforeReveal = await memberRow.boundingBox();
    const avatarBoundsBeforeReveal = await memberAvatar.boundingBox();
    expect(
      nameBoundsBeforeReveal.y + nameBoundsBeforeReveal.height / 2,
    ).toBeCloseTo(
      avatarBoundsBeforeReveal.y + avatarBoundsBeforeReveal.height / 2,
      0,
    );
    await memberRow.hover();
    expect(await memberName.boundingBox()).toEqual(nameBoundsBeforeReveal);
    expect(await memberRow.boundingBox()).toEqual(rowBoundsBeforeReveal);
    expect(await memberAvatar.boundingBox()).toEqual(avatarBoundsBeforeReveal);
    await memberRow
      .getByRole("button", { name: /Open profile for Carl/ })
      .focus();
    expect(await memberName.boundingBox()).toEqual(nameBoundsBeforeReveal);
    expect(await memberRow.boundingBox()).toEqual(rowBoundsBeforeReveal);
    await search.fill("Morgan");
    const add = dialog.getByRole("button", { name: /Add Morgan/ });
    await expect(add).toBeEnabled();
    const header = await dialog.locator(".buzz-dialog-header").boundingBox();
    const field = await search.locator("..").boundingBox();
    expect(field.y - header.y - header.height).toBeCloseTo(12, 0);
    await expect(add).toHaveCSS("font-size", "12px");
    expect((await add.boundingBox()).height).toBe(24);
    const members = dialog.getByRole("region", { name: "People", exact: true });
    const others = dialog.getByRole("region", {
      name: "Not in this channel",
      exact: true,
    });
    const list = dialog.getByRole("region", {
      name: "Member list",
      exact: true,
    });
    await expect(members).toHaveCount(0);
    await expect(
      dialog
        .getByRole("region", {
          name: "People not in this channel",
          exact: true,
        })
        .getByRole("heading", { name: "People", exact: true }),
    ).toHaveCSS("position", "sticky");
    // With no roster matches, search results start at the top without an orphan divider.
    await expect(others).toHaveCSS("border-top-width", "0px");
    expect((await others.boundingBox()).y).toBeCloseTo(
      (await list.boundingBox()).y,
      0,
    );
    // Browser-only: an unbadged identity centers beside its avatar and does
    // not shift the avatar, row or Add action on hover or focus.
    const row = add.locator("../..");
    const name = row.getByText("Morgan", { exact: true });
    await search.hover();
    const rowBounds = await row.boundingBox();
    await expect(row).toHaveCSS("min-height", "48px");
    expect(rowBounds.height).toBe(48);
    const avatar = row.locator("[data-avatar-shape]");
    const avatarBounds = await avatar.boundingBox();
    expect(avatarBounds.width).toBe(32);
    expect(avatarBounds.height).toBe(32);
    const nameBounds = await name.boundingBox();
    const identityGap = await name.evaluate((node) =>
      parseFloat(
        getComputedStyle(node.closest("[data-profile-link]")).columnGap,
      ),
    );
    expect(nameBounds.x - avatarBounds.x - avatarBounds.width).toBeCloseTo(
      identityGap,
      0,
    );
    const center = (bounds) => bounds.y + bounds.height / 2;
    expect(center(nameBounds)).toBeCloseTo(center(avatarBounds), 0);
    const addBounds = await add.boundingBox();
    await add.hover();
    await expect(name).toBeVisible();
    expect(await name.boundingBox()).toEqual(nameBounds);
    expect(await add.boundingBox()).toEqual(addBounds);
    expect(await row.boundingBox()).toEqual(rowBounds);
    expect(await avatar.boundingBox()).toEqual(avatarBounds);
    await add.focus();
    await expect(add.getByText("Add", { exact: true })).toBeVisible();
    await page.keyboard.press("Enter");
    await page.evaluate(() => window.focusFixture.published);
    await expect(add).toHaveAttribute("aria-disabled", "true");
    await expect(add).toBeFocused();
    if (moved) await dialog.getByRole("button", { name: "Close" }).focus();
    await page.evaluate(() => window.focusFixture.confirm());
    await expect(dialog.getByText("Morgan is in the channel.")).toBeVisible();
    await expect(
      moved ? dialog.getByRole("button", { name: "Close" }) : search,
    ).toBeFocused();
  }
});

test.describe("touch identity actions", () => {
  test.use({ hasTouch: true, viewport: { width: 390, height: 844 } });
  test("opens profiles from the member menu without hover", async ({
    page,
  }) => {
    await page.goto(url);
    await page.getByRole("button", { name: "Access", exact: true }).tap();
    const dialog = page.getByRole("dialog", {
      name: "Manage members",
      exact: true,
    });
    const actions = dialog.getByRole("button", {
      name: "Actions for Carl",
      exact: true,
    });
    await expect(actions).toBeVisible();
    await actions.tap();
    const menu = page.getByRole("menu", { name: "Actions for Carl" });
    await expect(menu.getByRole("menuitem")).toHaveText(["View profile"]);
    await menu
      .getByRole("menuitem", { name: "View profile", exact: true })
      .tap();
    await expect(dialog).toHaveCount(0);
    expect(await page.evaluate(() => window.focusFixture.additions)).toEqual(
      [],
    );
  });
});

// Browser-only proof: fixed scrollport/search geometry and motion preference
// across the loading-to-content swap; completion-order matrices live in Vitest.
for (const [width, reducedMotion] of [
  [1280, "no-preference"],
  [390, "reduce"],
]) {
  test(`initial member spinner preserves list geometry at ${width}px`, async ({
    page,
  }) => {
    const { errors } = watchPageErrors(page);
    await page.setViewportSize({ width, height: 850 });
    await page.emulateMedia({ reducedMotion });
    await page.goto(`${url}?loading`);
    await page.getByRole("button", { name: "Access" }).click();
    const dialog = page.getByRole("dialog", { name: "Manage members" });
    const list = dialog.getByRole("region", { name: "Member list" });
    const status = list.getByRole("status", { name: "Loading members" });
    const search = dialog.getByRole("searchbox");
    try {
      await expect
        .poll(() => page.evaluate(() => window.focusFixture.namesRequested()))
        .toBe(true);
      await expect(status).toBeVisible();
      await expect(
        list.getByRole("button", { name: /^Open profile for/ }),
      ).toHaveCount(0);
      // Only wait for finite dialog entrance animations, never the loading spin.
      await animationsSettled(dialog, { subtree: true });
      const before = {
        list: await list.boundingBox(),
        search: await search.boundingBox(),
      };
      const spinner = status.locator("svg");
      const circle = await spinner.boundingBox();
      expect(
        Math.abs(
          circle.x + circle.width / 2 - before.list.x - before.list.width / 2,
        ),
      ).toBeLessThan(2);
      await expect(spinner).toHaveCSS(
        "animation-name",
        reducedMotion === "reduce" ? "none" : "spin",
      );
      await expect(
        dialog.getByRole("button", { name: "Refresh member data" }),
      ).toHaveCount(0);
      await page.evaluate(() => window.focusFixture.releaseNames());
      await expect(status).toHaveCount(0);
      await expect(list.getByText("Carl (you)")).toBeVisible();
      expect(await list.boundingBox()).toEqual(before.list);
      expect(await search.boundingBox()).toEqual(before.search);
      await expect(search).toBeFocused();
      expect(errors).toEqual([]);
    } finally {
      await page.evaluate(() => window.focusFixture.releaseNames());
    }
  });
}

// Real pointer sequencing is essential: outside pointerdown used to close the
// manually-opened menu before the ellipsis click immediately reopened it.
test("member menus toggle and dismiss through shared owners", async ({
  page,
}) => {
  const { errors } = watchPageErrors(page);
  await page.goto(url);
  const trigger = page.getByRole("button", { name: "Access" });
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "Manage members" });
  const actions = dialog.getByRole("button", { name: "Actions for Carl" });
  const menu = page.getByRole("menu", { name: "Actions for Carl" });
  await expect(actions).toBeAttached();
  await dialog.getByRole("button", { name: /Open profile for Carl/ }).hover();
  await actions.click();
  await expect(menu).toBeVisible();
  await actions.click();
  await expect(menu).toHaveCount(0);
  await expect(actions).toBeFocused();
  await actions.click();
  await expect(menu).toBeVisible();
  await dialog.getByRole("searchbox").click();
  await expect(menu).toHaveCount(0);
  await expect(dialog).toBeVisible();
  await dialog.getByRole("searchbox").click();
  await expect(dialog.getByRole("searchbox")).toBeFocused();
  await dialog
    .getByRole("button", { name: /Open profile for Carl/ })
    .click({ button: "right" });
  await expect(menu).toBeVisible();
  await expect(menu).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(dialog).toBeVisible();
  const profile = dialog.getByRole("button", { name: /Open profile for Carl/ });
  await expect(profile).toBeFocused();
  for (const key of ["Shift+F10", "ContextMenu"]) {
    await page.keyboard.press(key);
    await expect(menu).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
    await expect(profile).toBeFocused();
  }
  await actions.focus();
  await page.keyboard.press("Enter");
  await expect(menu.getByRole("menuitem").first()).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(actions).toBeFocused();
  await page.mouse.click(8, 8);
  await expect(dialog).toHaveCount(0);
  expect(await page.evaluate(() => window.focusFixture.additions)).toEqual([]);
  expect(errors).toEqual([]);
});

// Native scroll events, portaled focus and final-focus scroll restoration require
// a browser; jsdom cannot establish the row geometry or preserved scroll offset.
test("scrolling members dismisses button and context menus without jumping back", async ({
  page,
}) => {
  const { errors } = watchPageErrors(page);
  await page.goto(`${url}?scroll`);
  await page
    .getByRole("button", { name: "Access", includeHidden: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "Manage members",
    includeHidden: true,
  });
  const list = dialog.getByRole("region", {
    name: "Member list",
    includeHidden: true,
  });
  const actions = dialog.getByRole("button", { name: "Actions for Carl" });
  const profile = dialog.getByRole("button", { name: /Open profile for Carl/ });
  const menu = page.getByRole("menu", { name: "Actions for Carl" });
  await expect(list.getByRole("listitem", { includeHidden: true })).toHaveCount(
    17,
  );
  for (const mode of ["button", "context", "keyboard"]) {
    await list.evaluate((element) => {
      element.scrollTop = 0;
    });
    await expect
      .poll(() => list.evaluate((element) => element.scrollTop))
      .toBe(0);
    await profile.hover();
    if (mode === "button") await actions.click();
    else if (mode === "context") await profile.click({ button: "right" });
    else {
      await profile.focus();
      await page.keyboard.press("Shift+F10");
    }
    await opened(menu);
    // A scroll inside the portaled menu is not a scroll of the member list.
    await menu.dispatchEvent("scroll");
    await expect(menu).toHaveAttribute("data-open", "");
    await list.evaluate(
      (element) =>
        new Promise((resolve) => {
          element.addEventListener("scroll", resolve, { once: true });
          element.scrollTop = 160;
        }),
    );
    await expect(menu).toHaveCount(0);
    await expect(dialog).toBeVisible();
    expect(await list.evaluate((element) => element.scrollTop)).toBe(160);
  }
  expect(await page.evaluate(() => window.focusFixture.additions)).toEqual([]);
  expect(errors).toEqual([]);
});

test("portaled menu focus keeps the identity centered", async ({ page }) => {
  const { errors } = watchPageErrors(page);
  await page.goto(url);
  await page
    .getByRole("button", { name: "Access", includeHidden: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "Manage members",
    includeHidden: true,
  });
  const row = dialog.getByRole("listitem", { includeHidden: true }).first();
  const profile = row.getByRole("button", { name: /Open profile for Carl/ });
  const actions = row.getByRole("button", { name: "Actions for Carl" });
  const search = dialog.getByRole("searchbox", { includeHidden: true });
  const menu = page.getByRole("menu", { name: "Actions for Carl" });
  await expect(profile).toBeVisible();
  for (const mode of ["button", "context", "keyboard"]) {
    await profile.hover();
    if (mode === "button") await actions.click();
    else if (mode === "context") await profile.click({ button: "right" });
    else {
      await profile.focus();
      await page.keyboard.press("Shift+F10");
    }
    await opened(menu);
    await menu.getByRole("menuitem").first().focus();
    await search.hover();
    const nameBounds = await row
      .getByText("Carl (you)", { exact: true })
      .boundingBox();
    const avatarBounds = await row.locator("[data-avatar-shape]").boundingBox();
    expect(nameBounds.y + nameBounds.height / 2).toBeCloseTo(
      avatarBounds.y + avatarBounds.height / 2,
      0,
    );
    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
    await search.focus();
    await profile.focus();
    await search.focus();
  }
  expect(errors).toEqual([]);
});

// Explicit 60-agent workload: owner verification is real CPU work that does not
// appear in small, unsigned profile fixtures. Count observation and row work too.
// This does not measure live relay latency.
test("member search reuses unchanged rows and owner observations", async ({
  page,
}, testInfo) => {
  const { errors } = watchPageErrors(page);
  await page.goto(`${url}?search-scale`);
  await page.evaluate(() => {
    window.ownerChecks = 0;
    const digest = crypto.subtle.digest.bind(crypto.subtle);
    crypto.subtle.digest = (algorithm, data) => {
      if (new TextDecoder().decode(data).startsWith("nostr:agent-auth:"))
        window.ownerChecks++;
      return digest(algorithm, data);
    };
  });
  await page.getByRole("button", { name: "Access" }).click();
  const dialog = page.getByRole("dialog", { name: "Manage members" });
  const search = dialog.getByRole("searchbox");
  const data = dialog.getByRole("region", { name: "Member list" });
  await dialog.getByRole("tab", { name: "Agents · 60" }).click();
  await expect(
    dialog.getByRole("button", { name: /^Open owner profile:/ }),
  ).toHaveCount(50);
  await expect(data).toHaveAttribute("data-refreshing", "false");
  await expect(
    dialog
      .getByRole("navigation", { name: "Agents member pages" })
      .getByText("1 of 2"),
  ).toBeVisible();
  const before = await page.evaluate(() => window.ownerChecks);
  const workBefore = await page.evaluate(() => ({
    ...window.focusFixture.searchWork,
  }));
  // Same roster and labels: a query-only update must not rerender avatar/menu trees.
  await search.fill("Agent");
  await expect(data).toHaveAttribute("data-refreshing", "false");
  await expect(
    dialog.getByRole("button", { name: /^Open owner profile:/ }),
  ).toHaveCount(50);
  expect(await page.evaluate(() => window.focusFixture.searchWork.images)).toBe(
    workBefore.images,
  );
  await search.fill("");
  await expect(data).toHaveAttribute("data-refreshing", "false");
  await expect(
    dialog.getByRole("button", { name: /^Open owner profile:/ }),
  ).toHaveCount(50);
  await page.evaluate(() => {
    window.searchFrames = [];
    window.searchSample = true;
    let previous = performance.now();
    const frame = (now) => {
      window.searchFrames.push(now - previous);
      previous = now;
      if (window.searchSample) requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  });
  for (const query of ["Agent", "Agent 1", "Agent", "Agent 2", ""]) {
    await search.fill(query);
    await expect(data).toHaveAttribute("data-refreshing", "false");
    await expect(
      dialog.getByRole("button", { name: /^Open owner profile:/ }),
    ).toHaveCount(query === "Agent 1" || query === "Agent 2" ? 11 : 50);
  }
  const sample = await page.evaluate(() => {
    window.searchSample = false;
    return {
      searchWork: window.focusFixture.searchWork,
      ownerChecks: window.ownerChecks,
      maxFrame: Math.max(...window.searchFrames),
      longFrames: window.searchFrames.filter((ms) => ms > 50).length,
    };
  });
  await testInfo.attach("search-work.json", {
    body: JSON.stringify({ before, ...sample }),
    contentType: "application/json",
  });
  console.log("MEMBER_SEARCH_WORK", testInfo.project.name, {
    before,
    ...sample,
  });
  expect(sample.ownerChecks).toBe(before);
  expect(sample.searchWork.observations).toBe(workBefore.observations);
  expect(errors).toEqual([]);
});

// The live React profile mounted 240 invitation rows on the first letter. This
// workload must keep render/effect work bounded, not only repeated verification.
test("large known-agent searches mount only the first invitation page", async ({
  page,
}, testInfo) => {
  const { errors } = watchPageErrors(page);
  await page.goto(`${url}?invitation-scale`);
  await page.getByRole("button", { name: "Access" }).click();
  const dialog = page.getByRole("dialog", { name: "Manage members" });
  const search = dialog.getByRole("searchbox");
  const data = dialog.getByRole("region", { name: "Member list" });
  await expect(data).toHaveAttribute("data-refreshing", "false");
  await page.evaluate(() => {
    window.searchFrames = [];
    window.searchSample = true;
    let previous = performance.now();
    const frame = (now) => {
      window.searchFrames.push(now - previous);
      previous = now;
      if (window.searchSample) requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  });
  const counts = [];
  for (const query of ["h", "he", "hel", "hell", "hello", ""]) {
    await search.fill(query);
    await expect(data).toHaveAttribute("data-refreshing", "false");
    counts.push(await dialog.getByRole("button", { name: /^Add / }).count());
  }
  const sample = await page.evaluate(() => {
    window.searchSample = false;
    return {
      maxFrame: Math.max(...window.searchFrames),
      longFrames: window.searchFrames.filter((ms) => ms > 50).length,
    };
  });
  console.log("MEMBER_INVITATION_WORK", testInfo.project.name, {
    counts,
    ...sample,
  });
  await testInfo.attach("invitation-work.json", {
    body: JSON.stringify({ counts, ...sample }),
    contentType: "application/json",
  });
  expect(counts.slice(0, 3)).toEqual([4, 4, 4]);
  // A random npub may contain "hell"; it cannot contain "hello" (no o in bech32).
  expect(counts[3]).toBeLessThanOrEqual(4);
  expect(counts.slice(4)).toEqual([0, 0]);
  await search.fill("helper");
  await expect(data).toHaveAttribute("data-refreshing", "false");
  const more = dialog
    .getByRole("region", { name: "Your other agents", exact: true })
    .getByRole("button", { name: "Show more", exact: true });
  for (let count = 8; count <= 240; count += 4) {
    await more.click();
    await expect(
      dialog.getByRole("button", { name: /^Add Helper/ }),
    ).toHaveCount(count);
  }
  await expect(more).toHaveCount(0);
  expect(await page.evaluate(() => window.focusFixture.additions)).toEqual([]);
  expect(errors).toEqual([]);
});

// Browser-only: removing a focused button interacts with the native dialog focus
// trap differently in Chromium and WebKit; jsdom cannot establish the handoff.
test("final invitation expansion continues keyboard focus at the first new row", async ({
  page,
}) => {
  const { errors } = watchPageErrors(page);
  for (const activation of ["Enter", "Space", "pointer"]) {
    await page.goto(`${url}?invitation-focus`);
    await page.getByRole("button", { name: "Access" }).click();
    const dialog = page.getByRole("dialog", { name: "Manage members" });
    await dialog.getByRole("searchbox").fill("Helper");
    // Late search results can move Show more between pointer down and up.
    await expect(
      dialog.getByRole("region", { name: "Member list" }),
    ).toHaveAttribute("data-refreshing", "false");
    const group = dialog.getByRole("region", {
      name: "Your other agents",
      exact: true,
    });
    const more = group.getByRole("button", { name: "Show more", exact: true });
    await expect(
      group.getByRole("button", { name: /^Add Helper/ }),
    ).toHaveCount(4);
    await more.focus();
    await page.keyboard.press("Enter");
    await expect(
      group.getByRole("button", { name: /^Add Helper/ }),
    ).toHaveCount(8);
    await expect(more).toBeFocused();
    if (activation === "pointer") await more.click();
    else await page.keyboard.press(activation);
    await expect(
      group.getByRole("button", { name: /^Add Helper/ }),
    ).toHaveCount(10);
    await expect(more).toHaveCount(0);
    const firstNew = group.getByRole("button", {
      name: /^Open profile for Helper 009/,
    });
    if (activation === "pointer") await expect(firstNew).not.toBeFocused();
    else {
      await expect(firstNew).toBeFocused();
      await page.keyboard.press("Tab");
      await expect(
        group.getByRole("button", { name: /^Add Helper 009/ }),
      ).toBeFocused();
    }
  }
  expect(await page.evaluate(() => window.focusFixture.additions)).toEqual([]);
  expect(errors).toEqual([]);
});

// Native roving tab focus and modal tab order need a real browser.
test("member tabs support arrow keys, activation and paging focus", async ({
  page,
}) => {
  await page.goto(`${url}?administration&search-scale&editable-access`);
  await page.getByRole("button", { name: "Access", exact: true }).click();
  const dialog = page.getByRole("dialog", {
    name: "Manage members",
    exact: true,
  });
  const list = dialog.getByRole("region", { name: "Member list" });
  await expect(list).toHaveAttribute("data-refreshing", "false");
  const search = dialog.getByRole("searchbox");
  const filter = dialog.getByRole("button", { name: "Filter members: All" });
  const people = dialog.getByRole("tab", { name: "People · 2" });
  const agents = dialog.getByRole("tab", { name: "Agents · 60" });
  await search.focus();
  await page.keyboard.press("Tab");
  await expect(filter).toBeFocused();
  await page.keyboard.press("Tab");
  const general = dialog.getByRole("combobox", {
    name: "General access",
    exact: true,
  });
  await expect(general).toBeEnabled();
  await expect(general).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(people).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await expect(agents).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(agents).toHaveAttribute("aria-selected", "true");
  const panel = dialog.getByRole("tabpanel", { name: "Agents · 60" });
  await expect(agents).toHaveAttribute(
    "aria-controls",
    await panel.getAttribute("id"),
  );
  await page.keyboard.press("Tab");
  await expect(
    panel.getByRole("button", { name: /^Open profile for / }).first(),
  ).toBeFocused();
  const pages = panel.getByRole("navigation", { name: "Agents member pages" });
  await pages.getByRole("button", { name: "Next", exact: true }).click();
  await expect(panel).toBeFocused();
  await expect(pages.getByText("2 of 2")).toBeVisible();
  await people.click();
  await agents.click();
  await expect(pages.getByText("2 of 2")).toBeVisible();
  await agents.focus();
  await page.keyboard.press("ArrowLeft");
  await expect(people).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(people).toHaveAttribute("aria-selected", "true");
});

// A late archive snapshot unmounts a focused row in the native focus trap.
test("late archives return focus to the selected member tab", async ({
  page,
}) => {
  await page.goto(`${url}?administration&late-archives`);
  await page.getByRole("button", { name: "Access", exact: true }).click();
  const dialog = page.getByRole("dialog", {
    name: "Manage members",
    exact: true,
  });
  const actions = dialog.getByRole("button", {
    name: "Actions for Morgan",
    exact: true,
  });
  await actions.focus();
  await page.evaluate(() => window.focusFixture.releaseArchives());
  await expect(dialog.getByRole("tab", { name: "Archived · 1" })).toBeVisible();
  await expect(actions).toHaveCount(0);
  await expect(dialog.getByRole("tab", { name: "People · 1" })).toBeFocused();
});

// The same live dialog node must retain its focus trap while visual steps exit;
// jsdom cannot prove crossfade hit testing, geometry or error placement.
for (const rejected of [false, true]) {
  test(`member confirmation replaces one modal and reports only errors (rejected: ${rejected})`, async ({
    page,
  }, testInfo) => {
    const { errors } = watchPageErrors(page);
    await page.goto(
      `${url}?administration${rejected ? "&reject-removal" : ""}`,
    );
    await page.getByRole("button", { name: "Access", exact: true }).click();
    const members = page.getByRole("dialog", {
      name: "Manage members",
      exact: true,
    });
    const popupId = await members.getAttribute("id");
    const search = members.getByRole("searchbox");
    await search.fill("Morgan");
    const choose = async () => {
      await expect(members.locator(".buzz-dialog-step")).toHaveCount(1);
      await members
        .getByRole("button", { name: /Open profile for Morgan/ })
        .hover();
      await members
        .getByRole("button", { name: "Actions for Morgan", exact: true })
        .click();
      await page
        .getByRole("menuitem", { name: "Remove from channel", exact: true })
        .click();
      const confirmation = page.getByRole("dialog", {
        name: "Remove member from channel",
        exact: true,
      });
      await expect(confirmation).toHaveAttribute("id", popupId);
      await expect(
        page.locator('[role="dialog"][aria-modal="true"]'),
      ).toHaveCount(1);
      await expect(page.locator(".buzz-dialog-backdrop")).toHaveCount(1);
      await expect(confirmation.getByRole("searchbox")).toHaveCount(0);
      await expect(
        confirmation.getByRole("button", { name: "Cancel", exact: true }),
      ).toBeFocused();
      // Exit completes without leaving invisible hit targets over the new step.
      await expect(confirmation.locator(".buzz-dialog-step")).toHaveCount(1);
      return confirmation;
    };
    // Dismissal and confirmation layout are independent of the relay outcome.
    if (!rejected) {
      for (const dismiss of [
        "Cancel",
        "Back to members",
        "Escape",
        "outside",
      ]) {
        const confirmation = await choose();
        if (dismiss === "Escape") await page.keyboard.press("Escape");
        else if (dismiss === "outside") await page.mouse.click(4, 4);
        else
          await confirmation
            .getByRole("button", { name: dismiss, exact: true })
            .click();
        await expect(search).toHaveValue("Morgan");
        await expect(
          members.getByRole("button", {
            name: "Actions for Morgan",
            exact: true,
          }),
        ).toBeFocused();
        await expect(members).toHaveAttribute("id", popupId);
      }
    }
    const confirmation = await choose();
    if (!rejected) {
      for (const mode of ["light", "dark"]) {
        await page.evaluate((mode) => {
          document.documentElement.classList.toggle("dark", mode === "dark");
          document.documentElement.setAttribute("data-color-mode", mode);
        }, mode);
        for (const width of [390, 800, 1280]) {
          await page.setViewportSize({ width, height: 900 });
          await expect(confirmation).toBeInViewport({ ratio: 1 });
          // WebKit rounds an inner scrollport's IntersectionObserver ratio below
          // one for fractional button widths. Check the actual viewport bounds.
          const actionBounds = await confirmation
            .getByRole("button", { name: "Remove member", exact: true })
            .boundingBox();
          expect(actionBounds.x).toBeGreaterThanOrEqual(0);
          expect(actionBounds.x + actionBounds.width).toBeLessThanOrEqual(
            width,
          );
          expect(actionBounds.y).toBeGreaterThanOrEqual(0);
          expect(actionBounds.y + actionBounds.height).toBeLessThanOrEqual(900);
          await confirmation.screenshot({
            path: testInfo.outputPath(`confirmation-${mode}-${width}.png`),
          });
        }
      }
    }
    await confirmation
      .getByRole("button", { name: "Remove member", exact: true })
      .click();
    await page.evaluate(() => window.focusFixture.published);
    // The member keeps focus while the removal is pending.
    const morganActions = members.getByRole("button", {
      name: "Actions for Morgan",
      exact: true,
    });
    await expect(morganActions).toBeFocused();
    await expect(
      members.getByRole("button", { name: /Open profile for Morgan/ }),
    ).toBeVisible();
    await expect(
      members.getByText(/Checking permissions and waiting/),
    ).toHaveCount(0);
    await expect(members.getByRole("alert")).toHaveCount(0);
    await page.evaluate(() => window.focusFixture.confirm());
    if (rejected) {
      const error = members
        .getByRole("alert")
        .filter({ hasText: "Permission changed" });
      await expect(error).toBeVisible();
      await expect(morganActions).toBeFocused();
      await expect(
        members
          .getByRole("region", { name: "Member list" })
          .getByText("Permission changed"),
      ).toHaveCount(0);
      await expect(page.locator(".buzz-toast")).toHaveCount(0);
      await expect(
        members.getByRole("button", { name: /Open profile for Morgan/ }),
      ).toBeVisible();
      const errorBox = await error.boundingBox();
      const listBox = await members
        .getByRole("region", { name: "Member list" })
        .boundingBox();
      expect(errorBox.y + errorBox.height).toBeLessThanOrEqual(listBox.y);
      for (const mode of ["light", "dark"]) {
        await page.evaluate((mode) => {
          document.documentElement.classList.toggle("dark", mode === "dark");
          document.documentElement.setAttribute("data-color-mode", mode);
        }, mode);
        for (const width of [390, 800, 1280]) {
          await page.setViewportSize({ width, height: 900 });
          await expect(error).toBeInViewport({ ratio: 1 });
          await members.screenshot({
            path: testInfo.outputPath(`error-${mode}-${width}.png`),
          });
        }
      }
    } else {
      await expect(
        members
          .getByRole("region", { name: "People", exact: true })
          .getByRole("button", { name: /Open profile for Morgan/ }),
      ).toHaveCount(0);
      // No member is left in the filtered list.
      await expect(search).toBeFocused();
      await expect(page.locator(".buzz-toast")).toHaveCount(0);
      await expect(members.getByRole("alert")).toHaveCount(0);
    }
    await expect(members.getByText("Member change confirmed.")).toHaveCount(0);
    expect(errors).toEqual([]);
  });
}

// The step replaces the list: only a browser shows where the returning list
// paints its rows, and whether a shortened list keeps the focused row inside.
for (const rejected of [false, true]) {
  test(`a member change returns to its place on a later page (rejected: ${rejected})`, async ({
    page,
  }) => {
    const { errors } = watchPageErrors(page);
    await page.goto(
      `${url}?administration&search-scale${rejected ? "&reject-removal" : ""}`,
    );
    await page.getByRole("button", { name: "Access", exact: true }).click();
    const members = page.getByRole("dialog", {
      name: "Manage members",
      exact: true,
    });
    const list = members.getByRole("region", { name: "Member list" });
    await expect(list).toHaveAttribute("data-refreshing", "false");
    await members.getByRole("tab", { name: /^Agents ·/ }).click();
    const pages = list.getByRole("navigation", { name: "Agents member pages" });
    await pages.getByRole("button", { name: "Next", exact: true }).click();
    await expect(pages.getByText("2 of 2")).toBeVisible();
    const agents = list
      .getByRole("tabpanel", { name: /^Agents ·/ })
      .getByRole("button", { name: /^Actions for / });
    await expect(agents).toHaveCount(10);
    // The last row sits where an error above the list would clip it.
    const [previous, target] = await agents.evaluateAll((buttons) =>
      buttons.slice(-2).map((button) => button.getAttribute("aria-label")),
    );
    const targetActions = members.getByRole("button", {
      name: target,
      exact: true,
    });
    await page.evaluate(() => {
      // The shown list's offset and a row's top within it. The entering step
      // is scaled, so the top is measured in the list's own layout.
      window.listPlace = (name) => {
        const list = document.querySelector(
          '.buzz-dialog-step:not([aria-hidden]) [aria-label="Member list"]',
        );
        const row = list
          ?.querySelector(`[aria-label="${name}"]`)
          ?.closest("li");
        if (!list || !row) return undefined;
        const box = list.getBoundingClientRect();
        return {
          scrollTop: list.scrollTop,
          top:
            (row.getBoundingClientRect().top - box.top) /
            (box.height / list.offsetHeight),
        };
      };
    });
    const offset = await list.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
      return element.scrollTop;
    });
    expect(offset).toBeGreaterThan(0);
    const place = await page.evaluate((name) => window.listPlace(name), target);
    expect(place.scrollTop).toBe(offset);
    const leave = async (item, action) => {
      await expect(members.locator(".buzz-dialog-step")).toHaveCount(1);
      await targetActions.click();
      await page
        .getByRole(item === "Viewing only" ? "menuitemradio" : "menuitem", {
          name: item,
          exact: true,
        })
        .click();
      const confirmation = page.getByRole("dialog", {
        name:
          item === "Viewing only"
            ? "Change access to Viewing only?"
            : "Remove agent from channel",
        exact: true,
      });
      // Enter confirms a reversible change; a removal starts on Cancel.
      await expect(
        confirmation.getByRole("button", {
          name: item === "Viewing only" ? "Set to viewing only" : "Cancel",
          exact: true,
        }),
      ).toBeFocused();
      await expect(confirmation.locator(".buzz-dialog-step")).toHaveCount(1);
      // Sample every frame from before the step leaves until it has gone.
      await page.evaluate((name) => {
        window.listFrames = [];
        window.sampling = true;
        const sample = () => {
          const shown = window.listPlace(name);
          if (shown) window.listFrames.push(shown);
          if (window.sampling) requestAnimationFrame(sample);
        };
        requestAnimationFrame(sample);
      }, target);
      await confirmation
        .getByRole("button", { name: action, exact: true })
        .click();
      await expect(targetActions).toBeFocused();
      await expect(members.locator(".buzz-dialog-step")).toHaveCount(1);
      const frames = await page.evaluate(() => {
        window.sampling = false;
        return window.listFrames;
      });
      expect(frames.length).toBeGreaterThan(0);
      for (const frame of frames) {
        expect(frame.scrollTop).toBe(offset);
        // Sub-pixel: the scale divides out of a transformed rectangle.
        expect(frame.top).toBeCloseTo(place.top, 0);
      }
      await expect(pages.getByText("2 of 2")).toBeVisible();
    };
    await leave("Viewing only", "Cancel");
    // A removal keeps focus on its member until the row leaves.
    await leave("Remove from channel", "Remove agent");
    await page.evaluate(() => window.focusFixture.published);
    await page.evaluate(() => window.focusFixture.confirm());
    if (rejected) {
      await expect(
        members.getByRole("alert").filter({ hasText: "Permission changed" }),
      ).toBeVisible();
      await expect(targetActions).toBeFocused();
      // The error above the list shortens it; the member's row stays inside.
      const listBox = await list.boundingBox();
      const focusedBox = await targetActions.boundingBox();
      expect(focusedBox.y).toBeGreaterThanOrEqual(listBox.y);
      expect(focusedBox.y + focusedBox.height).toBeLessThanOrEqual(
        listBox.y + listBox.height,
      );
    } else {
      await expect(targetActions).toHaveCount(0);
      await expect(agents).toHaveCount(9);
      // The member was last, so the one before it takes focus.
      await expect(
        members.getByRole("button", { name: previous, exact: true }),
      ).toBeFocused();
      // The shorter list keeps its offset, or clamps it to its new end.
      const after = await list.evaluate((element) => ({
        scrollTop: element.scrollTop,
        end: element.scrollHeight - element.clientHeight,
      }));
      expect(after.scrollTop).toBe(Math.min(offset, after.end));
      await expect(members.getByRole("alert")).toHaveCount(0);
    }
    expect(errors).toEqual([]);
  });
}

// Paging is a browser layout: removing the only member on the last page
// moves the list back a page, where the member before it takes focus.
test("removing the last page's only member focuses the member before it", async ({
  page,
}) => {
  const { errors } = watchPageErrors(page);
  await page.goto(`${url}?administration&last-page-alone`);
  await page.getByRole("button", { name: "Access", exact: true }).click();
  const members = page.getByRole("dialog", {
    name: "Manage members",
    exact: true,
  });
  const list = members.getByRole("region", { name: "Member list" });
  await expect(list).toHaveAttribute("data-refreshing", "false");
  await members.getByRole("tab", { name: /^Agents ·/ }).click();
  const pages = list.getByRole("navigation", { name: "Agents member pages" });
  const agents = list
    .getByRole("tabpanel", { name: /^Agents ·/ })
    .getByRole("button", { name: /^Actions for / });
  await expect(agents).toHaveCount(50);
  const previous = await agents.last().getAttribute("aria-label");
  await pages.getByRole("button", { name: "Next", exact: true }).click();
  await expect(pages.getByText("2 of 2")).toBeVisible();
  await expect(agents).toHaveCount(1);
  const target = await agents.first().getAttribute("aria-label");
  await members.getByRole("button", { name: target, exact: true }).click();
  await page
    .getByRole("menuitem", { name: "Remove from channel", exact: true })
    .click();
  await page
    .getByRole("dialog", { name: "Remove agent from channel", exact: true })
    .getByRole("button", { name: "Remove agent", exact: true })
    .click();
  await page.evaluate(() => window.focusFixture.published);
  await page.evaluate(() => window.focusFixture.confirm());
  await expect(
    members.getByRole("button", { name: target, exact: true }),
  ).toHaveCount(0);
  await expect(agents).toHaveCount(50);
  await expect(
    members.getByRole("button", { name: previous, exact: true }),
  ).toBeFocused();
  expect(errors).toEqual([]);
});

// Native disabling/focus trapping differs from jsdom, especially in Chromium.
test("plugin additions retain Search focus unless it was deliberately moved", async ({
  page,
}) => {
  for (const action of ["pointer", "retry", "moved", "enter"]) {
    await test.step(action, async () => {
      await page.goto(`${url}?plugin`);
      await page.getByRole("button", { name: "Access", exact: true }).click();
      const dialog = page.getByRole("dialog", {
        name: "Manage members",
        exact: true,
      });
      const search = dialog.getByRole("searchbox");
      await search.fill("Morgan");
      const add = dialog.getByRole("button", { name: /^Add Morgan \(.*\)$/ });
      await expect(add).toBeEnabled();
      if (action === "enter") await search.press("Enter");
      else await add.click();
      await page.evaluate(() => window.focusFixture.published);
      await expect(add).toBeDisabled();
      await expect(search).toBeFocused();
      let attempt = 0;
      if (action === "retry") {
        await page.evaluate(() => window.focusFixture.settleAddition(0, true));
        await expect(
          dialog.getByText("Addition rejected", { exact: true }),
        ).toBeVisible();
        await expect(add).toBeEnabled();
        await add.click();
        await expect
          .poll(() => page.evaluate(() => window.focusFixture.additions.length))
          .toBe(2);
        attempt = 1;
      }
      // Search remains editable during the write; changing its focus is intentional.
      const moved = dialog.getByRole("button", {
        name: "Copy link",
        exact: true,
      });
      if (action === "moved") {
        await moved.focus();
        await expect(moved).toBeFocused();
      }
      await page.evaluate(
        (index) => window.focusFixture.settleAddition(index),
        attempt,
      );
      await expect(search).toHaveValue("");
      await expect(action === "moved" ? moved : search).toBeFocused();
      await expect(
        dialog.getByText("Morgan added.", { exact: true }),
      ).toHaveAttribute("role", "status");
    });
  }
});

// Browser-only: native focus and rendered add/roster geometry after membership confirmation.
test("Solo adds an agent with pointer or Enter and retains the search focus", async ({
  page,
}, testInfo) => {
  for (const [mode, width, keyboard] of [
    ["light", 1280, false],
    ["dark", 390, true],
  ]) {
    await page.setViewportSize({ width, height: 832 });
    await page.goto(`${url}?solo`);
    await page.evaluate(
      (mode) => document.documentElement.setAttribute("data-color-mode", mode),
      mode,
    );
    await page.getByRole("button", { name: "Access" }).click();
    const dialog = page.getByRole("dialog", {
      name: "Share access",
      exact: true,
    });
    const search = dialog.getByRole("searchbox", {
      name: "Search people, agents and channels",
    });
    await expect(search).toBeFocused();
    await expect(search).toHaveAccessibleDescription("");
    const add = dialog.getByRole("button", { name: /Add Morgan/ });
    await expect(add).toHaveCount(0);
    await expect(dialog).toHaveAccessibleDescription("");
    await search.fill("Morgan");
    await expect(add).toBeEnabled();
    await expect(
      dialog.getByRole("region", { name: "People", exact: true }),
    ).toHaveCount(0);
    await expect(dialog.locator("mark")).toHaveCount(0);
    const neutralFill = await add.locator("../..").evaluate((row) => {
      const sample = document.createElement("span");
      sample.style.backgroundColor = "var(--affordance-subtle)";
      row.append(sample);
      const color = getComputedStyle(sample).backgroundColor;
      sample.remove();
      return color;
    });
    await expect(add.locator("../..")).toHaveCSS(
      "background-color",
      neutralFill,
    );
    await dialog.screenshot({
      path: testInfo.outputPath(`solo-add-${mode}.png`),
    });
    if (keyboard) {
      await search.fill("Morgan");
      await search.press("Enter");
    } else await add.click();
    await expect(add).toHaveAttribute("aria-disabled", "true");
    await expect
      .poll(() => page.evaluate(() => window.focusFixture.additions.length))
      .toBe(1);
    await page.evaluate(() => window.focusFixture.confirm());
    await expect(
      dialog.getByText("Morgan added.", { exact: true }),
    ).toHaveClass("sr-only");
    await expect(search).toHaveValue("");
    await expect(
      dialog.getByRole("tabpanel", { name: "People · 1" }),
    ).toContainText("Carl");
    await expect(search).toBeFocused();
    await dialog.getByRole("tab", { name: "Agents · 1" }).click();
    await expect(
      dialog.getByRole("tabpanel", { name: "Agents · 1" }),
    ).toContainText("Morgan");
    await expect(add).toHaveCount(0);
    expect(
      await dialog.evaluate((node) => node.scrollWidth <= node.clientWidth),
    ).toBe(true);
  }
});
