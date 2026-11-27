import { test, expect } from "./source-fixture.mjs";
import { hoverMessage } from "./message-actions.mjs";
import { watchPageErrors } from "./page-errors.mjs";

test.use({ video: "on" });

test("discovers channel workflow reactions on demand, explains branches and reacts normally", async ({
  page,
}, testInfo) => {
  const errors = watchPageErrors(page);
  await page.route("**/emoji-media/**", (route) =>
    route.fulfill({
      contentType: "image/svg+xml",
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22"><circle cx="11" cy="11" r="10" fill="purple"/></svg>',
    }),
  );
  await page.goto("/tests/fixtures/emoji.html?reactions&workflow-reactions");
  const reads = () =>
    page.evaluate(() => window.emojiFixture.report.workflowReads);
  expect(await reads()).toEqual([]);
  const root = page
    .locator("[data-message-id]")
    .filter({ hasText: "Historic" });
  const open = async () => {
    await hoverMessage(root);
    await root
      .getByRole("group", { name: "Message actions", includeHidden: true })
      .getByRole("button", { name: "Add reaction", exact: true })
      .click();
    await expect(
      page.locator('em-emoji-picker input[type="search"]'),
    ).toBeFocused();
  };
  await open();
  const choices = page.getByRole("region", { name: "Workflow reactions" });
  const review = choices.getByRole("button", {
    name: "✅: Triage — Review complete",
    exact: true,
  });
  await expect(review).toBeVisible();
  await expect(choices.getByRole("button", { name: /^🛑|^🚩/ })).toHaveCount(0);
  expect(await reads()).toEqual([
    { community: "a", channels: ["11111111-1111-4111-8111-111111111111"] },
  ]);
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Shift+Tab");
  await expect(review).toBeFocused();
  await expect(page.getByRole("tooltip")).toContainText("Review complete");
  // Capture the real picker, not the native desktop or a production community.
  for (const theme of ["light", "dark"]) {
    await page.evaluate((theme) => {
      document.documentElement.dataset.colorMode = theme;
    }, theme);
    await page.screenshot({
      path: testInfo.outputPath(`workflow-reactions-${theme}.png`),
    });
  }
  await review.press("Enter");
  await expect(page.getByRole("dialog", { name: "Emoji picker" })).toHaveCount(
    0,
  );
  await expect
    .poll(() =>
      page.evaluate(() =>
        window.emojiFixture.report.publications
          .filter(({ event }) => event.kind === 7)
          .map(({ event }) => event.content),
      ),
    )
    .toEqual(["✅"]);
  await open();
  const celebrate = choices.getByRole("button", {
    name: ":party:: Triage — Celebrate",
    exact: true,
  });
  await expect(celebrate.locator("img")).toBeVisible();
  await celebrate.hover();
  await expect(page.getByRole("tooltip")).toContainText("Celebrate");
  await celebrate.click();
  await expect
    .poll(() =>
      page.evaluate(() =>
        window.emojiFixture.report.publications
          .filter(({ event }) => event.kind === 7)
          .map(({ event }) => event.content),
      ),
    )
    .toEqual(["✅", ":party:"]);
  const events = await page.evaluate(() =>
    window.emojiFixture.report.publications.map(({ event }) => event),
  );
  for (const event of events) {
    expect(event.kind).toBe(7);
    expect(event.tags).toContainEqual([
      "h",
      "11111111-1111-4111-8111-111111111111",
    ]);
    expect(event.tags.find(([name]) => name === "e")?.[1]).toBe(
      await root.getAttribute("data-message-id"),
    );
  }
  expect(events.at(-1).tags).toContainEqual([
    "emoji",
    "party",
    "https://a.test/media/1.png",
  ]);
  await page.getByRole("button", { name: "Switch community" }).click();
  await open();
  await expect(
    choices.getByRole("button", {
      name: "🎉: Other community — Review complete",
      exact: true,
    }),
  ).toBeVisible();
  await expect(choices.getByRole("button", { name: /Triage/ })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Switch community" }).click();
  await page.evaluate(() => window.emojiFixture.disableWorkflow());
  await open();
  await expect(choices).toHaveCount(0);
  await expect(
    page.locator('em-emoji-picker input[type="search"]'),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await page.evaluate(() => window.emojiFixture.failWorkflows(true));
  await open();
  await expect(
    page.getByRole("button", { name: "Retry workflow reactions" }),
  ).toBeVisible();
  await expect(
    page.locator('em-emoji-picker input[type="search"]'),
  ).toBeVisible();
  await page.evaluate(() => window.emojiFixture.failWorkflows(false));
  await page.getByRole("button", { name: "Retry workflow reactions" }).click();
  await expect(
    page.getByRole("button", { name: "Retry workflow reactions" }),
  ).toHaveCount(0);
  expect(errors.unexplained()).toEqual([]);
});
