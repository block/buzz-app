import { generateSecretKey } from "nostr-tools";
import { test, expect } from "./fixture.mjs";
import { newChat } from "./navigation.mjs";
import { openChannelDetails } from "./channel-details.mjs";

const solo = "33333333-3333-4333-8333-333333333333";
test.use({
  productionBroker: true,
  channelIds: [solo, "beta"],
  channelNames: { [solo]: "Alpha", beta: "Beta" },
  soloChannels: [solo],
  ownSoloChannels: [solo],
  dmLabels: true,
  historyCounts: { [solo]: 1, beta: 1 },
  enabledPlugins: ["buzz.drafts-and-sent"],
});

// Real paint geometry: DOM emulators cannot detect padding or baseline drift.
test("Team and Solo working badges share the painted row inset", async ({
  page,
  app,
}) => {
  await page.goto(app.origin);
  await newChat(page);
  await expect.poll(() => app.relay.hasRoute("primary", "observer")).toBe(true);
  for (const channelId of [solo, "beta"]) {
    app.observer(
      {
        kind: "turn_liveness",
        seq: 1,
        timestamp: new Date().toISOString(),
        channelId,
        sessionId: "S",
        turnId: channelId,
      },
      generateSecretKey(),
    );
  }
  const soloRow = page.locator(`[data-solo-menu-id="${solo}"]`);
  const teamRow = page
    .locator("[data-channel-sidebar-row]")
    .filter({ has: page.locator('[data-channel-id="beta"]') });
  for (const row of [soloRow, teamRow]) {
    await expect(row.locator("[data-channel-working]")).toBeVisible();
  }
  await page.mouse.move(0, 0);
  for (const [mode, width, fontSize] of [
    ["light", 1440, ""],
    ["dark", 900, "larger"],
  ]) {
    await page.setViewportSize({ width, height: 950 });
    await page.evaluate(
      ({ mode, fontSize }) => {
        document.documentElement.dataset.colorMode = mode;
        document.documentElement.dataset.fontSize = fontSize;
      },
      { mode, fontSize },
    );
    for (const row of [soloRow, teamRow]) {
      await expect
        .poll(() =>
          row.evaluate((element) => {
            const marker = element
              .querySelector("[data-channel-working]")
              .getBoundingClientRect();
            const rect = element.getBoundingClientRect();
            // The end token is a calc expression; resolve it through the painted pseudo-element.
            const fillEnd = parseFloat(
              getComputedStyle(element, "::before").right,
            );
            const root = parseFloat(
              getComputedStyle(document.documentElement).fontSize,
            );
            return {
              center:
                Math.round(
                  (marker.y + marker.height / 2 - rect.y - rect.height / 2) *
                    100,
                ) / 100,
              inset:
                Math.round(
                  ((rect.right - fillEnd - marker.right) / root) * 100,
                ) / 100,
            };
          }),
        )
        .toEqual({ center: 0, inset: 0.5 });
    }
  }
});

// Leaves a draft so the Drafts & sent row shows its trailing count.
async function draftsWithCount(page) {
  await page.locator('button[data-channel-id="beta"]').click();
  await page
    .getByRole("textbox", { name: "Message #Beta", exact: true })
    .fill("Keep this draft");
  const drafts = page
    .getByRole("navigation", { name: "Pages", exact: true })
    .getByRole("button", { name: /^Drafts & sent/ });
  await expect(
    drafts.getByRole("img", { name: "1 draft", exact: true }),
  ).toBeVisible();
  await page.mouse.move(0, 0);
  return drafts;
}

// Page rows paint on the navigation item itself; channel rows paint a fill
// inside their wrapper, beside the channel list's scrollbar gutter.
function columnsAgainstChannelRow(row) {
  const item = document.querySelector('button[data-channel-id="beta"]');
  const wrapper = item.closest("[data-channel-sidebar-row]");
  const fill = getComputedStyle(wrapper, "::before");
  const rect = (element, selector) =>
    element.querySelector(selector).getBoundingClientRect();
  // At fractional root sizes, layout snaps these edges to 1/64px units that
  // differ by a unit between rows; quarter pixels absorb that, and +0 drops -0.
  const round = (value) => Math.round(value * 4) / 4 + 0;
  const pill = row.getBoundingClientRect();
  const count = rect(row, '.navigation-item-trailing [role="img"]');
  const root = parseFloat(getComputedStyle(document.documentElement).fontSize);
  const offset = (selector, side) =>
    round(rect(row, selector)[side] - rect(item, selector)[side]);
  // Glyph sizes may differ; the shared icon column is their center.
  const iconCenter = (element) => {
    const glyph = rect(element, "svg");
    return glyph.left + glyph.width / 2;
  };
  return {
    // WebKit places the count's text box in 1/64px layout units; 1/64rem
    // steps absorb that at every Interface size.
    inset: Math.round(((pill.right - count.right) / root) * 64) / 64,
    start: round(
      pill.left - wrapper.getBoundingClientRect().left - parseFloat(fill.left),
    ),
    icon: round(iconCenter(row) - iconCenter(item)),
    label: offset(".navigation-item-label", "left"),
    trailing: offset(".navigation-item-trailing", "right"),
    end: round(
      pill.right -
        wrapper.getBoundingClientRect().right +
        parseFloat(fill.right),
    ),
  };
}

