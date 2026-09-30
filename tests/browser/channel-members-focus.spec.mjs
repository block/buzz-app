import { expect, test } from "@playwright/test";
import { preview } from "vite";
import { build } from "vite";
import react from "@vitejs/plugin-react";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { watchPageErrors } from "./page-errors.mjs";

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
test("identity copy preserves modal focus and addition returns focus only to its owner", async ({
  page,
}, testInfo) => {
  const { errors } = watchPageErrors(page);
  for (const moved of [false, true]) {
    await page.goto(url);
    await page.getByRole("button", { name: "Channel members" }).click();
    const dialog = page.getByRole("dialog", { name: "Channel members" });
    const search = dialog.getByRole("searchbox");
    await search.fill("Morgan");
    const add = dialog.getByRole("button", { name: /Add Morgan/ });
    await expect(add).toBeEnabled();
    const identity = dialog.getByRole("button", {
      name: /Open profile for Morgan/,
    });
    if (!moved) {
      await dialog.evaluate(async (element) => {
        await Promise.all(
          element.getAnimations({ subtree: true }).map((a) => a.finished),
        );
      });
      await expect(add).not.toBeFocused();
      const before = await add.boundingBox();
      await identity.hover({ position: { x: 20, y: 20 } });
      const card = page.getByRole("dialog", {
        name: "Morgan identity",
        exact: true,
      });
      await expect(card).toBeVisible();
      const npub = await identity.getAttribute("title");
      await expect(card).toContainText(npub);
      await expect(card.getByText("Public key", { exact: true })).toHaveCount(
        0,
      );
      expect(await add.boundingBox()).toEqual(before);
      const copy = card.getByRole("button", {
        name: "Copy npub",
        exact: true,
      });
      // Hit testing proves the positioned portal is above the modal/backdrop.
      await copy.click();
      await expect
        .poll(() => page.evaluate(() => window.copiedNpubs))
        .toEqual([npub]);
      await expect(add).toBeEnabled();
      // Pointer entry has not focused Add: Escape must find the row control.
      await expect(copy).toBeFocused();
      await page.keyboard.press("Escape");
      await expect(card).not.toBeVisible();
      await expect(dialog).toBeVisible();
      await expect(identity).toBeFocused();
      await page.mouse.move(0, 0);
      await search.focus();
      await expect(card).not.toBeVisible();
      // Hold the hover/focus delay: rapid Tab must not require a pause.
      await page.clock.install({ time: new Date("2026-01-01T00:00:00Z") });
      await page.clock.pauseAt(new Date("2026-01-01T00:00:01Z"));
      try {
        await page.keyboard.press("Tab");
        await page.keyboard.press("Tab");
        await expect(copy).toBeFocused();
      } finally {
        await page.clock.resume();
      }
      await expect(card).toBeVisible();
      await expect(identity).toHaveAttribute(
        "aria-details",
        await card.getAttribute("id"),
      );
      await expect(identity).toHaveAccessibleDescription(
        /Tab to reach Copy npub/,
      );
      await expect(identity).not.toHaveAttribute("aria-haspopup");
      await page.keyboard.press("Enter");
      await expect
        .poll(() => page.evaluate(() => window.copiedNpubs))
        .toEqual([npub, npub]);
      await page.keyboard.press("Shift+Tab");
      await expect(identity).toBeFocused();
      await page.keyboard.press("Tab");
      await expect(copy).toBeFocused();
      await page.keyboard.press("Tab");
      await expect(add).toBeFocused();
      await expect(card).not.toBeVisible();
      await page.keyboard.press("Shift+Tab");
      await expect(identity).toBeFocused();
      await expect(card).toBeVisible();
      await page.keyboard.press("Tab");
      await expect(copy).toBeFocused();
      await page.keyboard.press("Escape");
      await expect(card).not.toBeVisible();
      await expect(dialog).toBeVisible();
      await expect(identity).toBeFocused();
      await expect(identity).not.toHaveAttribute("aria-details");
      await page.keyboard.press("Tab");
      await expect(add).toBeFocused();
    }
    await add.focus();
    await page.keyboard.press("Enter");
    await page.evaluate(() => window.focusFixture.published);
    await expect(add).toHaveAttribute("aria-disabled", "true");
    await expect(add).toBeFocused();
    if (moved)
      await dialog
        .getByRole("button", { name: "Close channel members" })
        .focus();
    await page.evaluate(() => window.focusFixture.confirm());
    await expect(dialog.getByText("Morgan is in the channel.")).toBeVisible();
    await expect(
      moved
        ? dialog.getByRole("button", { name: "Close channel members" })
        : search,
    ).toBeFocused();
  }
  await page.goto(url);
  await page.getByRole("button", { name: "Edit team", exact: true }).click();
  const team = page.getByRole("dialog", { name: "Team", exact: true });
  const checkbox = team.getByRole("checkbox", { name: /Morgan/ });
  const card = page.getByRole("dialog", {
    name: "Morgan identity",
    exact: true,
  });
  // No prior checkbox focus: the wrapper itself cannot receive focus.
  await expect(checkbox).not.toBeFocused();
  await checkbox.hover();
  await expect(card).toBeVisible();
  const copy = card.getByRole("button", { name: "Copy npub", exact: true });
  await copy.click();
  await expect(copy).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(card).not.toBeVisible();
  await expect(team).toBeVisible();
  await expect(checkbox).toBeFocused();
  await expect(checkbox).not.toBeChecked();
  await page.mouse.move(0, 0);
  await team.getByRole("textbox").focus();
  for (const mode of ["light", "dark"]) {
    await page.evaluate((mode) => {
      document.documentElement.className = mode;
      document.documentElement.dataset.colorMode = mode;
    }, mode);
    for (const width of [390, 800, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      await checkbox.hover();
      await expect(card).toBeVisible();
      await expect(card).toContainText("Owner unavailable");
      await card.evaluate(async (element) => {
        await Promise.all(element.getAnimations().map((a) => a.finished));
      });
      const bounds = await card.boundingBox();
      expect(bounds.x).toBeGreaterThanOrEqual(0);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
      await page.screenshot({
        path: testInfo.outputPath(`identity-${mode}-${width}.png`),
      });
      await page.mouse.move(0, 0);
      await team.getByRole("textbox").focus();
      await expect(card).not.toBeVisible();
    }
  }
  await team.getByRole("textbox").focus();
  await page.clock.pauseAt(new Date("2026-01-01T01:00:00Z"));
  try {
    await page.keyboard.press("Tab");
    await page.keyboard.press("Tab");
    await expect(card.getByRole("button", { name: "Copy npub" })).toBeFocused();
  } finally {
    await page.clock.resume();
  }
  await expect(checkbox).toHaveAccessibleDescription(/Tab to reach Copy npub/);
  await expect(checkbox).toHaveAttribute(
    "aria-details",
    await card.getAttribute("id"),
  );
  await expect(checkbox).not.toHaveAttribute("aria-haspopup");
  await page.keyboard.press("Escape");
  await expect(card).not.toBeVisible();
  await expect(checkbox).toBeFocused();
  await page.keyboard.press("Space");
  await expect(checkbox).toBeChecked();
  expect(errors).toEqual([]);
});

// Real hit testing and portal geometry cannot be checked in jsdom. Hover the
// name first, then move straight to the visible Add label without locator retries.
test("identity previews leave multiword candidate Add actions clickable", async ({
  page,
}) => {
  const { errors } = watchPageErrors(page);
  for (const width of [390, 800, 1280]) {
    for (const index of [1, 3]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`${url}?multiple`);
      await page
        .getByRole("button", { name: "Channel members", exact: true })
        .click();
      const dialog = page.getByRole("dialog", {
        name: "Channel members",
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
      await dialog.evaluate(async (element) => {
        await Promise.all(
          element.getAnimations({ subtree: true }).map((a) => a.finished),
        );
      });
      const identity = dialog.getByRole("button", {
        name: new RegExp(`Open profile for ${name} `),
      });
      await identity.hover({ position: { x: 20, y: 20 } });
      const card = page.getByRole("dialog", {
        name: `${name} identity`,
        exact: true,
      });
      await expect(card).toBeVisible();
      await opened(card);
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

async function opened(popup) {
  await expect(popup).toHaveAttribute("data-open", "");
  await expect(popup).not.toHaveAttribute("data-starting-style");
  await expect
    .poll(() => popup.evaluate((element) => element.getAnimations().length))
    .toBe(0);
}

// Pause at the actual exit boundary, not a runner-speed-dependent sleep.
async function holdPreviewExit(page) {
  await page.evaluate(() => {
    new MutationObserver((records) => {
      for (const { target } of records)
        if (
          target instanceof HTMLElement &&
          target.matches(".buzz-preview-card[data-ending-style]")
        )
          for (const animation of target.getAnimations()) animation.pause();
    }).observe(document.body, {
      attributes: true,
      attributeFilter: ["data-ending-style"],
      subtree: true,
    });
  });
  return {
    held: (popup) =>
      expect
        .poll(() =>
          popup.evaluate((element) =>
            element.getAnimations().some((a) => a.playState === "paused"),
          ),
        )
        .toBe(true),
    release: () =>
      page.evaluate(() => {
        for (const animation of document.getAnimations())
          if (animation.playState === "paused") animation.finish();
      }),
  };
}

test("Escape returns focus only while the closing identity preview still owns it", async ({
  page,
}) => {
  const { errors } = watchPageErrors(page);
  for (const move of ["none", "search", "tab"]) {
    await page.goto(url);
    await page
      .getByRole("button", { name: "Channel members", exact: true })
      .click();
    const dialog = page.getByRole("dialog", {
      name: "Channel members",
      exact: true,
    });
    const search = dialog.getByRole("searchbox");
    await search.fill("Morgan");
    const add = dialog.getByRole("button", { name: /Add Morgan/ });
    const identity = dialog.getByRole("button", {
      name: /Open profile for Morgan/,
    });
    await identity.hover({ position: { x: 20, y: 20 } });
    const card = page.getByRole("dialog", {
      name: "Morgan identity",
      exact: true,
    });
    await opened(card);
    const copy = card.getByRole("button", { name: "Copy npub", exact: true });
    await copy.click();
    await expect(copy).toBeFocused();
    const exit = await holdPreviewExit(page);
    const next = add;
    try {
      await page.keyboard.press("Escape");
      await exit.held(card);
      if (move === "search") {
        // The still-visible preview may overlap the left of the search field.
        // Click its exposed right edge, as a user can during the exit.
        const bounds = await search.boundingBox();
        await search.click({
          position: { x: bounds.width - 24, y: bounds.height / 2 },
        });
        await expect(search).toBeFocused();
      } else if (move === "tab") {
        await identity.focus();
        await page.keyboard.press("Tab");
        await expect(next).toBeFocused();
      }
      await expect(card).toHaveCount(1);
    } finally {
      await exit.release();
    }
    await expect(card).toHaveCount(0);
    await expect(
      move === "search" ? search : move === "tab" ? next : identity,
    ).toBeFocused();
    await expect(dialog).toBeVisible();
  }
  expect(errors).toEqual([]);
});

test("inline member identity geometry and separate addition focus", async ({
  page,
}) => {
  for (const moved of [false, true]) {
    await page.emulateMedia({
      reducedMotion: moved ? "reduce" : "no-preference",
    });
    await page.goto(url);
    await page.getByRole("button", { name: "Channel members" }).click();
    const dialog = page.getByRole("dialog", { name: "Channel members" });
    const search = dialog.getByRole("searchbox");
    const memberRow = dialog.getByRole("listitem").first();
    await expect(memberRow).toHaveCSS("min-height", "52px");
    expect((await memberRow.boundingBox()).height).toBe(52);
    // Browser-only: badge/key layers overlap during the fade, not a blank
    // second line or a moving identity. Pause CSS time for a deterministic midpoint.
    const pill = memberRow.getByText("Role unverified", { exact: true });
    const badges = pill.locator("..");
    const memberKey = memberRow.locator('[aria-hidden="true"].text-mono');
    const memberName = memberRow.getByText("Carl (you)", { exact: true });
    await expect(pill).toBeVisible();
    // The first role response expands metadata; do not measure mid-expansion.
    await expect(memberKey.locator("../..")).toHaveAttribute(
      "style",
      /height: auto/,
    );
    const nameBoundsBeforeFade = await memberName.boundingBox();
    const rowBoundsBeforeFade = await memberRow.boundingBox();
    if (!moved) {
      await memberRow.evaluate((node) => {
        window.memberCrossfade = new Promise((resolve) => {
          let started = 0;
          const hold = (event) => {
            if (event.propertyName !== "opacity") return;
            const animation = event.target
              .getAnimations()
              .find((item) => item.transitionProperty === "opacity");
            animation.pause();
            animation.currentTime = 70;
            if (++started === 2) {
              node.removeEventListener("transitionrun", hold);
              resolve();
            }
          };
          node.addEventListener("transitionrun", hold);
        });
      });
    }
    await memberRow.hover();
    if (!moved) {
      await page.evaluate(() => window.memberCrossfade);
      const opacity = async (locator) =>
        locator.evaluate((node) => Number(getComputedStyle(node).opacity));
      const pillOpacity = await opacity(badges);
      const keyOpacity = await opacity(memberKey);
      expect(pillOpacity).toBeGreaterThan(0);
      expect(pillOpacity).toBeLessThan(1);
      expect(keyOpacity).toBeGreaterThan(0);
      expect(keyOpacity).toBeLessThan(1);
      expect(pillOpacity + keyOpacity).toBeCloseTo(1, 4);
      await expect(pill).toBeVisible();
      await expect(memberKey).toBeVisible();
      expect(await memberName.boundingBox()).toEqual(nameBoundsBeforeFade);
      expect(await memberRow.boundingBox()).toEqual(rowBoundsBeforeFade);
      await memberRow.evaluate((node) => {
        for (const animation of node.getAnimations({ subtree: true }))
          animation.play();
      });
    } else {
      await expect(badges).toHaveCSS("transition-duration", "0s");
      await expect(memberKey).toHaveCSS("transition-duration", "0s");
    }
    await expect(badges).toHaveCSS("opacity", "0");
    await expect(memberKey).toHaveCSS("opacity", "1");
    await search.hover();
    await expect(badges).toHaveCSS("opacity", "1");
    await expect(memberKey).toBeHidden();
    await memberRow
      .getByRole("button", { name: /Open profile for Carl/ })
      .focus();
    await expect(badges).toHaveCSS("transition-duration", "0s");
    await expect(memberKey).toHaveCSS("opacity", "1");
    expect(await memberName.boundingBox()).toEqual(nameBoundsBeforeFade);
    expect(await memberRow.boundingBox()).toEqual(rowBoundsBeforeFade);
    await search.fill("Morgan");
    const add = dialog.getByRole("button", { name: /Add Morgan/ });
    await expect(add).toBeEnabled();
    const header = await dialog.locator(".buzz-dialog-header").boundingBox();
    const field = await search.locator("..").boundingBox();
    expect(field.y - header.y - header.height).toBeCloseTo(16, 0);
    await expect(add).toHaveCSS("font-size", "12px");
    expect((await add.boundingBox()).height).toBe(24);
    const members = dialog.getByRole("region", {
      name: "Members",
      exact: true,
    });
    const others = dialog.getByRole("region", {
      name: "Not in this channel",
      exact: true,
    });
    const list = dialog.getByRole("region", {
      name: "Member list",
      exact: true,
    });
    await expect(members.getByRole("heading").locator("..")).toHaveCSS(
      "position",
      "sticky",
    );
    await expect(others.getByRole("heading")).toHaveCSS("position", "sticky");
    // Browser-only: empty/short roster search results follow the group with
    // just the shared gap, not after all remaining dialog height.
    const gap = await list.evaluate((node) =>
      parseFloat(getComputedStyle(node).rowGap),
    );
    const roster = await members.boundingBox();
    expect(
      (await others.boundingBox()).y - roster.y - roster.height,
    ).toBeCloseTo(gap, 0);
    // Browser-only: an unbadged identity centers at rest and moves up to
    // reveal its key, without shifting the avatar, row or Add action.
    const row = add.locator("../..");
    const name = row.getByText("Morgan", { exact: true });
    const key = row.locator('[aria-hidden="true"].text-mono');
    await search.hover();
    await expect(key).toBeHidden();
    const rowBounds = await row.boundingBox();
    await expect(row).toHaveCSS("min-height", "52px");
    expect(rowBounds.height).toBe(52);
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
    const metadata = key.locator("../..");
    await expect(metadata).toHaveCSS("height", "0px");
    const addBounds = await add.boundingBox();
    await add.hover();
    await expect(key).toBeVisible();
    await expect(name).toBeVisible();
    // Motion restores auto only after settling; compare the real token-based
    // line box instead of rounding its fractional browser height to 20px.
    await expect(metadata).toHaveAttribute("style", /height: auto/);
    const raisedName = await name.boundingBox();
    const revealedHeight = await metadata.evaluate(
      (node) =>
        node.getBoundingClientRect().height +
        parseFloat(getComputedStyle(node).marginTop),
    );
    // Flex layout quantizes the centered line to a 1/64 CSS-pixel grid.
    const expectedY = Math.round((nameBounds.y - revealedHeight / 2) * 64) / 64;
    expect(raisedName.y).toBe(expectedY);
    expect(raisedName.x).toBe(nameBounds.x);
    expect(await add.boundingBox()).toEqual(addBounds);
    expect(await row.boundingBox()).toEqual(rowBounds);
    expect(await avatar.boundingBox()).toEqual(avatarBounds);
    await search.hover();
    await expect(key).toBeHidden();
    await expect(metadata).toHaveCSS("height", "0px");
    expect(await name.boundingBox()).toEqual(nameBounds);
    await add.focus();
    await expect(key).toBeVisible();
    await expect(add.getByText("Add", { exact: true })).toBeVisible();
    await page.keyboard.press("Enter");
    await page.evaluate(() => window.focusFixture.published);
    await expect(add).toHaveAttribute("aria-disabled", "true");
    await expect(add).toBeFocused();
    if (moved)
      await dialog
        .getByRole("button", { name: "Close channel members" })
        .focus();
    await page.evaluate(() => window.focusFixture.confirm());
    await expect(dialog.getByText("Morgan is in the channel.")).toBeVisible();
    await expect(
      moved
        ? dialog.getByRole("button", { name: "Close channel members" })
        : search,
    ).toBeFocused();
  }
});
