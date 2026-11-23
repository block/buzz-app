import { finalizeEvent, getPublicKey } from "nostr-tools";
import { test, expect } from "../browser/fixture.mjs";
import { open, settle } from "../browser/timeline.mjs";

// Focused visual coverage for existing message activity history; behavior
// contracts remain in component tests. All identities and text are synthetic.
test.use({
  productionBroker: true,
  readState: true,
  fixedKeys: true,
  historyCounts: { alpha: 1, beta: 0 },
  video: "on",
  reducedMotion: "reduce",
});

for (const colorScheme of ["light", "dark"]) {
  test(`${colorScheme} activity history in channel messages and an individual thread branch`, async ({
    page,
    app,
  }) => {
    await page.emulateMedia({ colorScheme });
    await page.clock.setFixedTime(new Date("2023-11-14T22:20:00Z"));
    const keys = [10, 11].map((seed) =>
      Uint8Array.from({ length: 32 }, (_, index) => (index === 31 ? seed : 0)),
    );
    const ids = keys.map(getPublicKey);
    keys.forEach((key, index) => {
      app.serveProfile(key, {
        name: ["Builder", "Reviewer"][index],
        is_agent: true,
      });
    });
    await page.route("**/agent-library", (route) =>
      route.fulfill({
        json: {
          definitions: [],
          identities: ids.map((pubkey, index) => ({
            pubkey,
            name: ["Builder", "Reviewer"][index],
          })),
        },
      }),
    );
    const history = app.histories.get("primary/alpha");
    history.length = 0;
    let time = 1700000100;
    const event = (key, content, tags = []) =>
      finalizeEvent(
        {
          kind: 9,
          created_at: time++,
          content,
          tags: [["h", "alpha"], ...tags],
        },
        key,
      );
    const first = event(
      keys[0],
      "Review the layout and return findings.\n\nKeep [the source](https://example.org/source) inspectable.",
      [
        ["audience", "agents"],
        ["p", ids[1]],
      ],
    );
    const second = event(
      keys[1],
      "The source remains inspectable after expansion.",
      [
        ["audience", "agents"],
        ["p", ids[0]],
      ],
    );
    const root = app.sign({
      kind: 9,
      created_at: time++,
      content:
        "Public result: the review is complete. Open this thread for details.",
      tags: [["h", "alpha"]],
    });
    const branch = event(
      keys[0],
      "Check the keyboard disclosure and return findings.",
      [
        ["audience", "agents"],
        ["p", ids[1]],
        ["e", root.id, "", "reply"],
      ],
    );
    const nested = app.sign({
      kind: 9,
      created_at: time++,
      content: "Original branch replies remain available.",
      tags: [
        ["h", "alpha"],
        ["e", root.id, "", "root"],
        ["e", branch.id, "", "reply"],
      ],
    });
    const person = event(
      keys[1],
      "Human decision needed: choose a rollout window.",
      [
        ["audience", "agents"],
        ["p", app.viewer],
        ["e", root.id, "", "reply"],
      ],
    );
    history.push(first, second, root, branch, nested, person);
    await open(page, app);
    // Signed relay summary makes the thread discoverable through real UI.
    app.threadSummary(root.id, [ids[0], ids[1], app.viewer], 3);
    await page.evaluate(() => document.fonts.ready);
    const timeline = page.locator("[data-channel-timeline]");
    const group = timeline
      .getByRole("button", { name: /^Show activity history:/ })
      .first();
    await expect(group).toBeVisible();
    await expect(group).toHaveAttribute("aria-expanded", "false");
    await page.mouse.move(0, 0);
    await expect(timeline).toHaveScreenshot(
      `${colorScheme}-channel-collapsed.png`,
    );

    await group.focus();
    await page.keyboard.press("Enter");
    const expanded = timeline
      .getByRole("button", { name: /^Collapse activity history:/ })
      .first();
    await expect(expanded).toBeFocused();
    await timeline
      .getByRole("button", { name: /Builder: Review the layout/ })
      .click();
    await expect(
      timeline.getByRole("link", { name: "the source", exact: true }),
    ).toHaveAttribute("href", "https://example.org/source");
    await expect(
      timeline.getByText(second.content, { exact: true }),
    ).toBeVisible();
    await page.mouse.move(0, 0);
    await settle(page);
    await expect(timeline).toHaveScreenshot(
      `${colorScheme}-channel-expanded.png`,
    );

    const rootRow = timeline.locator(`[data-message-id="${root.id}"]`);
    await rootRow.hover();
    await rootRow.getByRole("button", { name: /^View thread:/ }).click();
    const thread = page.getByRole("complementary", {
      name: "Thread",
      exact: true,
    });
    const threadHistory = thread.getByRole("region", {
      name: "Thread messages",
      exact: true,
    });
    const branchRow = thread.locator(`[data-message-id="${branch.id}"]`);
    const disclosure = branchRow.getByRole("button").first();
    await expect(disclosure).toBeVisible();
    await expect(
      thread.getByText(person.content, { exact: true }),
    ).toBeVisible();
    await page.mouse.move(0, 0);
    await expect(threadHistory).toHaveScreenshot(
      `${colorScheme}-thread-collapsed.png`,
    );

    await disclosure.focus();
    await page.keyboard.press("Enter");
    await expect(
      branchRow.getByText(branch.content, { exact: true }),
    ).toBeVisible();
    await expect(disclosure).toBeFocused();
    await page.mouse.move(0, 0);
    await expect(threadHistory).toHaveScreenshot(
      `${colorScheme}-thread-expanded.png`,
    );
  });
}
