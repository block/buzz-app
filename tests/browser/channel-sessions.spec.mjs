import { test, expect } from "./source-fixture.mjs";

// Browser-only proof: real Cordis -> ChannelsPage -> ThreadPanel wiring, native
// tab/row focus, full-width geometry and independent scroll in both engines.
test("shared preview coexists with private Sessions, opens the existing full-width thread and restores keyboard focus", async ({
  page,
}) => {
  await page.clock.setFixedTime(new Date("2026-09-21T14:00:00Z"));
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
      .locator("header strong")
      .first(),
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
      .locator("header strong")
      .first(),
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
  });
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
      // Capture the final host theme, not an in-flight button color transition.
      await page.mouse.move(0, 0);
      await expect
        .poll(() =>
          directory
            .getByRole("button", { name: "Refresh loaded history" })
            .evaluate((button) => {
              const probe = document.createElement("span");
              probe.style.color = "var(--text-primary)";
              probe.style.backgroundColor = "var(--neutral-2)";
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
      await expect(detail.getByText(/repl(?:y|ies) shown/)).toHaveCount(0);
      const inset = width > 1000 ? 32 : width > 650 ? 24 : 16;
      expect(
        await detail.evaluate((element) => ({
          border: getComputedStyle(element).borderTopWidth,
          radius: getComputedStyle(element).borderTopLeftRadius,
          shadow: getComputedStyle(element).boxShadow,
        })),
      ).toEqual({ border: "0px", radius: "0px", shadow: "none" });
      const box = await detail.boundingBox();
      const composer = await detail.locator("form").boundingBox();
      const root = await detail
        .locator("[data-message-id]")
        .first()
        .boundingBox();
      const title = await detail.getByRole("heading").boundingBox();
      expect(
        await detail.getByRole("heading").evaluate((element) => ({
          size: getComputedStyle(element).fontSize,
          leading: getComputedStyle(element).lineHeight,
        })),
      ).toEqual({ size: "24px", leading: "24px" });
      expect(
        await detail
          .getByRole("region", { name: "Session messages" })
          .evaluate((element) => element.scrollTop),
      ).toBe(0);

      expect(Math.abs(composer.x - box.x - inset)).toBeLessThan(1);
      expect(Math.abs(root.x - composer.x)).toBeLessThan(1);
      expect(root.y - title.y - title.height).toBeGreaterThanOrEqual(32);
      expect(root.y - title.y - title.height).toBeLessThanOrEqual(48);
      expect(
        Math.abs(box.y + box.height - composer.y - composer.height - 24),
      ).toBeLessThan(1);
      const heading = await page
        .getByRole("article", { name: "Conversation" })
        .locator(":scope > header")
        .boundingBox();
      const tabs = await page
        .getByRole("tablist", { name: "Channel views" })
        .boundingBox();
      const channelTitle = await page
        .getByRole("article", { name: "Conversation" })
        .locator("header strong")
        .first()
        .boundingBox();
      if (width > 1100) {
        expect(Math.abs(heading.height - 80)).toBeLessThan(1);
        expect(
          Math.abs(
            tabs.y + tabs.height / 2 - channelTitle.y - channelTitle.height / 2,
          ),
        ).toBeLessThan(1);
      } else {
        expect(tabs.y).toBeGreaterThanOrEqual(
          channelTitle.y + channelTitle.height,
        );
      }
      expect(
        await detail.evaluate(
          (element) => element.scrollWidth <= element.clientWidth,
        ),
      ).toBe(true);
      await page.screenshot({
        path: testInfo.outputPath(`session-detail-${width}-${mode}.png`),
      });
      await detail.getByRole("button", { name: "Back to Sessions" }).click();
    }
  }
});

