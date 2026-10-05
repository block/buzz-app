import { test, expect } from "./source-fixture.mjs";
import { watchPageErrors } from "./page-errors.mjs";

// Browser-only proof: real Cordis -> ChannelsPage -> ThreadPanel wiring, native
// tab/row focus, full-width geometry and independent scroll in both engines.
test("shared preview coexists with private Sessions, opens the existing full-width thread and restores keyboard focus", async ({
  page,
  context,
}) => {
  // Reload must keep the same fixture viewer/scope. Seeds otherwise create the
  // empty creation fixture, so explicitly retain this journey's bounded history.
  await context.addInitScript(() => {
    window.fixtureSeeds = Array.from({ length: 4 }, (_, index) =>
      Array(32).fill(index + 1),
    );
    window.fixtureRowCount = 18;
  });
  await page.clock.setFixedTime(new Date("2026-09-21T14:00:00Z"));
  await page.goto("/tests/fixtures/channel-sessions.html");
  await expect(
    page.getByRole("textbox", { name: "Message #General" }),
  ).toBeVisible();
  // Native sidebar focus/disclosure and cross-channel destination ownership.
  const sidebar = page.getByRole("complementary", { name: "Channel sidebar" });
  const personal = sidebar.getByRole("region", {
    name: "Your sessions in General",
    exact: true,
  });
  const personalRoot = personal.getByRole("button", {
    name: /^Review the release checklist/,
  });
  const disclosure = sidebar.getByRole("button", {
    name: /^(Expand|Collapse) sessions in General$/,
  });
  await expect(disclosure).toHaveAttribute("aria-expanded", "false");
  await expect(personalRoot).toBeHidden();
  await disclosure.focus();
  await page.keyboard.press("Enter");
  await expect(personalRoot).toBeVisible();
  await expect(personal.getByRole("button")).toHaveCount(6);
  await expect(
    personal.getByRole("button", { name: /^Investigate task 3/ }),
  ).toHaveAttribute("title", "Investigate task 3");

  await expect(
    personal.getByRole("button", { name: "View all sessions" }),
  ).toHaveAccessibleDescription("From loaded history · may be incomplete");
  await page.keyboard.press("Enter");
  await expect(personalRoot).toBeHidden();
  await sidebar.locator('[data-channel-id="general"]').click();
  await expect(
    page.getByRole("textbox", { name: "Message #General" }),
  ).toBeVisible();
  await expect(disclosure).toHaveAttribute("aria-expanded", "false");
  await page.evaluate(() =>
    window.sessionsFixture.renameChannel("General renamed"),
  );
  await expect(
    sidebar.getByRole("button", {
      name: "Expand sessions in General renamed",
      exact: true,
    }),
  ).toHaveAttribute("aria-expanded", "false");
  await page.evaluate(() => window.sessionsFixture.renameChannel("General"));
  await disclosure.focus();
  await page.keyboard.press("Enter");
  await expect(personalRoot).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole("textbox", { name: "Message #General" }),
  ).toBeVisible();
  await expect(disclosure).toHaveAttribute("aria-expanded", "true");
  await expect(personalRoot).toBeVisible();
  await page
    .getByRole("button", { name: "Private Sessions fixture", exact: true })
    .click();
  await expect(sidebar).toBeVisible();
  await page
    .getByRole("button", { name: "Messages fixture", exact: true })
    .click();
  await expect(personalRoot).toBeVisible();
  await disclosure.focus();
  await page.keyboard.press("Enter");
  await expect(personalRoot).toBeHidden();
  await page.reload();
  await expect(
    page.getByRole("textbox", { name: "Message #General" }),
  ).toBeVisible();
  await expect(disclosure).toHaveAttribute("aria-expanded", "false");
  await disclosure.focus();
  await page.keyboard.press("Enter");
  await expect(personalRoot).toBeVisible();
  await sidebar.getByRole("button", { name: "Other", exact: true }).click();
  await expect(
    page.getByRole("textbox", { name: "Message #Other" }),
  ).toBeVisible();
  await personalRoot.focus();
  await page.keyboard.press("Enter");
  const sidebarDetail = page.getByRole("complementary", {
    name: "Session",
    exact: true,
  });
  await expect(sidebarDetail).toBeVisible();
  await expect(personalRoot).toHaveAttribute("aria-current", "page");
  await sidebarDetail.getByRole("button", { name: "Back to Sessions" }).click();
  await expect(personalRoot).toBeFocused();
  await sidebar.getByRole("button", { name: "Other", exact: true }).click();
  await personal.getByRole("button", { name: "View all sessions" }).click();
  await expect(
    page.getByRole("tab", { name: "Sessions", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  const sessions = page.getByRole("tab", { name: "Sessions", exact: true });
  await sessions.focus();
  await page.keyboard.press("Enter");
  const directory = page.getByRole("region", {
    name: "Sessions",
    exact: true,
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
  // Browser wiring proof: actual plugin-owned observer -> retained turn -> both
  // row renderers. Pure correlation permutations remain in Vitest.
  expect(
    await page.evaluate(() => window.sessionsFixture.report.observerControls),
  ).toEqual([]);
  await page.evaluate(() => window.sessionsFixture.enableActivity());
  await expect
    .poll(() =>
      page.evaluate(() => window.sessionsFixture.activityState().status),
    )
    .toBe("listening");
  const activityReads = await page.evaluate(
    () => window.sessionsFixture.report.queries.length,
  );
  const activityOrder = await directory
    .locator("li button")
    .evaluateAll((rows) => rows.map((row) => row.id));
  const activityRow = directory.getByRole("button", {
    name: /Review the release checklist/,
  });
  await activityRow.focus();
  await page.evaluate(() =>
    window.sessionsFixture.telemetry("turn_started", [
      window.sessionsFixture.rows[0].rootId,
    ]),
  );
  const working = "Owner-visible agent activity: working";
  await expect(
    activityRow.getByRole("img", { name: working, exact: true }),
  ).toBeVisible();
  await expect(
    personalRoot.getByRole("img", { name: working, exact: true }),
  ).toBeVisible();
  await expect(
    activityRow.getByRole("img", { name: /Observed unread/ }),
  ).toBeVisible();
  await expect(
    directory
      .getByRole("button", { name: /Explore the onboarding flow/ })
      .locator("[data-session-activity]"),
  ).toHaveCount(0);
  await expect(activityRow).toBeFocused();
  await disclosure.click();
  await expect(disclosure).toHaveAttribute("aria-expanded", "false");
  await page.clock.setFixedTime(new Date("2026-09-21T14:00:31Z"));
  await page.evaluate(() => window.sessionsFixture.telemetry("diagnostic"));
  await expect(
    activityRow.getByRole("img", {
      name: "Owner-visible agent activity: status unknown",
      exact: true,
    }),
  ).toBeVisible();
  await expect(disclosure).toHaveAttribute("aria-expanded", "false");
  await expect(personalRoot).toBeHidden();
  await disclosure.click();
  await expect(
    personalRoot.getByRole("img", {
      name: "Owner-visible agent activity: status unknown",
      exact: true,
    }),
  ).toBeVisible();
  await page.evaluate(() => window.sessionsFixture.telemetry("turn_completed"));
  await expect(activityRow.locator("[data-session-activity]")).toHaveCount(0);
  await expect(personalRoot.locator("[data-session-activity]")).toHaveCount(0);
  expect(
    await directory
      .locator("li button")
      .evaluateAll((rows) => rows.map((row) => row.id)),
  ).toEqual(activityOrder);
  expect(
    await page.evaluate(() => window.sessionsFixture.report.queries.length),
  ).toBe(activityReads);
  await page.evaluate(() => window.sessionsFixture.disableActivity());
  await expect
    .poll(() =>
      page.evaluate(() => window.sessionsFixture.activityState().status),
    )
    .toBe("disabled");
  expect(
    await page.evaluate(() => window.sessionsFixture.report.observerControls),
  ).toHaveLength(2);
  await page.clock.setFixedTime(new Date("2026-09-21T14:00:00Z"));
  // Existing live receive path: crossing day groups must preserve native focus,
  // row identity and compact layout, without issuing another directory query.
  const older = directory.getByRole("button", { name: /Investigate task 4/ });
  await older.focus();
  const reads = await page.evaluate(
    () => window.sessionsFixture.report.queries.length,
  );
  await page.evaluate(() =>
    window.sessionsFixture.replyTo(window.sessionsFixture.rows[3].rootId),
  );
  await expect(directory.locator("li button").first()).toHaveText(
    /Investigate task 4/,
  );
  await expect(older).toBeFocused();
  await expect(older.locator("time")).toHaveAttribute(
    "datetime",
    "2026-09-21T14:01:00.000Z",
  );
  expect(
    await page.evaluate(() => window.sessionsFixture.report.queries.length),
  ).toBe(reads);
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
      .locator(".panel-header-title h2"),
  ).toHaveText("General renamed");
  await expect(sessions).toHaveAttribute("aria-selected", "true");
  await expect(row).toBeFocused();
  await page.keyboard.press("Enter");
  const thread = page.getByRole("complementary", {
    name: "Session",
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
    await expect(thread.getByText("Loading session…")).toHaveCount(0);
  };
  await settled();
  await expect(
    thread
      .getByRole("region", { name: "Session messages" })
      .getByText("Review the release checklist", { exact: true }),
  ).toBeVisible();
  await expect(
    thread.getByText(
      "Fixture reply for task 1. The conversation stays in its original thread.",
    ),
  ).toBeVisible();
  await expect(
    page.getByRole("region", { name: "Sessions", exact: true }),
  ).toHaveCount(0);
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
    thread.getByRole("button", { name: "Back to Sessions" }),
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
      .locator(".panel-header-title h2"),
  ).toHaveText("General updated");
  await expect(sessions).toHaveAttribute("aria-selected", "true");
  await expect(
    thread.getByRole("button", { name: "Back to Sessions" }),
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
  await thread.getByRole("button", { name: "Back to Sessions" }).click();
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
  await page.clock.setFixedTime(new Date("2026-09-21T14:00:00Z"));
  await page.goto("/tests/fixtures/channel-sessions.html");
  await page.getByRole("tab", { name: "Sessions", exact: true }).click();
  const directory = page.getByRole("region", {
    name: "Sessions",
    exact: true,
  });
  await page.evaluate(() => window.sessionsFixture.enableActivity());
  await expect
    .poll(() =>
      page.evaluate(() => window.sessionsFixture.activityState().status),
    )
    .toBe("listening");
  await page.evaluate(() =>
    window.sessionsFixture.telemetry("turn_started", [
      window.sessionsFixture.rows[0].rootId,
    ]),
  );
  for (const width of [390, 740, 1280, 1512]) {
    await page.setViewportSize({ width, height: width === 1512 ? 982 : 850 });
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
        directory.getByRole("heading", { name: "Today", exact: true }).first(),
      ).toBeVisible();
      await expect(
        directory.getByRole("heading", { name: "Sessions", exact: true }),
      ).toHaveCount(0);
      const mentionRow = directory.getByRole("button", {
        name: /Investigate task 3/,
      });
      await expect(
        mentionRow.getByRole("img", { name: "Agent Fixture member" }),
      ).toBeVisible();
      await expect(mentionRow.locator("button")).toHaveCount(0);
      const starter = mentionRow.getByRole("img", {
        name: "Started by Fixture reader",
      });
      await expect(starter).toHaveAttribute("data-avatar-shape", "circle");
      const starterBox = await starter.boundingBox();
      const timeBox = await mentionRow.locator("time").boundingBox();
      expect(starterBox.width).toBe(24);
      const mentionBox = await mentionRow.locator(".inline-chip").boundingBox();
      const rowBox = await mentionRow.boundingBox();
      expect(starterBox.x).toBe(rowBox.x);
      expect(starterBox.x + starterBox.width).toBeLessThan(mentionBox.x);
      expect(timeBox.x).toBeGreaterThan(mentionBox.x + mentionBox.width);
      expect(timeBox.x + timeBox.width).toBeCloseTo(rowBox.x + rowBox.width, 0);
      await expect(mentionRow.locator(":scope > svg")).toHaveCount(0);

      // Existing sampled replies supply real unread evidence without adding history.
      const unreadRow = directory.getByRole("button", {
        name: /Review the release checklist/,
      });
      const dot = unreadRow.getByRole("img", {
        name: /Observed unread messages/,
      });
      await expect(dot).toBeVisible();
      const activity = unreadRow.getByRole("img", {
        name: "Owner-visible agent activity: working",
        exact: true,
      });
      await expect(activity).toBeVisible();
      const activityBox = await activity.boundingBox();
      const unreadBox = await dot.boundingBox();
      expect(activityBox.x + activityBox.width).toBeLessThanOrEqual(
        unreadBox.x,
      );
      // The shared workspace variant keeps selection without an underline.
      const selectedTab = page.getByRole("tab", {
        name: "Sessions",
        exact: true,
      });
      await expect(selectedTab).toHaveAttribute("aria-selected", "true");
      await expect(page.locator(".buzz-tabs-indicator")).toBeHidden();
      await expect(selectedTab).toHaveCSS("text-decoration-line", "none");
      // Routine history controls stay keyboard-reachable without occupying the list.
      const options = directory.locator("details");
      const summary = directory.getByText("History options", { exact: true });
      await expect(options).not.toHaveAttribute("open");
      await expect(
        directory.getByText(/Checked history · replies sampled/),
      ).toBeHidden();
      await summary.focus();
      await page.keyboard.press("Enter");
      await expect(options).toHaveAttribute("open", "");
      await expect(
        directory.getByText(/Checked history · replies sampled/),
      ).toBeVisible();
      // Capture the final host theme, not an in-flight button color transition.
      await page.mouse.move(0, 0);
      await expect
        .poll(() =>
          directory
            .getByRole("button", { name: "Refresh loaded history" })
            .evaluate((button) => {
              const probe = document.createElement("span");
              probe.style.color = "var(--text-standard)";
              probe.style.backgroundColor = "transparent";
              document.body.append(probe);
              const expected = getComputedStyle(probe);
              const actual = getComputedStyle(button);
              const settled =
                actual.color === expected.color &&
                actual.backgroundColor === expected.backgroundColor;
              probe.remove();
              return settled;
            }),
        )
        .toBe(true);
      await summary.click();
      await expect(options).not.toHaveAttribute("open");
      const sidebar = page.getByRole("complementary", {
        name: "Channel sidebar",
      });
      if (width <= 650)
        await page
          .getByRole("button", { name: "Toggle fixture navigation" })
          .click();
      const toggle = sidebar.getByRole("button", {
        name: "Expand sessions in General",
        exact: true,
      });
      await expect(toggle).toHaveAttribute("aria-expanded", "false");
      await expect(
        sidebar.getByRole("region", {
          name: "Your sessions in General",
          exact: true,
        }),
      ).toBeHidden();
      await page.screenshot({
        path: testInfo.outputPath(`sessions-collapsed-${width}-${mode}.png`),
      });
      await toggle.focus();
      await page.keyboard.press("Enter");
      const child = sidebar
        .getByRole("region", { name: "Your sessions in General", exact: true })
        .getByRole("button")
        .first();
      const personalUnread = sidebar
        .getByRole("region", { name: "Your sessions in General", exact: true })
        .getByRole("button", { name: /Review the release checklist/ })
        .getByRole("img", { name: /Observed unread messages/ });
      await expect(personalUnread).toBeVisible();
      const dotBox = await personalUnread.boundingBox();
      const titleBox = await personalUnread
        .locator("..")
        .locator("span")
        .nth(1)
        .boundingBox();
      const unreadButtonBox = await personalUnread.locator("..").boundingBox();
      expect(titleBox.x + titleBox.width).toBeLessThanOrEqual(dotBox.x);
      expect(dotBox.width).toBe(6);
      expect(dotBox.x + dotBox.width).toBeLessThanOrEqual(
        unreadButtonBox.x + unreadButtonBox.width,
      );
      const parent = sidebar.locator('[data-channel-id="general"]');
      const childBox = await child.boundingBox();
      const parentBox = await parent.locator("..").boundingBox();
      const childText = await child.locator("span").nth(1).boundingBox();
      const parentText = await parent.locator("span").nth(1).boundingBox();
      expect(childBox.x + childBox.width).toBeLessThanOrEqual(
        parentBox.x + parentBox.width + 1,
      );
      expect(childText.x).toBeGreaterThan(parentText.x);
      expect(
        await child
          .locator("span")
          .nth(1)
          .evaluate((el) => getComputedStyle(el).textOverflow),
      ).toBe("ellipsis");
      const all = sidebar
        .getByRole("region", { name: "Your sessions in General", exact: true })
        .getByRole("button", { name: "View all sessions" });
      await expect(all.getByRole("img")).toHaveCount(0);
      await expect(all).toHaveAttribute("aria-current", "page");
      const allBox = await all.boundingBox();
      await expect(child).toHaveCSS("border-top-width", "0px");
      await expect(child).toHaveCSS("border-radius", "0px");
      await expect(child).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
      await expect(child).toHaveCSS("font-size", "14px");
      await expect(child).toHaveCSS("font-weight", "400");
      await expect(child).toHaveCSS("padding-top", "4px");
      await expect(child).toHaveCSS("padding-bottom", "4px");
      await expect(child.locator("span").nth(1)).toHaveCSS(
        "text-decoration-line",
        "none",
      );
      const childBorder = await child.evaluate((element) =>
        parseFloat(getComputedStyle(element).borderLeftWidth),
      );
      expect(Math.abs(allBox.x + childBorder - childText.x)).toBeLessThan(1);
      expect(allBox.width).toBeLessThan(childBox.width - 20);
      await expect(all).toHaveAccessibleDescription(
        "From loaded history · may be incomplete",
      );
      await expect(all).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
      await expect(all).toHaveCSS("font-size", "14px");
      await expect(all).toHaveCSS("font-weight", "400");
      const colors = await all.evaluate(() => {
        const probe = document.createElement("span");
        document.body.append(probe);
        probe.style.color = "var(--text-metadata)";
        const metadata = getComputedStyle(probe).color;
        probe.style.color = "var(--text-subtle)";
        const secondary = getComputedStyle(probe).color;
        probe.remove();
        return { metadata, secondary };
      });
      await expect(all).toHaveCSS("color", colors.metadata);
      await expect(all).toHaveCSS("text-decoration-line", "none");
      await all.focus();
      await page.keyboard.press("ArrowLeft");
      await expect(all).toBeFocused();
      expect(await all.evaluate((el) => el.matches(":focus-visible"))).toBe(
        true,
      );
      await expect(all).toHaveCSS("color", colors.secondary);
      await expect(all).toHaveCSS("text-decoration-line", "none");
      await all.hover();
      await expect(all).toHaveCSS("color", colors.secondary);
      await expect(all).toHaveCSS("text-decoration-line", "none");
      await expect(all).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
      await page
        .getByRole("button", { name: "Toggle fixture navigation" })
        .focus();
      await page.mouse.move(0, 0);
      await expect(all).toHaveCSS("color", colors.metadata);
      if (width <= 650)
        await page
          .getByRole("button", { name: "Toggle fixture navigation" })
          .click();
      const firstRow = await directory
        .locator("li button")
        .first()
        .boundingBox();
      const directoryBox = await directory.boundingBox();
      expect(
        Math.abs(
          firstRow.x -
            directoryBox.x -
            (width > 1000 ? 32 : width > 650 ? 24 : 16),
        ),
      ).toBeLessThan(1);
      expect(firstRow.height).toBe(54);
      await page.screenshot({
        path: testInfo.outputPath(`sessions-${width}-${mode}.png`),
      });
      await directory
        .getByRole("button", { name: /Review the release checklist/ })
        .click();
      const detail = page.getByRole("complementary", {
        name: "Session",
        exact: true,
      });
      await expect(
        detail.getByRole("heading", { name: "Review the release checklist" }),
      ).toBeVisible();
      await expect
        .poll(() =>
          page.evaluate(() => window.sessionsFixture.threadSnapshot()?.status),
        )
        .toBe("ready");
      if (width <= 650)
        await page
          .getByRole("button", { name: "Toggle fixture navigation" })
          .click();
      await expect(all).not.toHaveAttribute("aria-current");
      const selectedChild = sidebar.locator(
        '[id^="personal-session-"][aria-current="page"]',
      );
      await expect(selectedChild.locator("span").nth(1)).toHaveCSS(
        "text-decoration-line",
        "none",
      );
      await expect(all).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
      await expect(all).toHaveCSS("font-weight", "400");
      await expect(all).toHaveCSS("color", colors.metadata);
      await expect(all).toHaveCSS("text-decoration-line", "none");
      await all.focus();
      await page.keyboard.press("ArrowLeft");
      await expect(all).toBeFocused();
      expect(await all.evaluate((el) => el.matches(":focus-visible"))).toBe(
        true,
      );
      await expect(all).toHaveCSS("color", colors.secondary);
      await page
        .getByRole("button", { name: "Toggle fixture navigation" })
        .focus();
      await all.hover();
      await expect(all).toHaveCSS("text-decoration-line", "none");
      await expect(all).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
      await expect(all).toHaveCSS("color", colors.secondary);
      await page
        .getByRole("button", { name: "Toggle fixture navigation" })
        .focus();
      await page.mouse.move(0, 0);
      await expect(all).toHaveCSS("color", colors.metadata);
      await expect(detail.getByText(/repl(?:y|ies) shown/)).toHaveCount(0);
      if (width <= 650)
        await page
          .getByRole("button", { name: "Toggle fixture navigation" })
          .click();
      const inset = width > 1000 ? 32 : width > 650 ? 24 : 16;
      expect(
        await detail.evaluate((element) => ({
          border: getComputedStyle(element).borderTopWidth,
          radius: getComputedStyle(element).borderTopLeftRadius,
          shadow: getComputedStyle(element).boxShadow,
        })),
      ).toEqual({ border: "0px", radius: "0px", shadow: "none" });
      // With inline activity the narrow history is taller than the viewport.
      // Initial bottom-follow remains ThreadPanel's contract; geometry below
      // measures the root after an explicit return to the start of history.
      const detailHistory = detail.getByRole("region", {
        name: "Session messages",
      });
      await expect
        .poll(() =>
          detailHistory.evaluate(
            (element) =>
              element.scrollHeight - element.clientHeight - element.scrollTop,
          ),
        )
        .toBeLessThan(2);
      await detailHistory.evaluate(async (element) => {
        if (!element.scrollTop) return;
        await new Promise((resolve) => {
          element.addEventListener("scroll", resolve, { once: true });
          element.scrollTop = 0;
        });
      });
      const box = await detail.boundingBox();
      const composer = await detail.locator("form").boundingBox();
      const root = await detail
        .locator("[data-message-id]")
        .first()
        .boundingBox();
      const title = await detail
        .getByRole("heading", { level: 2 })
        .boundingBox();
      expect(
        await detail.getByRole("heading", { level: 2 }).evaluate((element) => ({
          size: getComputedStyle(element).fontSize,
          leading: getComputedStyle(element).lineHeight,
        })),
      ).toEqual({ size: "16px", leading: "24px" });
      expect(
        await detail
          .getByRole("region", { name: "Session messages" })
          .evaluate((element) => element.scrollTop),
      ).toBe(0);

      expect(Math.abs(composer.x - box.x - inset)).toBeLessThan(1);
      expect(Math.abs(root.x - composer.x)).toBeLessThan(1);
      const detailHeader = detail.locator("header").first();
      await expect(detailHeader).toHaveCSS("border-bottom-width", "1px");
      await expect(detailHeader).toHaveCSS("border-bottom-style", "solid");
      const dividerColor = await detailHeader.evaluate((element) => {
        const probe = document.createElement("span");
        probe.style.color = "var(--border-standard)";
        element.append(probe);
        const color = getComputedStyle(probe).color;
        probe.remove();
        return color;
      });
      await expect(detailHeader).toHaveCSS("border-bottom-color", dividerColor);
      const detailHeaderBox = await detailHeader.boundingBox();
      expect(root.y).toBeGreaterThanOrEqual(
        detailHeaderBox.y + detailHeaderBox.height + 16,
      );
      expect(Math.abs(detailHeaderBox.x - root.x)).toBeLessThan(1);
      expect(root.y - title.y - title.height).toBeGreaterThanOrEqual(28);
      expect(root.y - title.y - title.height).toBeLessThanOrEqual(44);
      expect(
        Math.abs(box.y + box.height - composer.y - composer.height - 24),
      ).toBeLessThan(1);
      const heading = await page
        .getByRole("article", { name: "Conversation" })
        .locator(".panel-header")
        .boundingBox();
      const tabs = await page
        .getByRole("tablist", { name: "Channel views" })
        .boundingBox();
      const channelTitle = await page
        .getByRole("article", { name: "Conversation" })
        .locator("header")
        .first()
        .boundingBox();
      // Header identity and the view tabs share one line, even in narrow panels.
      const headerMinimum = await page
        .getByRole("article", { name: "Conversation" })
        .locator(".panel-header")
        .evaluate((element) => parseFloat(getComputedStyle(element).minHeight));
      expect(heading.height).toBeGreaterThanOrEqual(headerMinimum);
      expect(tabs.y).toBeGreaterThanOrEqual(channelTitle.y);
      expect(tabs.y + tabs.height).toBeLessThanOrEqual(
        channelTitle.y + channelTitle.height,
      );
      const nameBox = await page
        .getByRole("article", { name: "Conversation" })
        .locator(".panel-header h2")
        .boundingBox();
      expect(
        Math.abs(nameBox.y + nameBox.height / 2 - tabs.y - tabs.height / 2),
      ).toBeLessThan(1);
      expect(nameBox.x + nameBox.width).toBeLessThanOrEqual(tabs.x);
      expect(
        await detail.evaluate(
          (element) => element.scrollWidth <= element.clientWidth,
        ),
      ).toBe(true);
      const share = detail.getByRole("button", { name: "Share in channel" });
      const openThread = detail.getByRole("button", { name: "Open in thread" });
      for (const action of [share, openThread]) {
        await expect(action).toHaveText("");
        await expect(action).toBeInViewport();
      }
      const shareBox = await share.boundingBox();
      const openBox = await openThread.boundingBox();
      expect(openBox.x).toBeGreaterThanOrEqual(shareBox.x + shareBox.width);
      expect(openBox.y).toBe(shareBox.y);
      await share.hover();
      await expect(
        page.getByRole("tooltip", { name: "Share in channel", exact: true }),
      ).toBeVisible();
      await page.keyboard.press("Escape");
      await openThread.focus();
      await expect(
        page.getByRole("tooltip", { name: "Open in thread", exact: true }),
      ).toBeVisible();
      await page.keyboard.press("Escape");
      await page.screenshot({
        path: testInfo.outputPath(`session-detail-${width}-${mode}.png`),
      });
      await detail.getByRole("button", { name: "Back to Sessions" }).click();
      if (width <= 650)
        await page
          .getByRole("button", { name: "Toggle fixture navigation" })
          .click();
      await sidebar
        .getByRole("button", {
          name: "Collapse sessions in General",
          exact: true,
        })
        .click();
      if (width <= 650)
        await page
          .getByRole("button", { name: "Toggle fixture navigation" })
          .click();
    }
  }
  // Representative keyboard handoff through real host navigation; lease/failure
  // permutations and parent-document equality are exercised in React tests.
  await directory
    .getByRole("button", { name: /Review the release checklist/ })
    .click();
  const detail = page.getByRole("complementary", {
    name: "Session",
    exact: true,
  });
  const rootId = await page.evaluate(
    () => window.sessionsFixture.rows[0].rootId,
  );
  await expect(detail.locator("[data-message-id]").first()).toHaveAttribute(
    "data-message-id",
    rootId,
  );
  await detail.getByRole("button", { name: "Open in thread" }).focus();
  await page.keyboard.press("Enter");
  const ordinary = page.getByRole("complementary", {
    name: "Thread",
    exact: true,
  });
  await expect(ordinary.locator("[data-message-id]").first()).toHaveAttribute(
    "data-message-id",
    rootId,
  );
  await expect(detail).toHaveCount(0);
  await expect(
    page.getByRole("tab", { name: "Channel", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  expect(
    await page.evaluate(() => window.sessionsFixture.report.published),
  ).toEqual([]);
  await page.screenshot({
    path: testInfo.outputPath("session-open-in-thread.png"),
  });
});

// One added journey: native rich-editor mention selection/focus, independent draft
// navigation and quiet timeline geometry. Recovery permutations stay in Vitest.
test("header New session selects an agent explicitly, opens the shared thread and keeps its parent timeline quiet", async ({
  page,
}) => {
  const { errors } = watchPageErrors(page);
  await page.goto("/tests/fixtures/channel-sessions.html");
  const channel = page.getByRole("textbox", { name: "Message #General" });
  await expect(channel).toBeVisible();
  await channel.fill("Keep ordinary channel text");
  const newSession = page
    .getByRole("article", { name: "Conversation" })
    .getByRole("button", { name: "New session", exact: true });
  await newSession.focus();
  await page.keyboard.press("Enter");
  const draft = page.getByRole("textbox", {
    name: "Message this session",
  });
  await expect(
    page.getByRole("button", { name: "Back to Sessions" }),
  ).toBeFocused();
  await expect(draft).toHaveJSProperty("value", "");
  await expect(
    page.getByRole("tab", { name: "Sessions", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await draft.fill("@Fixture member just prose");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("alert")).toContainText(
    "Select at least one current channel agent",
  );
  expect(
    await page.evaluate(() => window.sessionsFixture.report.published.length),
  ).toBe(0);
  await page.getByRole("button", { name: "Back to Sessions" }).click();
  await expect(
    page.getByRole("tab", { name: "Sessions", exact: true }),
  ).toBeFocused();
  await page.getByRole("tab", { name: "Channel", exact: true }).click();
  await expect(channel).toHaveJSProperty("value", "Keep ordinary channel text");
  await newSession.click();
  await expect(draft).toHaveJSProperty("value", "@Fixture member just prose");
  await draft.fill("");
  await page
    .getByRole("button", { name: "Mention a member", exact: true })
    .click();
  const member = await page.evaluate(() => window.sessionsFixture.member);
  await page
    .getByRole("dialog", { name: "Mention a member or agent" })
    .getByRole("button", { name: `Fixture member ${member}`, exact: true })
    .click();
  await expect(draft).toBeFocused();
  await page.keyboard.type("Quiet shared investigation");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  const thread = page.getByRole("complementary", {
    name: "Session",
    exact: true,
  });
  await expect(thread).toBeVisible();
  await expect(
    thread.getByRole("button", { name: "Back to Sessions" }),
  ).toBeFocused();
  await expect(
    thread
      .getByRole("region", { name: "Session messages" })
      .getByText("Quiet shared investigation", { exact: false }),
  ).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(() => window.sessionsFixture.report.published.length),
    )
    .toBe(1);
  const root = await page.evaluate(
    () => window.sessionsFixture.report.published[0],
  );
  expect(root.tags).toContainEqual(["buzz-session", "1", "quiet"]);
  expect(root.tags).toContainEqual(["p", member]);
  expect(root.tags.some((tag) => tag[0] === "e")).toBe(false);
  await expect(thread.getByText(/repl(?:y|ies) shown/)).toHaveCount(0);
  const reply = thread.getByRole("textbox", { name: "Message this session" });
  await reply.fill("Ordinary followup with no implicit agent");
  await reply.press("Enter");
  await expect
    .poll(() =>
      page.evaluate(() => window.sessionsFixture.report.published.length),
    )
    .toBe(2);
  const followup = await page.evaluate(
    () => window.sessionsFixture.report.published[1],
  );
  expect(followup.tags).toContainEqual(["e", root.id, "", "reply"]);
  expect(
    followup.tags.some((tag) => tag[0] === "p" || tag[0] === "buzz-session"),
  ).toBe(false);
  await thread.getByRole("button", { name: "Back to Sessions" }).click();
  await expect(
    page
      .getByRole("region", { name: "Sessions", exact: true })
      .getByRole("button", { name: /Quiet shared investigation/ }),
  ).toBeVisible();
  await page.getByRole("tab", { name: "Channel", exact: true }).click();
  const history = page.getByRole("region", { name: "Channel message history" });
  await expect(history).toBeVisible();
  await expect(history.locator(`[data-message-id='${root.id}']`)).toHaveCount(
    0,
  );
  await expect(channel).toHaveJSProperty("value", "Keep ordinary channel text");
  await page.evaluate(() => window.sessionsFixture.disable());
  await expect(
    page.getByRole("tab", { name: "Sessions", exact: true }),
  ).toHaveCount(0);
  await expect(history.locator(`[data-message-id='${root.id}']`)).toBeVisible();
  await page.evaluate(() => window.sessionsFixture.enable());
  await expect(
    page.getByRole("tab", { name: "Sessions", exact: true }),
  ).toBeVisible();
  await expect(history.locator(`[data-message-id='${root.id}']`)).toHaveCount(
    0,
  );
  await newSession.click();
  for (const [width, mode] of [
    [1512, "light"],
    [1512, "dark"],
    [1280, "light"],
    [1280, "dark"],
    [740, "light"],
    [740, "dark"],
    [390, "light"],
    [390, "dark"],
  ]) {
    await page.setViewportSize({ width, height: width === 1512 ? 982 : 850 });
    await page.evaluate((mode) => {
      document.documentElement.dataset.colorMode = mode;
    }, mode);
    await expect(draft).toBeVisible();
    // Theme and tab transitions are real; wait for their final authored values
    // before evaluating screenshots rather than capturing transient light ink.
    await expect
      .poll(() =>
        page
          .getByRole("button", { name: "Back to Sessions" })
          .evaluate((button) => {
            const probe = document.createElement("span");
            probe.style.color = "var(--text-standard)";
            document.body.append(probe);
            const expected = getComputedStyle(probe).color;
            probe.remove();
            return getComputedStyle(button).color === expected;
          }),
      )
      .toBe(true);
    await expect(page.locator(".buzz-tabs-indicator")).toBeHidden();
    await expect(
      page.getByRole("tab", { name: "Sessions", exact: true }),
    ).toHaveAttribute("aria-selected", "true");
    const bounds = await draft.boundingBox();
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
    await page.screenshot({
      path: test.info().outputPath(`new-session-${width}-${mode}.png`),
    });
  }
  expect(errors).toEqual([]);
});

// One added browser-only contract: origin-wide Web Locks and localStorage across
// two actual pages with separate session/outbox owners. The claim is held until
// both native lock requests are queued; no timing race or journal mutation.
test("two windows share one creation claim and recover the same accepted root", async ({
  page,
  context,
}) => {
  const seeds = Array.from({ length: 4 }, () => [
    ...crypto.getRandomValues(new Uint8Array(32)),
  ]);
  await context.addInitScript((seeds) => {
    window.fixtureSeeds = seeds;
  }, seeds);
  const other = await context.newPage();
  const lockPage = await context.newPage();
  const reports = [page, other, lockPage].map(watchPageErrors);
  await Promise.all(
    [page, other, lockPage].map((p) =>
      p.goto("/tests/fixtures/channel-sessions.html"),
    ),
  );
  const member = await page.evaluate(() => window.sessionsFixture.member);
  const viewer = await page.evaluate(() => window.sessionsFixture.viewer);
  for (const p of [page]) {
    await p
      .getByRole("article", { name: "Conversation" })
      .getByRole("button", { name: "New session", exact: true })
      .click();
    await p
      .getByRole("button", { name: "Mention a member", exact: true })
      .click();
    await p
      .getByRole("dialog", { name: "Mention a member or agent" })
      .getByRole("button", { name: `Fixture member ${member}`, exact: true })
      .click();
    await p.keyboard.type("One cross-window investigation");
  }
  await other
    .getByRole("article", { name: "Conversation" })
    .getByRole("button", { name: "New session", exact: true })
    .click();
  await expect(
    other.getByRole("textbox", { name: "Message this session" }),
  ).toContainText("One cross-window investigation");
  for (const p of [page, other])
    await expect(
      p.getByRole("button", { name: "Send message", exact: true }),
    ).toBeEnabled();
  const scope = await page.evaluate(() => window.sessionsFixture.scope);
  const lockName = `buzz-channel-session:${JSON.stringify([scope, "general", viewer])}`;
  await lockPage.evaluate(async (name) => {
    let entered;
    const started = new Promise((resolve) => {
      entered = resolve;
    });
    window.claimLock = navigator.locks.request(name, async () => {
      entered();
      await new Promise((resolve) => {
        window.releaseClaim = resolve;
      });
    });
    await started;
  }, lockName);
  await page.evaluate(() => {
    window.publicationGate = window.sessionsFixture.holdPublication();
  });
  await other.evaluate(() => {
    window.publicationGate = window.sessionsFixture.holdPublication();
  });
  let saved;
  try {
    await Promise.all(
      [page, other].map((p) =>
        p.getByRole("button", { name: "Send message", exact: true }).click(),
      ),
    );
    await expect
      .poll(() =>
        lockPage.evaluate(
          async (name) =>
            (await navigator.locks.query()).pending.filter(
              (lock) => lock.name === name,
            ).length,
          lockName,
        ),
      )
      .toBe(2);
    await lockPage.evaluate(async () => {
      window.releaseClaim();
      await window.claimLock;
    });
    await expect
      .poll(async () => {
        const statuses = await Promise.all(
          [page, other].map((p) => p.getByRole("alert").allTextContents()),
        );
        return statuses
          .flat()
          .filter((text) => text.includes("Recover the saved session prompt"))
          .length;
      })
      .toBe(1);
    saved = await page.evaluate(() => window.sessionsFixture.saved());
    expect(saved).toBeDefined();
    expect(await other.evaluate(() => window.sessionsFixture.saved())).toEqual(
      saved,
    );
    expect(
      (
        await Promise.all(
          [page, other].map((p) =>
            p.evaluate(() => window.sessionsFixture.report.published),
          ),
        )
      ).flat(),
    ).toEqual([]);
  } finally {
    await lockPage.evaluate(() => window.releaseClaim());
    await Promise.all(
      [page, other].map((p) =>
        p.evaluate(() => window.publicationGate.release()),
      ),
    );
  }
  await expect
    .poll(
      async () =>
        (
          await Promise.all(
            [page, other].map((p) =>
              p.evaluate(() => window.sessionsFixture.report.published),
            ),
          )
        ).flat().length,
    )
    .toBe(1);
  const publications = await Promise.all(
    [page, other].map((p) =>
      p.evaluate(() => window.sessionsFixture.report.published),
    ),
  );
  const root = publications.flat()[0];
  expect(root.tags).toContainEqual(["client-id", saved.id]);
  const winner = publications[0].length ? page : other;
  const loser = publications[0].length ? other : page;
  await expect(
    winner.getByRole("complementary", { name: "Session", exact: true }),
  ).toBeVisible();
  // Deliver the same verified relay event to the other isolated RAM transport;
  // recovery checks relay evidence, not a forged app journal.
  await loser.evaluate((root) => window.sessionsFixture.ingest([root]), root);
  await loser.getByRole("button", { name: "Check saved session" }).click();
  await expect(
    loser.getByRole("complementary", { name: "Session", exact: true }),
  ).toBeVisible();
  await expect(
    loser
      .getByRole("complementary", { name: "Session", exact: true })
      .getByRole("region", { name: "Session messages" })
      .getByText("One cross-window investigation", { exact: false }),
  ).toBeVisible();
  expect(
    (
      await Promise.all(
        [page, other].map((p) =>
          p.evaluate(() => window.sessionsFixture.report.published),
        ),
      )
    )
      .flat()
      .map((event) => event.id),
  ).toEqual([root.id]);
  // Reopen both editors for a second legitimate draft. This phase tests an
  // already-cleaned-up claim; the first phase covers native lock contention.
  for (const p of [page, other]) {
    await p
      .getByRole("complementary", { name: "Session", exact: true })
      .getByRole("button", { name: "Back to Sessions" })
      .click();
  }
  await page
    .getByRole("article", { name: "Conversation" })
    .getByRole("button", { name: "New session", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Mention a member", exact: true })
    .click();
  await page
    .getByRole("dialog", { name: "Mention a member or agent" })
    .getByRole("button", { name: `Fixture member ${member}`, exact: true })
    .click();
  await page.keyboard.type("Cleanup before stale claim");
  await other
    .getByRole("article", { name: "Conversation" })
    .getByRole("button", { name: "New session", exact: true })
    .click();
  for (const p of [page, other])
    await expect(
      p.getByRole("button", { name: "Send message", exact: true }),
    ).toBeEnabled();
  await page.evaluate(() => {
    window.publicationGate = window.sessionsFixture.holdPublication();
  });
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await page.evaluate(() => window.publicationGate.started);
  await expect
    .poll(() => page.evaluate(() => window.sessionsFixture.saved()?.messageId))
    .toBeTruthy();
  const staleEditor = other.getByRole("textbox", {
    name: "Message this session",
  });
  const unchangedPrompt = await staleEditor.textContent();
  expect(unchangedPrompt).toContain("Cleanup before stale claim");
  // Web Locks order callbacks, but a pending-count snapshot is not evidence
  // that another page has observed localStorage cleanup. WebKit can still read
  // the saved record after the winner's cleanup callback returned true. Wait
  // for the actual cross-window storage boundary before testing absent-record
  // generation rejection; do not turn a valid recovery response into a flake.
  try {
    await page.evaluate(() => window.publicationGate.release());
    await expect(
      page.getByRole("complementary", { name: "Session", exact: true }),
    ).toBeVisible();
    for (const p of [page, other])
      await expect
        .poll(() => p.evaluate(() => window.sessionsFixture.saved()))
        .toBeUndefined();
    await expect(staleEditor).toHaveText(unchangedPrompt);
    await other
      .getByRole("button", { name: "Send message", exact: true })
      .click();
  } finally {
    await page.evaluate(() => window.publicationGate.release());
  }
  await expect(other.getByRole("alert")).toContainText("editor is stale");
  await expect(
    page.getByRole("complementary", { name: "Session", exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(() => window.sessionsFixture.saved()),
  ).toBeUndefined();
  const all = (
    await Promise.all(
      [page, other].map((p) =>
        p.evaluate(() => window.sessionsFixture.report.published),
      ),
    )
  ).flat();
  expect(all).toHaveLength(2); // One root for each genuine opening, no stale replacement.
  expect(
    all.filter((event) => event.content.includes("Cleanup before stale claim")),
  ).toHaveLength(1);
  expect(reports.flatMap((report) => report.errors)).toEqual([]);
});

// New browser boundary: real contenteditable chip/caret, clipboard source and
// undo after the editor DOM is removed, plus signed publication wiring.
test("Share in channel keeps the draft and exact recipients, edits one canonical chip and sends only on explicit Send", async ({
  page,
}, testInfo) => {
  const { errors } = watchPageErrors(page);
  await page.goto("/tests/fixtures/channel-sessions.html?share");
  const input = page.getByRole("textbox", { name: "Message #General" });
  await expect(input).toBeVisible();
  await input.fill("Some context ");
  await input.evaluate((element) => element.setSelectionRange(0, 12));
  await page.keyboard.press("ControlOrMeta+b");
  await expect(input.locator("strong")).toHaveText("Some context");
  await input.evaluate((element) =>
    element.setSelectionRange(element.value.length, element.value.length),
  );
  const recipient = await page.evaluate(() => window.sessionsFixture.viewer);
  const rootAgent = await page.evaluate(() => window.sessionsFixture.member);
  await page
    .getByRole("button", { name: "Mention a member", exact: true })
    .click();
  await page
    .getByRole("dialog", { name: "Mention a member or agent" })
    .getByRole("button", { name: `Fixture reader ${recipient}`, exact: true })
    .click();
  const before = await input.evaluate((element) => element.value);
  // Sharing ignores this native selection; undo restores it with the rich doc.
  await input.evaluate((element) => element.setSelectionRange(0, 4));
  await page.getByRole("tab", { name: "Sessions", exact: true }).click();
  await expect(input).toHaveCount(0);
  await page
    .getByRole("region", { name: "Sessions", exact: true })
    .getByRole("button", { name: /Review the release checklist/ })
    .click();
  const detail = page.getByRole("complementary", {
    name: "Session",
    exact: true,
  });
  await expect(
    detail.getByRole("heading", { name: "Review the release checklist" }),
  ).toBeVisible();
  for (const width of [390, 740, 1280]) {
    await page.setViewportSize({ width, height: 850 });
    await expect(
      detail.getByRole("button", { name: "Share in channel" }),
    ).toBeInViewport();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(width);
  }
  // Native focus regression: the ordinary routed thread must not revive when
  // sharing after re-entering Sessions. The retained rich draft/mentions survive.
  await detail.getByRole("button", { name: "Open in thread" }).click();
  const ordinaryThread = page.getByRole("complementary", {
    name: "Thread",
    exact: true,
  });
  await expect(
    ordinaryThread.getByText(
      "Fixture reply for task 1. The conversation stays in its original thread.",
    ),
  ).toBeVisible();
  await expect(input).toHaveJSProperty("value", before);
  await page.getByRole("tab", { name: "Sessions", exact: true }).click();
  await page
    .getByRole("region", { name: "Sessions", exact: true })
    .getByRole("button", { name: /Review the release checklist/ })
    .click();
  await expect(
    detail.getByRole("heading", { name: "Review the release checklist" }),
  ).toBeVisible();
  // The real reader reports a failed source refresh; Share must not use stale
  // source evidence or mutate the retained channel draft.
  await page.evaluate(async () => {
    window.sessionsFixture.failThread(true);
    await window.sessionsFixture.refreshThread();
  });
  await expect(
    detail.getByText("Fixture thread read failed", { exact: false }),
  ).toBeVisible();
  await detail.getByRole("button", { name: "Share in channel" }).click();
  await expect(detail.locator("header").getByRole("alert")).toContainText(
    "unavailable",
  );
  expect(
    await page.evaluate(() => window.sessionsFixture.report.published),
  ).toEqual([]);
  await page.evaluate(async () => {
    window.sessionsFixture.failThread(false);
    await window.sessionsFixture.refreshThread();
  });
  await expect
    .poll(() =>
      page.evaluate(() => window.sessionsFixture.threadSnapshot()?.status),
    )
    .toBe("ready");
  await detail.getByRole("button", { name: "Share in channel" }).click();
  await expect(detail).toHaveCount(0);
  await expect(input).toBeFocused();
  await expect(ordinaryThread).toHaveCount(0);
  await expect(
    page.getByRole("tab", { name: "Channel", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  expect(
    await page.evaluate(() => window.sessionsFixture.report.published),
  ).toEqual([]);
  const shared = await input.evaluate((element) => element.value);
  expect(shared.startsWith(before)).toBe(true);
  await expect(input.locator("strong")).toHaveText("Some context");
  await expect(input.locator('[data-source*="buzz:"]')).toHaveCount(1);
  await expect(input.locator('[data-link-kind="session"]')).toHaveCount(1);
  await expect(input.locator("a,button")).toHaveCount(0);
  expect(await input.evaluate((element) => element.selectionStart)).toBe(
    shared.length,
  );
  await page.keyboard.press("ControlOrMeta+z");
  await expect(input).toHaveJSProperty("value", before);
  await expect(input.locator("strong")).toHaveText("Some context");
  expect(
    await input.evaluate((element) => [
      element.selectionStart,
      element.selectionEnd,
    ]),
  ).toEqual([0, 4]);
  await page.keyboard.press("ControlOrMeta+Shift+z");
  await expect(input).toHaveJSProperty("value", shared);
  for (const width of [390, 740, 1280]) {
    await page.setViewportSize({ width, height: 850 });
    for (const mode of ["light", "dark"]) {
      await page.evaluate(
        (mode) =>
          document.documentElement.setAttribute("data-color-mode", mode),
        mode,
      );
      await expect(input.locator('[data-source*="buzz:"]')).toBeVisible();
      await expect
        .poll(() =>
          input.evaluate((element) => ({
            scroll: element.scrollWidth,
            client: element.clientWidth,
            chip: element
              .querySelector('[data-source*="buzz:"]')
              .getBoundingClientRect().width,
            fits: element.scrollWidth <= element.clientWidth,
          })),
        )
        .toMatchObject({ fits: true });
      await page.screenshot({
        path: testInfo.outputPath(`share-${width}-${mode}.png`),
      });
    }
  }
  const clipboard = await input.evaluate((element) => {
    element.setSelectionRange(0, element.value.length);
    const clipboardData = new DataTransfer();
    element.dispatchEvent(
      new ClipboardEvent("copy", {
        clipboardData,
        bubbles: true,
        cancelable: true,
      }),
    );
    element.setSelectionRange(element.value.length, element.value.length);
    return clipboardData.getData("text/plain");
  });
  expect(clipboard).toBe(shared.replace("Some context", "**Some context**"));
  // Paste the copied canonical source over itself using the actual editor path.
  // Replacing only the link (not the mention) preserves exact recipient intent.
  const reference = shared.slice(before.length).trim();
  await input.evaluate((element, reference) => {
    const start = element.value.indexOf(reference);
    element.setSelectionRange(start, start + reference.length);
    const clipboardData = new DataTransfer();
    clipboardData.setData("text/plain", reference);
    element.dispatchEvent(
      new ClipboardEvent("paste", {
        clipboardData,
        bubbles: true,
        cancelable: true,
      }),
    );
  }, reference);
  await expect(input).toHaveJSProperty("value", shared);
  await expect(input.locator('[data-source*="buzz:"]')).toHaveCount(1);
  // Double-click selects the complete source token for native replacement.
  await input.locator('[data-source*="buzz:"]').dblclick();
  expect(
    await input.evaluate((element) =>
      element.value.slice(element.selectionStart, element.selectionEnd),
    ),
  ).toBe(reference);
  await page.keyboard.insertText(reference.replace("Review", "Revised Review"));
  await expect(input).toHaveJSProperty(
    "value",
    shared.replace("Review", "Revised Review"),
  );
  await expect(input.locator('[data-source*="buzz:"]')).toHaveText(
    /^Session · [a-f0-9]{8}Revised Review the release checklist$/,
  );
  await page.keyboard.press("ControlOrMeta+z");
  await expect(input).toHaveJSProperty("value", shared);
  await input.evaluate((element) =>
    element.setSelectionRange(element.value.length, element.value.length),
  );
  // Native typing immediately after restored chip must remain after its source.
  await page.keyboard.type("Please review.");
  await expect(input).toHaveJSProperty("value", `${shared}Please review.`);
  const href = shared.match(/\]\((buzz:[^)]+)\)/)?.[1];
  expect(href).toBeTruthy();
  const url = new URL(href);
  const root = await page.evaluate(() => window.sessionsFixture.rows[0].rootId);
  expect(url.protocol).toBe("buzz:");
  expect(url.hostname).toBe("message");
  expect([...url.searchParams]).toEqual([
    ["channel", "general"],
    ["id", root],
    ["thread", root],
  ]);
  expect(
    await page.evaluate(() => window.sessionsFixture.report.published),
  ).toEqual([]);
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(() => window.sessionsFixture.report.published.length),
    )
    .toBe(1);
  const [event] = await page.evaluate(
    () => window.sessionsFixture.report.published,
  );
  expect(event.kind).toBe(9);
  expect(event.content).toBe(
    `${shared.replace("Some context", "**Some context**")}Please review.`,
  );
  expect(event.tags.filter((tag) => tag[0] === "p")).toEqual([
    ["p", recipient],
  ]);
  expect(event.tags).not.toContainEqual(["p", rootAgent]);
  expect(event.tags.filter((tag) => tag[0] === "h")).toEqual([
    ["h", "general"],
  ]);
  expect(
    event.tags.filter((tag) => ["e", "a", "session"].includes(tag[0])),
  ).toEqual([]);
  await expect(input).toHaveJSProperty("value", "");
  await expect(
    page.locator(`[data-message-id="${event.id}"] [data-link-kind="session"]`),
  ).toBeVisible();
  const publishedChip = page.locator(
    `[data-message-id="${event.id}"] [data-link-kind="session"]`,
  );
  await expect(publishedChip).toContainText(`Session · ${root.slice(0, 8)}`);
  await expect(publishedChip).toHaveAttribute(
    "title",
    `Session · ${root}: Review the release checklist`,
  );
  // Browser-only: measure the published host anchor as well as the inert editor
  // chip. Both must stay unlined and fit narrow layouts in either color mode.
  for (const width of [390, 740, 1280]) {
    await page.setViewportSize({ width, height: 850 });
    for (const mode of ["light", "dark"]) {
      await page.evaluate(
        (mode) => (document.documentElement.dataset.colorMode = mode),
        mode,
      );
      await expect(publishedChip).toBeVisible();
      await expect
        .poll(() =>
          publishedChip.evaluate((chip) => {
            const anchor = chip.closest("a");
            const preview = chip.lastElementChild;
            return {
              decoration: getComputedStyle(anchor).textDecorationLine,
              display: getComputedStyle(chip).display,
              wrap: getComputedStyle(preview).whiteSpace,
              overflow: getComputedStyle(preview).textOverflow,
              fits:
                chip.getBoundingClientRect().right <=
                document.documentElement.clientWidth,
            };
          }),
        )
        .toEqual({
          decoration: "none",
          display: "inline-flex",
          wrap: "nowrap",
          overflow: "ellipsis",
          fits: true,
        });
      await page.screenshot({
        path: testInfo.outputPath(`published-share-${width}-${mode}.png`),
      });
    }
  }
  await publishedChip.click();
  await expect(
    page.getByRole("complementary", { name: "Thread", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("complementary", { name: "Session", exact: true }),
  ).toHaveCount(0);
  expect(errors).toEqual([]);
});

// New browser boundary: two real pages share localStorage, but not editor state.
test("sharing does not overwrite a channel draft changed in another window", async ({
  page,
  context,
}) => {
  const seeds = Array.from({ length: 4 }, (_, index) =>
    Array.from({ length: 32 }, (_, byte) => (index + 17 + byte) % 255),
  );
  await context.addInitScript((seeds) => {
    window.fixtureSeeds = seeds;
  }, seeds);
  const other = await context.newPage();
  try {
    await Promise.all(
      [page, other].map((p) =>
        p.goto("/tests/fixtures/channel-sessions.html?share"),
      ),
    );
    const local = page.getByRole("textbox", { name: "Message #General" });
    await local.fill("Local context");
    await page.getByRole("tab", { name: "Sessions", exact: true }).click();
    await page
      .getByRole("region", { name: "Sessions", exact: true })
      .getByRole("button", { name: /Review the release checklist/ })
      .click();
    await expect(
      page.getByRole("heading", { name: "Review the release checklist" }),
    ).toBeVisible();
    // Observe actual storage propagation before invoking Share; no timer races.
    await page.evaluate(() => {
      window.draftChanged = new Promise((resolve) => {
        window.addEventListener("storage", function changed(event) {
          if (
            event.key?.includes("draft:general") &&
            event.newValue?.includes("Other window context")
          ) {
            window.removeEventListener("storage", changed);
            resolve();
          }
        });
      });
    });
    await other
      .getByRole("textbox", { name: "Message #General" })
      .fill("Other window context");
    await page.evaluate(() => window.draftChanged);
    await page.getByRole("button", { name: "Share in channel" }).click();
    await expect(page.getByRole("alert")).toContainText(
      "changed in another window",
    );
    await expect(
      page.getByRole("complementary", { name: "Session", exact: true }),
    ).toBeVisible();
    const persisted = await page.evaluate(() =>
      localStorage.getItem(
        `buzz-view.v1:${JSON.stringify([window.sessionsFixture.scope, "draft:general"])}`,
      ),
    );
    expect(JSON.parse(persisted).text).toBe("Other window context");
    await page.getByRole("tab", { name: "Channel", exact: true }).click();
    await expect(local).toHaveJSProperty("value", "Local context");
    const conflict = page.getByRole("region", {
      name: "Channel draft conflict",
    });
    await expect(
      conflict.getByText("Other window context", { exact: true }),
    ).toBeVisible();
    await expect(local).toHaveAttribute("aria-disabled", "true");
    await local.focus();
    await page.keyboard.type("must not overwrite");
    await expect(local).toHaveJSProperty("value", "Local context");
    expect(
      await page.evaluate(() =>
        localStorage.getItem(
          `buzz-view.v1:${JSON.stringify([window.sessionsFixture.scope, "draft:general"])}`,
        ),
      ),
    ).toBe(persisted);
    await conflict.getByRole("button", { name: "Load saved draft" }).click();
    await expect(local).toHaveJSProperty("value", "Other window context");
    await expect(local).toBeFocused();
    await page.keyboard.press("ControlOrMeta+z");
    await expect(local).toHaveJSProperty("value", "Local context");
    await page.keyboard.press("ControlOrMeta+Shift+z");
    await expect(local).toHaveJSProperty("value", "Other window context");
    await page.getByRole("tab", { name: "Sessions", exact: true }).click();
    await page
      .getByRole("region", { name: "Sessions", exact: true })
      .getByRole("button", { name: /Review the release checklist/ })
      .click();
    await page.getByRole("button", { name: "Share in channel" }).click();
    await expect
      .poll(() => local.evaluate((element) => element.value))
      .toContain("Other window context [Session");
    expect(
      await page.evaluate(() => window.sessionsFixture.report.published),
    ).toEqual([]);
  } finally {
    await other.close();
  }
});

// Browser boundary: real plugin/host command wiring and native rich-editor
// mention intent, command-hint layout/focus, navigation and chip-vs-transcript
// DOM in both engines. Recognition permutations belong to the mounted unit test.
test("channel /session publishes one actual chip root, opens Sessions, and the retained editor can start again", async ({
  page,
}) => {
  const { errors } = watchPageErrors(page);
  await page.clock.setFixedTime(new Date("2026-09-21T14:00:00Z"));
  await page.goto("/tests/fixtures/channel-sessions.html?share");
  const input = page.getByRole("textbox", { name: "Message #General" });
  await expect(input).toBeVisible();
  const member = await page.evaluate(() => window.sessionsFixture.member);
  const prompt =
    "Investigate the launch carefully. ".repeat(8) +
    "Transcript-only tail https://images.example/prompt.png";
  const hint = page.getByRole("status").filter({ hasText: "New session" });
  await input.fill("/session");
  await expect(hint).toContainText("Select an @agent and add a prompt.");
  await expect(input).toBeFocused();
  await expect(input).toHaveJSProperty("value", "/session");
  await expect(input).toHaveJSProperty("selectionStart", 8);
  await expect(
    page.getByRole("tab", { name: "Channel", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  // Native editing remains the editor's; feedback is not a completion.
  await page.keyboard.type("foo");
  await expect(hint).toHaveCount(0);
  await expect(input).toHaveJSProperty("value", "/sessionfoo");
  await input.fill("/session");
  for (const width of [390, 740, 1280]) {
    await page.setViewportSize({ width, height: 850 });
    for (const mode of ["light", "dark"]) {
      await page.evaluate((mode) => {
        document.documentElement.dataset.colorMode = mode;
      }, mode);
      await expect(hint).toBeVisible();
      await expect
        .poll(() =>
          hint.evaluate((element) => {
            const probe = document.createElement("span");
            probe.style.color = "var(--text-subtle)";
            document.body.append(probe);
            const expected = getComputedStyle(probe).color;
            probe.remove();
            return getComputedStyle(element).color === expected;
          }),
        )
        .toBe(true);
      const bounds = await hint.boundingBox();
      const editor = await input.boundingBox();
      expect(bounds.x).toBeGreaterThanOrEqual(0);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
      expect(bounds.y + bounds.height).toBeLessThanOrEqual(editor.y);
      await expect
        .poll(() =>
          hint.evaluate(
            (element) => element.scrollWidth <= element.clientWidth,
          ),
        )
        .toBe(true);
      await page.screenshot({
        path: test
          .info()
          .outputPath(`session-command-hint-${width}-${mode}.png`),
      });
    }
  }
  await expect(input).toBeFocused();
  await input.fill("");
  await expect(hint).toHaveCount(0);
  expect(
    await page.evaluate(() => window.sessionsFixture.report.published),
  ).toEqual([]);
  await expect(
    page.getByRole("complementary", { name: "Session", exact: true }),
  ).toHaveCount(0);
  await page.setViewportSize({ width: 1440, height: 950 });
  const compose = async (body) => {
    await input.fill("/session ");
    await expect(hint).toContainText("Select an @agent and add a prompt.");
    await expect(input).toBeFocused();
    await expect(input).toHaveJSProperty("value", "/session ");
    await input.press("End");
    await page
      .getByRole("button", { name: "Mention a member", exact: true })
      .click();
    await page
      .getByRole("dialog", { name: "Mention a member or agent" })
      .getByRole("button", { name: `Fixture member ${member}`, exact: true })
      .click();
    await page.keyboard.type(body);
  };
  await compose(prompt);
  await page.evaluate(() => {
    window.publicationGate = window.sessionsFixture.holdPublication();
    window.publicationStarted = false;
    window.publicationGate.started.then(() => {
      window.publicationStarted = true;
    });
  });
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  try {
    await expect
      .poll(() =>
        page.evaluate(() => ({
          started: window.publicationStarted,
          error: document.querySelector('[role="alert"]')?.textContent ?? null,
        })),
      )
      .toEqual({ started: true, error: null });
    await expect(input).toHaveAttribute("contenteditable", "false");
    await expect(hint).toHaveCount(0);
    await expect(
      page.getByRole("complementary", { name: "Session", exact: true }),
    ).toHaveCount(0);
  } finally {
    await page.evaluate(() => window.publicationGate.release());
  }
  const session = page.getByRole("complementary", {
    name: "Session",
    exact: true,
  });
  await expect(session).toBeVisible();
  await expect(
    session.getByRole("region", { name: "Session messages" }),
  ).toContainText("Transcript-only tail");
  const root = await page.evaluate(
    () => window.sessionsFixture.report.published[0],
  );
  expect(root.kind).toBe(9);
  expect(root.content).toBe(`@Fixture member ${prompt}`);
  expect(root.tags.filter(([name]) => name === "p")).toEqual([["p", member]]);
  expect(root.tags).toContainEqual(["h", "general"]);
  expect(root.tags).toContainEqual(["buzz-session", "1", "chip"]);
  expect(root.tags.some(([name]) => name === "e")).toBe(false);
  await session.getByRole("button", { name: "Back to Sessions" }).click();
  await page.getByRole("tab", { name: "Channel", exact: true }).click();
  await expect(input).toHaveJSProperty("value", "");
  const chipRow = page.locator(
    `[data-message-id="${root.id}"][data-session-chip]`,
  );
  await expect(chipRow).toBeVisible();
  await expect(chipRow.locator('[data-link-kind="session"]')).toHaveCount(1);
  await expect(chipRow).not.toContainText("Transcript-only tail");
  await expect(
    chipRow.locator(
      'a[href="https://images.example/prompt.png"], img[src="https://images.example/prompt.png"]',
    ),
  ).toHaveCount(0);
  // Existing canonical link route is deliberately still the ordinary Thread.
  await chipRow.locator('[data-link-kind="session"]').click();
  await expect(
    page.getByRole("complementary", { name: "Thread", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Close thread" }).click();
  await compose("Second prompt from the same retained editor");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(session).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(() => window.sessionsFixture.report.published.length),
    )
    .toBe(2);
  const roots = await page.evaluate(
    () => window.sessionsFixture.report.published,
  );
  expect(new Set(roots.map((event) => event.id)).size).toBe(2);
  expect(
    roots.every((event) =>
      event.tags.some((tag) => tag.join(":") === "buzz-session:1:chip"),
    ),
  ).toBe(true);
  expect(errors).toEqual([]);
});

// Browser-only boundary: real plugin/reader wiring, animated Base UI keyboard
// disclosure and native scrolling while owner telemetry resizes above a reader.
test("inline owner activity preserves the native reading anchor and lazy keyboard disclosure", async ({
  page,
}, testInfo) => {
  await page.clock.setFixedTime(new Date("2026-09-21T14:00:00Z"));
  await page.goto("/tests/fixtures/channel-sessions.html?inline");
  await expect(
    page.getByRole("textbox", { name: "Message #General" }),
  ).toBeVisible();
  await page.getByRole("tab", { name: "Sessions", exact: true }).click();
  const directory = page.getByRole("region", { name: "Sessions", exact: true });
  await expect(directory.getByText("Checking threads for agents…")).toHaveCount(
    0,
  );
  await directory
    .getByRole("button", { name: /Review the release checklist/ })
    .click();
  const history = page.getByRole("region", { name: "Session messages" });
  await expect
    .poll(() =>
      page.evaluate(() => {
        const s = window.sessionsFixture.threadSnapshot();
        return s?.status === "ready" && !s.canLoadMore;
      }),
    )
    .toBe(true);
  await expect(history.locator("[data-message-id]")).toHaveCount(29);
  await page.evaluate(() => window.sessionsFixture.enableActivity());
  await expect
    .poll(() =>
      page.evaluate(() => window.sessionsFixture.activityState().status),
    )
    .toBe("listening");
  const baseline = await page.evaluate(() => {
    const r = window.sessionsFixture.report;
    return {
      queries: r.queries.length,
      readers: r.readers,
      active: r.activeReaders,
      published: r.published.length,
      controls: r.observerControls.length,
    };
  });
  await page.evaluate(() => {
    const f = window.sessionsFixture;
    f.telemetry("turn_started", [f.rows[1].rootId], "other");
    f.telemetry("turn_started", [f.rows[0].rootId]);
    f.telemetry("acp_read", [], "fixture-turn", {
      text: "<img src=x onerror=alert(1)>",
    });
  });
  const activity = history.getByRole("region", {
    name: "Session agent activity",
  });
  const toggle = activity.getByRole("button", {
    name: "Agent activity",
    exact: true,
  });
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(activity.locator("pre")).toHaveCount(0);
  await history.evaluate(async (element) => {
    await new Promise((resolve) => {
      element.addEventListener("scroll", resolve, { once: true });
      element.scrollTop = 0;
    });
  });
  await toggle.focus();
  await page.keyboard.press("Enter");
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(activity.getByText("turn_started", { exact: true })).toHaveCount(
    1,
  );
  const details = activity
    .getByRole("button", { name: "Details", exact: true })
    .nth(1);
  await details.focus();
  await page.keyboard.press("Enter");
  await expect(activity.locator("pre")).toContainText(
    "<img src=x onerror=alert(1)>",
  );
  await expect(
    activity.locator("img, script, [data-message-id], time"),
  ).toHaveCount(0);
  // Settle the actual transitions, without disabling animation or a fixed sleep.
  const settle = () =>
    activity.evaluate(async (element) => {
      await new Promise(requestAnimationFrame);
      await Promise.all(
        element
          .getAnimations({ subtree: true })
          .map((animation) => animation.finished),
      );
      await new Promise(requestAnimationFrame);
    });
  await settle();
  const box = await activity.boundingBox();
  const root = await history.locator("[data-message-id]").first().boundingBox();
  const reply = await history.locator("[data-message-id]").nth(1).boundingBox();
  expect(box.y).toBeGreaterThanOrEqual(root.y + root.height);
  expect(box.y + box.height).toBeLessThanOrEqual(reply.y);
  await page.screenshot({ path: testInfo.outputPath("inline-wide-light.png") });
  // Mid-history (not following bottom): changing the accessory above the
  // viewport must preserve an actual visible reply, not merely scrollTop.
  const anchor = history.locator("[data-message-id]").nth(8);
  await anchor.evaluate(async (row) => {
    const element = row.closest('[aria-label="Session messages"]');
    await new Promise((resolve) => {
      element.addEventListener("scroll", resolve, { once: true });
      element.scrollTop +=
        row.getBoundingClientRect().top - element.getBoundingClientRect().top;
    });
  });
  const before = await anchor.boundingBox();
  const scrollBefore = await history.evaluate((element) => ({
    top: element.scrollTop,
    height: element.scrollHeight,
    client: element.clientHeight,
  }));
  expect(
    scrollBefore.height - scrollBefore.client - scrollBefore.top,
  ).toBeGreaterThan(80);
  await page.evaluate(() =>
    window.sessionsFixture.telemetry("batch", [], "fixture-turn", {
      events: Array.from({ length: 4 }, () => ({
        kind: "acp_write",
        turnId: "fixture-turn",
        channelId: "general",
        payload: "Reading remains anchored",
      })),
    }),
  );
  await expect(activity.getByText("acp_write", { exact: true })).toHaveCount(4);
  await settle();
  await expect
    .poll(async () => Math.abs((await anchor.boundingBox()).y - before.y))
    .toBeLessThan(2);
  expect(
    await page.evaluate(() => {
      const r = window.sessionsFixture.report;
      return {
        queries: r.queries.length,
        readers: r.readers,
        active: r.activeReaders,
        published: r.published.length,
        controls: r.observerControls.length,
      };
    }),
  ).toEqual(baseline);
  await page.evaluate(() => window.sessionsFixture.disableActivity());
  await expect(activity).toHaveCount(0);
  await expect
    .poll(async () => Math.abs((await anchor.boundingBox()).y - before.y))
    .toBeLessThan(2);
  await page.evaluate(() => window.sessionsFixture.enableActivity());
  await expect
    .poll(() =>
      page.evaluate(() => window.sessionsFixture.activityState().status),
    )
    .toBe("listening");
  await page.evaluate(() =>
    window.sessionsFixture.telemetry("turn_started", [
      window.sessionsFixture.rows[0].rootId,
    ]),
  );
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() =>
    document.documentElement.setAttribute("data-color-mode", "dark"),
  );
  await toggle.focus();
  await page.keyboard.press("Enter");
  await settle();
  await page.screenshot({
    path: testInfo.outputPath("inline-narrow-dark.png"),
  });
  expect(
    await history.evaluate(
      (element) => element.scrollWidth <= element.clientWidth,
    ),
  ).toBe(true);
});

// Browser-only: AppShell's real inert/aria-hidden drawer and clipped desktop
// sidebar cannot be modeled by jsdom geometry or a hidden attribute substitute.
for (const width of [390, 1280]) {
  test(`Back to Sessions focuses the visible tab with the real ${width === 390 ? "closed drawer" : "collapsed sidebar"}`, async ({
    page,
  }) => {
    const errors = watchPageErrors(page);
    await page.setViewportSize({ width, height: 950 });
    await page.goto("/tests/fixtures/channel-sessions.html?shell&share");
    await expect(
      page.getByRole("textbox", { name: "Message #General" }),
    ).toBeVisible();
    if (width === 390)
      await page
        .getByRole("button", { name: "Show navigation", exact: true })
        .click();
    const sidebar = page.getByRole("complementary", {
      name: "Channel sidebar",
    });
    await sidebar
      .getByRole("button", { name: "Expand sessions in General", exact: true })
      .click();
    const origin = sidebar.getByRole("button", {
      name: "Review the release checklist",
      exact: true,
    });
    await origin.focus();
    await page.keyboard.press("Enter");
    const detail = page.getByRole("complementary", {
      name: "Session",
      exact: true,
    });
    await expect(detail).toBeVisible();
    if (width === 1280)
      await page
        .getByRole("button", { name: "Hide Channel sidebar", exact: true })
        .click();
    const navigation = page.locator("#shell-navigation");
    await expect(navigation).toHaveAttribute("inert", "");
    await expect(navigation).toHaveAttribute("aria-hidden", "true");
    if (width === 390) await expect(navigation).toBeHidden();
    else await expect(navigation).toHaveCSS("max-width", "0px");
    await detail
      .getByRole("button", { name: "Back to Sessions", exact: true })
      .click();
    const tab = page.getByRole("tab", { name: "Sessions", exact: true });
    await expect(
      page.getByRole("region", { name: "Sessions", exact: true }),
    ).toBeVisible();
    await expect(tab).toBeVisible();
    await expect(tab).toBeFocused();
    expect(errors.unexplained()).toEqual([]);
  });
}

// Real grid sizing/ellipsis and action visibility cannot be proven in jsdom.
test("long Session titles reserve one row for both header actions, including a share error", async ({
  page,
}, testInfo) => {
  await page.goto("/tests/fixtures/channel-sessions.html?share&long-title");
  await page.getByRole("tab", { name: "Sessions", exact: true }).click();
  await page
    .getByRole("region", { name: "Sessions", exact: true })
    .getByRole("button", { name: /Review the release checklist/ })
    .click();
  const detail = page.getByRole("complementary", {
    name: "Session",
    exact: true,
  });
  const title = detail.getByRole("heading", { level: 2 });
  await expect(title).toHaveText(/Review the release checklist/);
  const header = detail.locator("header").first();
  const share = header.getByRole("button", {
    name: "Share in channel",
    exact: true,
  });
  const open = header.getByRole("button", {
    name: "Open in thread",
    exact: true,
  });
  const assertOneRow = async () => {
    await expect(share).toBeVisible();
    await expect(open).toBeVisible();
    const [headingBox, shareBox, openBox, headerBox] = await Promise.all([
      title.boundingBox(),
      share.boundingBox(),
      open.boundingBox(),
      header.boundingBox(),
    ]);
    for (const box of [shareBox, openBox]) {
      expect(
        Math.abs(box.y + box.height / 2 - headingBox.y - headingBox.height / 2),
      ).toBeLessThan(1);
      expect(box.x + box.width).toBeLessThanOrEqual(
        headerBox.x + headerBox.width,
      );
    }
    expect(headingBox.x + headingBox.width).toBeLessThanOrEqual(shareBox.x);
    await expect(title).toHaveCSS("white-space", "nowrap");
    await expect(title).toHaveCSS("text-overflow", "ellipsis");
    expect(
      await title.evaluate(
        (element) => element.scrollWidth > element.clientWidth,
      ),
    ).toBe(true);
  };
  for (const width of [390, 740, 1280, 1512]) {
    await page.setViewportSize({ width, height: 850 });
    await assertOneRow();
    await page.screenshot({
      path: testInfo.outputPath(`long-session-header-${width}.png`),
    });
  }
  // A legitimate conflict keeps recovery on its own row, never displacing controls.
  await page.evaluate(() =>
    localStorage.setItem(
      `buzz-view.v1:${JSON.stringify([window.sessionsFixture.scope, "draft:general"])}`,
      JSON.stringify("Another saved draft"),
    ),
  );
  await share.click();
  const error = header.getByRole("alert");
  await expect(error).toContainText("changed in another window");
  await assertOneRow();
  const [errorBox, shareBox] = await Promise.all([
    error.boundingBox(),
    share.boundingBox(),
  ]);
  expect(errorBox.y).toBeGreaterThanOrEqual(shareBox.y + shareBox.height);
  expect(
    await page.evaluate(() => window.sessionsFixture.report.published),
  ).toEqual([]);
});