// Only the page rows reserve the channel list's gutter. The segmented control
// still starts, and New still ends, the controls row inside the header's
// padding, and the control fills the row up to New. Where New wraps below it,
// the control fills the first line and New starts the second.
function controlsAgainstHeader(tablist) {
  const header = [...tablist.closest(".buzz-sidebar-navigation").children].find(
    (child) => child.contains(tablist),
  );
  const row = [...header.children].find((child) => child.contains(tablist));
  const control = tablist.closest(".buzz-tabs").getBoundingClientRect();
  const create = row
    .querySelector('button[aria-label="New"]')
    .getBoundingClientRect();
  const box = header.getBoundingClientRect();
  const padding = getComputedStyle(header);
  const margin = getComputedStyle(row);
  const start =
    box.left + parseFloat(padding.paddingLeft) + parseFloat(margin.marginLeft);
  const end =
    box.right -
    parseFloat(padding.paddingRight) -
    parseFloat(margin.marginRight);
  const wrapped = create.top >= control.bottom;
  const round = (value) => Math.round(value * 4) / 4 + 0;
  return {
    start: round(control.left - start),
    fill: round(
      (wrapped ? end : create.left - parseFloat(margin.columnGap)) -
        control.right,
    ),
    end: round(wrapped ? create.left - start : end - create.right),
  };
}

// Page rows reserve their gutter in a scroll container, which clips: their
// focus rings must still fit inside it and every other clipping ancestor.
function ringClearance(row) {
  const style = getComputedStyle(row);
  const ring = parseFloat(style.outlineWidth) + parseFloat(style.outlineOffset);
  const box = row.getBoundingClientRect();
  let clearance = Infinity;
  for (let clip = row.parentElement; clip; clip = clip.parentElement) {
    if (getComputedStyle(clip).overflowX === "visible") continue;
    // Client sizes round to whole pixels at fractional root sizes. Borders and
    // scrollbars are whole pixels, so inset the exact box by those instead.
    const port = clip.getBoundingClientRect();
    const end = clip.offsetWidth - clip.clientLeft - clip.clientWidth;
    const bottom = clip.offsetHeight - clip.clientTop - clip.clientHeight;
    clearance = Math.min(
      clearance,
      box.left - ring - port.left - clip.clientLeft,
      box.top - ring - port.top - clip.clientTop,
      port.right - end - box.right - ring,
      port.bottom - bottom - box.bottom - ring,
    );
  }
  return clearance;
}

// Applies the color mode and Interface size settings through their saved
// preferences. The theme service re-applies both whenever it restores either,
// so neither can be set on the root directly.
async function setAppearance(page, mode, scale) {
  await page.evaluate(
    ({ mode, scale }) => {
      localStorage.setItem("buzz-appearance.v1", mode);
      localStorage.setItem("buzz-font-scale.v1", String(scale));
      window.dispatchEvent(
        new StorageEvent("storage", { key: null, storageArea: localStorage }),
      );
    },
    { mode, scale },
  );
  const root = page.locator("html");
  await expect(root).toHaveAttribute("data-color-mode", mode);
  await expect(root).toHaveCSS("--buzz-text-scale", String(scale));
}

test("the Drafts & sent row shares channel rows' columns and inset without moving the header controls", async ({
  page,
  app,
}) => {
  await page.goto(app.origin);
  const drafts = await draftsWithCount(page);
  const scope = page.getByRole("tablist", { name: "Navigation scope" });
  const rows = page
    .getByRole("navigation", { name: "Pages", exact: true })
    .getByRole("button");
  // Keyboard modality draws focus rings.
  await page.keyboard.press("Tab");
  for (const [mode, width, scale] of [
    ["light", 1440, 1],
    ["dark", 900, 0.8],
    ["light", 900, 2],
  ]) {
    await page.setViewportSize({ width, height: 950 });
    await setAppearance(page, mode, scale);
    await expect
      .poll(() => drafts.evaluate(columnsAgainstChannelRow))
      .toEqual({
        inset: 0.375,
        start: 0,
        icon: 0,
        label: 0,
        trailing: 0,
        end: 0,
      });
    await expect
      .poll(() => scope.evaluate(controlsAgainstHeader))
      .toEqual({ start: 0, fill: 0, end: 0 });
    for (const row of [rows.first(), rows.last()]) {
      await row.focus();
      await expect(row).toHaveCSS("outline-style", "solid");
      await expect
        .poll(() => row.evaluate(ringClearance))
        .toBeGreaterThanOrEqual(0);
    }
  }
});

