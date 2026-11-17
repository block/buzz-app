import { npubEncode } from "nostr-tools/nip19";
import { openChannelDetails } from "./channel-details.mjs";
import { test, expect } from "./fixture.mjs";
import { activityRow, channelRow, conversationRow } from "./navigation.mjs";
import { open } from "./timeline.mjs";

test.use({
  productionBroker: true,
  dmLabels: true,
  historyCounts: { alpha: 1, beta: 1 },
});

for (const cold of [false, true]) {
  test(`DM names survive ${cold ? "hidden channel deletion during a cold fetch" : "channel deletion with loaded profiles"}`, async ({
    page,
    app,
  }) => {
    const dm = conversationRow(page, "Alice Fixture");
    const fallback = conversationRow(
      page,
      `npub…${npubEncode(app.participants[0]).slice(-3)}`,
    );
    const beta = channelRow(page, "beta");
    const labelReads = () =>
      app.report.queries.filter(
        ({ filter }) =>
          filter.kinds?.includes(0) &&
          filter.authors?.includes(app.participants[0]),
      );
    if (cold) {
      app.hideChannel("beta");
      app.relay.holdProfiles(app.participants);
    }
    try {
      await open(page, app);
      // Activity lists channels and DMs together.
      await activityRow(page).click();
      if (cold) {
        await expect(fallback).toBeVisible();
        await expect.poll(() => labelReads().length).toBe(1);
        expect(app.report.profileHolds.some((held) => held.pending)).toBe(true);
        await expect(beta).toHaveCount(0);
      } else {
        await expect(dm).toBeVisible();
        await expect(beta).toBeVisible();
        app.relay.holdProfiles(app.participants);
      }
      await expect((cold ? fallback : dm).locator(".buzz-avatar")).toHaveText(
        cold ? "N" : "A",
      );
      const before = labelReads().length;
      await channelRow(page, "alpha").click();
      app.omitChannel("beta");
      // The deployed deletion trigger is not under test. Exercise the real
      // refresh -> roster omission -> session purge -> page/hook recovery path.
      await openChannelDetails(page);
      await page.getByText("Diagnostics", { exact: true }).click();
      await page
        .getByRole("button", { name: "Refresh channels", exact: true })
        .click();
      await expect(
        page.getByText("Roster · 3 channels", { exact: true }),
      ).toBeVisible();
      // Profiles do not depend on channels: the deletion purges Beta's content
      // but keeps loaded names and lets a name read in flight finish.
      if (cold) {
        await expect(fallback).toBeVisible();
        expect(app.report.profileHolds.some((held) => held.aborted)).toBe(
          false,
        );
        app.relay.releaseProfiles();
      }
      await expect(dm).toBeVisible();
      await expect(fallback).toHaveCount(0);
      await page
        .getByRole("button", {
          name: "Close Channel settings tab",
          exact: true,
        })
        .click();
      await dm.click();
      // The header names the people; the members dialog reads their presence.
      await page
        .getByRole("article", { name: "Conversation" })
        .getByRole("button", {
          name: "Manage members of Alice Fixture",
          exact: true,
        })
        .click();
      expect(labelReads()).toHaveLength(before);
      await expect(dm.locator(".buzz-avatar")).toHaveText("A");
      await expect
        .poll(() =>
          app.report.presenceSnapshots.some((snapshot) =>
            snapshot.filter.authors.includes(app.participants[0]),
          ),
        )
        .toBe(true);
    } finally {
      app.relay.releaseProfiles();
    }
  });
}