// One added journey: native rich-editor mention selection/focus, independent draft
// navigation and quiet timeline geometry. Recovery permutations stay in Vitest.
test("header New session selects an agent explicitly, opens the shared thread and keeps its parent timeline quiet", async ({
  page,
}) => {
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
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
    .getByRole("region", { name: "Mention a channel member" })
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
      .getByRole("region", { name: "Sessions" })
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
            probe.style.color = "var(--text-primary)";
            document.body.append(probe);
            const expected = getComputedStyle(probe).color;
            probe.remove();
            return getComputedStyle(button).color === expected;
          }),
      )
      .toBe(true);
    await expect
      .poll(async () => {
        const tab = await page
          .getByRole("tab", { name: "Sessions", exact: true })
          .boundingBox();
        const indicator = await page
          .locator(".buzz-tabs-indicator")
          .boundingBox();
        return (
          Math.abs(tab.x - indicator.x) + Math.abs(tab.width - indicator.width)
        );
      })
      .toBeLessThan(1);
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
  const errors = [];
  for (const p of [page, other, lockPage])
    p.on("pageerror", (error) => errors.push(String(error)));
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
      .getByRole("region", { name: "Mention a channel member" })
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
  // Reopen both editors for a second legitimate draft. Queue acceptance cleanup
  // before the stale claimant so its acquisition sees an absent creation record.
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
    .getByRole("region", { name: "Mention a channel member" })
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
  try {
    await page.evaluate(() => window.publicationGate.release());
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
      .toBeGreaterThan(0);
    const queued = await lockPage.evaluate(
      async (name) =>
        (await navigator.locks.query()).pending.filter(
          (lock) => lock.name === name,
        ).length,
      lockName,
    );
    await other
      .getByRole("button", { name: "Send message", exact: true })
      .click();
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
      .toBe(queued + 1);
  } finally {
    await lockPage.evaluate(() => window.releaseClaim());
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
  expect(errors).toEqual([]);
});

// New browser boundary: real contenteditable chip/caret, clipboard source and
// undo after the editor DOM is removed, plus signed publication wiring.
test("Share in channel keeps the draft and exact recipients, edits one canonical chip and sends only on explicit Send", async ({
  page,
}, testInfo) => {
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  await page.goto("/tests/fixtures/channel-sessions.html?share");
  const input = page.getByRole("textbox", { name: "Message #General" });
  await expect(input).toBeVisible();
  await input.fill("Some context ");
  const recipient = await page.evaluate(() => window.sessionsFixture.viewer);
  const rootAgent = await page.evaluate(() => window.sessionsFixture.member);
  await page
    .getByRole("button", { name: "Mention a member", exact: true })
    .click();
  await page
    .getByRole("region", { name: "Mention a channel member" })
    .getByRole("button", { name: `Fixture reader ${recipient}`, exact: true })
    .click();
  const before = await input.evaluate((element) => element.value);
  await page.getByRole("tab", { name: "Sessions", exact: true }).click();
  await expect(input).toHaveCount(0);
  await page
    .getByRole("region", { name: "Sessions" })
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
  const shared = await input.evaluate((element) => element.value);
  expect(shared.startsWith(before)).toBe(true);
  await expect(input.locator('[data-link-kind="session"]')).toHaveCount(1);
  await expect(input.locator("a,button")).toHaveCount(0);
  expect(await input.evaluate((element) => element.selectionStart)).toBe(
    shared.length,
  );
  await page.keyboard.press("ControlOrMeta+z");
  await expect(input).toHaveJSProperty("value", before);
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
      await expect(input.locator('[data-link-kind="session"]')).toBeVisible();
      await expect
        .poll(() =>
          input.evaluate((element) => ({
            scroll: element.scrollWidth,
            client: element.clientWidth,
            chip: element
              .querySelector('[data-link-kind="session"]')
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
  expect(clipboard).toBe(shared);
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
  await expect(input.locator('[data-link-kind="session"]')).toHaveCount(1);
  // Double-click selects the complete source token for native replacement.
  await input.locator('[data-link-kind="session"]').dblclick();
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
  await expect(input.locator('[data-link-kind="session"]')).toHaveText(
    "SessionRevised Review the release checklist",
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
  const target = JSON.parse(new URL(href).searchParams.get("target"));
  const root = await page.evaluate(() => window.sessionsFixture.rows[0].rootId);
  expect(target).toMatchObject({
    kind: "conversation",
    channelId: "general",
    messageId: root,
    threadRootId: root,
  });
  expect(target.scope).toEqual({ communityOrigin: "https://sessions.example" });
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
  expect(event.content).toBe(`${shared}Please review.`);
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
      .getByRole("region", { name: "Sessions" })
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
      .getByRole("region", { name: "Sessions" })
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
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
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
            probe.style.color = "var(--text-secondary)";
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
      .getByRole("region", { name: "Mention a channel member" })
      .getByRole("button", { name: `Fixture member ${member}`, exact: true })
      .click();
    await page.keyboard.type(body);
  };
  await compose(prompt);
  await page.evaluate(() => {
    window.publicationGate = window.sessionsFixture.holdPublication();
  });
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  try {
    await page.evaluate(() => window.publicationGate.started);
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