// The case above only exercises the scrollbar gutter where the engine happens
// to reserve one. This case runs where scrollbars take space and requires it.
test("beside a classic scrollbar, the Drafts & sent row ends in channel rows' column and the header controls stay put", {
  tag: "@classic-scrollbars",
}, async ({ page, app }) => {
  test.skip(
    process.platform !== "linux" && !process.env.BUZZ_CLASSIC_SCROLLBARS,
    "Set BUZZ_CLASSIC_SCROLLBARS=1 on a Mac whose scrollbars take space",
  );
  await page.goto(app.origin);
  const drafts = await draftsWithCount(page);
  const gutter = await page
    .getByRole("navigation", { name: "Subscribed channels", exact: true })
    .evaluate((list) => list.offsetWidth - list.clientWidth);
  expect(
    gutter,
    "the channel list's scrollbar gutter must take space",
  ).toBeGreaterThan(0);
  await expect
    .poll(() => drafts.evaluate(columnsAgainstChannelRow))
    .toMatchObject({ trailing: 0, end: 0 });
  await expect
    .poll(() =>
      page
        .getByRole("tablist", { name: "Navigation scope" })
        .evaluate(controlsAgainstHeader),
    )
    .toEqual({ start: 0, fill: 0, end: 0 });
});

test("a presence badge preserves the sidebar avatar center and header insets", async ({
  page,
  app,
}) => {
  await page.goto(app.origin);
  const row = page.locator('button[data-channel-id="dm-peer"]');
  await row.click();
  await expect
    .poll(() =>
      app.report.presenceSnapshots.some((snapshot) =>
        snapshot.filter.authors.includes(app.participants[0]),
      ),
    )
    .toBe(true);
  // Snapshot admission precedes the separate live presence REQ.
  await expect
    .poll(() => app.relay.hasPresenceRoute("primary", app.participants[0]))
    .toBe(true);
  app.presence("away");
  const avatar = row.locator(".buzz-avatar-status");
  await expect(avatar).toHaveAttribute("data-status", "away");
  await page
    .getByRole("button", { name: /^Manage members of /, exact: true })
    .click();
  await page
    .getByRole("button", { name: /^Open profile for Alice Fixture/ })
    .click();
  const headers = page.locator("header.panel-header");
  await expect(headers).toHaveCount(2);
  for (const [mode, fontSize] of [
    ["light", ""],
    ["dark", "larger"],
  ]) {
    await page.evaluate(
      ({ mode, fontSize }) => {
        document.documentElement.dataset.colorMode = mode;
        document.documentElement.dataset.fontSize = fontSize;
      },
      { mode, fontSize },
    );
    await expect
      .poll(() =>
        avatar.evaluate((element) => {
          const row = element
            .closest("[data-channel-sidebar-row]")
            .getBoundingClientRect();
          const image = element
            .querySelector(".buzz-avatar")
            .getBoundingClientRect();
          const dot = element
            .querySelector(".buzz-avatar-status-dot")
            .getBoundingClientRect();
          return {
            offset: image.y + image.height / 2 - row.y - row.height / 2,
            square: dot.width === dot.height,
          };
        }),
      )
      .toEqual({ offset: 0, square: true });
    for (const header of await headers.all()) {
      await expect
        .poll(() =>
          header.evaluate((element) => {
            const frame = element.getBoundingClientRect();
            const tab = (
              element.querySelector('[role="tab"]') ??
              element.querySelector("[data-workspace-identity] button")
            ).getBoundingClientRect();
            // The joined panel's outer border is outside this header's band.
            const bandTop = frame.top;
            const separator = parseFloat(
              getComputedStyle(element).borderBottomWidth,
            );
            const bandBottom = frame.bottom - separator;
            return Math.abs(tab.top - bandTop - (bandBottom - tab.bottom));
          }),
        )
        .toBeLessThan(1);
    }
  }
  await openChannelDetails(page);
  const detailHeader = headers.last();
  await expect(detailHeader.getByRole("tab")).toHaveCount(2);
  let fittingInset;
  // Keep the desktop split visible; narrower windows use a fixed-width overlay.
  for (const [key, overflowing] of [
    ["End", false],
    ["Home", true],
  ]) {
    await page
      .getByRole("separator", {
        name: "Resize main and secondary panels",
        exact: true,
      })
      .press(key);
    const strip = detailHeader.locator(".buzz-tabs-list");
    await expect
      .poll(() => strip.evaluate((e) => e.scrollWidth > e.clientWidth))
      .toBe(overflowing);
    const inset = await detailHeader.evaluate((e) => {
      const frame = e.getBoundingClientRect();
      return (
        e.querySelector('[role="tab"]').getBoundingClientRect().top - frame.top
      );
    });
    if (fittingInset === undefined) fittingInset = inset;
    expect(inset).toBe(fittingInset);
  }
});
