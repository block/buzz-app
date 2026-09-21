import { test, expect } from "./source-fixture.mjs";

// Browser-only proof: real Cordis -> ChannelsPage -> ThreadPanel wiring, native
// tab/row focus, full-width geometry and independent scroll in both engines.
test("shared preview coexists with private Sessions, opens the existing full-width thread and restores keyboard focus", async ({
  page,
}) => {
  await page.goto("/tests/fixtures/channel-sessions.html");
  await expect(
    page.getByRole("textbox", { name: "Message #General" }),
  ).toBeVisible();
  const sessions = page.getByRole("tab", { name: "Sessions", exact: true });
  await sessions.focus();
  await page.keyboard.press("Enter");
  const directory = page.getByRole("region", {
    name: "Sessions",
  });
  await expect(directory).toBeVisible();
  await expect(
    directory.getByRole("button", { name: /Explore the onboarding flow/ }),
  ).toBeVisible();
  await expect(
    directory.getByRole("button", { name: /Unanswered agent request/ }),
  ).toBeVisible();
  await expect(directory.getByText("Checking threads for agents…")).toHaveCount(
    0,
  );
  await expect(
    directory.getByRole("button", { name: /Human-only planning thread/ }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("textbox", { name: "Message #General" }),
  ).toHaveCount(0);
  expect(
    await page.evaluate(() => window.sessionsFixture.report.activeReaders),
  ).toBe(0);
  const row = directory.getByRole("button", {
    name: /Review the release checklist/,
  });
  await row.focus();
  await page.evaluate(() =>
    window.sessionsFixture.renameChannel("General renamed"),
  );
  await expect(
    page
      .getByRole("article", { name: "Conversation" })
      .locator("header strong")
      .first(),
  ).toHaveText("General renamed");
  await expect(sessions).toHaveAttribute("aria-selected", "true");
  await expect(row).toBeFocused();
  await page.keyboard.press("Enter");
  const thread = page.getByRole("complementary", {
    name: "Thread",
    exact: true,
  });
  await expect(thread).toBeVisible();
  const settled = async () => {
    // A visible reply does not establish traversal completion. Wait on the
    // actual reader, treating failure as terminal so it cannot evade assertions.
    await expect
      .poll(() =>
        page.evaluate(() => {
          const snapshot = window.sessionsFixture.threadSnapshot();
          return (
            snapshot?.status === "error" ||
            (snapshot?.status === "ready" && !snapshot.canLoadMore)
          );
        }),
      )
      .toBe(true);
    expect(
      await page.evaluate(() => window.sessionsFixture.threadSnapshot()),
    ).toMatchObject({
      status: "ready",
      error: undefined,
      canLoadMore: false,
      limited: false,
    });
    await expect(thread.getByRole("alert")).toHaveCount(0);
    await expect(thread.getByRole("button", { name: /Retry/ })).toHaveCount(0);
    await expect(thread.getByText("Loading thread…")).toHaveCount(0);
  };
  await settled();
  await expect(
    thread.getByText("Review the release checklist", { exact: true }),
  ).toBeVisible();
  await expect(
    thread.getByText(
      "Fixture reply for task 1. The conversation stays in its original thread.",
    ),
  ).toBeVisible();
  await expect(page.getByRole("region", { name: "Sessions" })).toHaveCount(0);
  await expect
    .poll(() =>
      page.evaluate(() => window.sessionsFixture.report.activeReaders),
    )
    .toBe(1);
  const conversationBox = await page
    .getByRole("article", { name: "Conversation" })
    .boundingBox();
  const threadBox = await thread.boundingBox();
  expect(Math.abs(threadBox.width - conversationBox.width)).toBeLessThan(4);
  await expect(
    thread.getByRole("button", { name: "Close thread" }),
  ).toBeFocused();
  const readers = await page.evaluate(
    () => window.sessionsFixture.report.readers,
  );
  await page.evaluate(() =>
    window.sessionsFixture.renameChannel("General updated"),
  );
  await expect(
    page
      .getByRole("article", { name: "Conversation" })
      .locator("header strong")
      .first(),
  ).toHaveText("General updated");
  await expect(sessions).toHaveAttribute("aria-selected", "true");
  await expect(
    thread.getByRole("button", { name: "Close thread" }),
  ).toBeFocused();
  expect(await page.evaluate(() => window.sessionsFixture.report.readers)).toBe(
    readers,
  );
  const composer = thread.getByRole("textbox");
  await composer.fill("A fixture follow-up");
  await thread.getByRole("button", { name: "Send message" }).click();
  await expect(
    thread.getByText("A fixture follow-up", { exact: true }),
  ).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          window.sessionsFixture.report.published.filter(
            (event) => event.kind === 9,
          ).length,
      ),
    )
    .toBe(1);
  const sent = await page.evaluate(() => ({
    event: window.sessionsFixture.report.published.find(
      (event) => event.kind === 9,
    ),
    root: window.sessionsFixture.rows[0].rootId,
  }));
  expect(sent.event.tags).toContainEqual(["e", sent.root, "", "reply"]);
  expect(sent.event.tags.some(([key]) => key === "p")).toBe(false);
  await page.evaluate(() => window.sessionsFixture.refreshThread());
  await settled();
  await thread.getByRole("button", { name: "Close thread" }).click();
  await expect(row).toBeFocused();
  await expect
    .poll(() =>
      page.evaluate(() => window.sessionsFixture.report.activeReaders),
    )
    .toBe(0);
  await expect(directory).toBeVisible();
  const last = directory.locator("li button").last();
  await last.scrollIntoViewIfNeeded();
  expect(
    await directory.evaluate((element) => element.scrollTop),
  ).toBeGreaterThan(0);
  await page.getByRole("tab", { name: "Channel", exact: true }).click();
  await expect(
    page.getByRole("textbox", { name: "Message #General updated" }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Private Sessions fixture", exact: true })
    .click();
  await expect(
    page.getByRole("complementary", { name: "Session history" }),
  ).toBeVisible();
  await expect(
    page.getByRole("region", { name: "New session", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Private work", exact: true }).click();
  await expect(
    page.getByRole("textbox", { name: "Message this session" }),
  ).toBeVisible();
  await expect(
    page.getByRole("tab", { name: "Sessions", exact: true }),
  ).toHaveCount(0);
  await page
    .getByRole("button", { name: "Messages fixture", exact: true })
    .click();
  await expect(
    page.getByRole("textbox", { name: "Message #General updated" }),
  ).toBeVisible();
  await expect(sessions).toHaveAttribute("aria-selected", "false");
});

test("fixture layout stays readable across light/dark and narrow/intermediate/wide views", async ({
  page,
}, testInfo) => {
  await page.goto("/tests/fixtures/channel-sessions.html");
  await page.getByRole("tab", { name: "Sessions", exact: true }).click();
  const directory = page.getByRole("region", {
    name: "Sessions",
  });
  for (const width of [390, 800, 1280]) {
    await page.setViewportSize({ width, height: 850 });
    for (const mode of ["light", "dark"]) {
      await page.evaluate(
        (mode) =>
          document.documentElement.setAttribute("data-color-mode", mode),
        mode,
      );
      await expect(directory).toBeVisible();
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth),
      ).toBeLessThanOrEqual(width);
      expect(
        await directory.evaluate(
          (element) => element.scrollWidth <= element.clientWidth,
        ),
      ).toBe(true);
      await expect(
        directory.getByRole("heading", { name: /^Started / }).first(),
      ).toBeVisible();
      // Resizing and tab selection animate the real Base UI indicator. Observe
      // its settled geometry rather than capturing an in-flight underline.
      await expect
        .poll(async () => {
          const tab = await page
            .getByRole("tab", { name: "Sessions", exact: true })
            .boundingBox();
          const indicator = await page
            .locator(".buzz-tabs-indicator")
            .boundingBox();
          return (
            Math.abs(tab.x - indicator.x) +
            Math.abs(tab.width - indicator.width)
          );
        })
        .toBeLessThan(1);
      await page.screenshot({
        path: testInfo.outputPath(`sessions-${width}-${mode}.png`),
      });
    }
  }
});
