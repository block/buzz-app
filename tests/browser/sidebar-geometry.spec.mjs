import { test, expect } from "./fixture.mjs";
import { openInView } from "./rail-helpers.mjs";
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
test("a panel header keeps its insets across themes, text sizes and widths", async ({
  page,
  app,
}) => {
  await page.goto(app.origin);
  await openInView(page, "dms", "dm-peer");
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
    // The conversation's own header floats over its history; only the panel
    // header is a band its tab centers in.
    for (const header of [headers.last()]) {
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

// The sidebar is fluid, like auto layout: rows and headings fill their list,
// a heading's label fills and its actions hug, and nothing floats over or
// reserves space for anything else. Every tab, at both width limits, has to
// hold that without per-tab adjustments.
