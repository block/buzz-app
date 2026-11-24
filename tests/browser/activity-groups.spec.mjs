import { test, expect } from "./playwright-test.mjs";
import { createServer } from "./vite-server.mjs";
import { activate } from "./navigation.mjs";
import { clickRow, virtuaIdle, open } from "./timeline.mjs";
import { test as appTest } from "./fixture.mjs";
import { finalizeEvent, getPublicKey } from "nostr-tools";

test.use({ video: "on" });

test("a long relayed message fits the chat before and after opening", async ({
  page,
}) => {
  const server = await createServer({
    configFile: false,
    envFile: false,
    logLevel: "error",
    server: { host: "127.0.0.1", port: 0, strictPort: false },
  });
  await server.listen();
  const fixture = `http://127.0.0.1:${server.httpServer.address().port}/tests/fixtures/activity-groups.html`;
  try {
    await page.setViewportSize({ width: 860, height: 700 });
    await page.goto(`${fixture}?relayed`);
    const history = page.getByRole("region", {
      name: "Channel message history",
    });
    const toggle = history.getByRole("button", {
      name: /Relayed fixture update/,
    });
    const source = history.getByRole("link", {
      name: "#quarterly-infrastructure-planning-and-roadmap-review-for-all-teams",
    });
    const sourceWidth = () =>
      source.evaluate((link) => link.parentElement.clientWidth);
    const sourceFits = () =>
      source.evaluate((link) => {
        const label = link.parentElement;
        return label.scrollWidth === label.clientWidth;
      });
    const fits = () =>
      toggle.evaluate((button) => {
        const history = button.closest(
          '[aria-label="Channel message history"]',
        );
        const row = button.closest("[data-relayed]").getBoundingClientRect();
        const bounds = history.getBoundingClientRect();
        return (
          row.left >= bounds.left &&
          row.right <= bounds.right &&
          history.scrollWidth === history.clientWidth
        );
      });
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect.poll(sourceWidth).toBe(320);
    await expect.poll(sourceFits).toBe(false);
    await expect(source.locator("..")).toHaveCSS("text-overflow", "ellipsis");
    await expect.poll(fits).toBe(true);
    await page.setViewportSize({ width: 560, height: 700 });
    await expect.poll(fits).toBe(true);
    await toggle.press("Enter");
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect(
      history.getByText(
        "The complete handoff remains readable when this preview opens.",
      ),
    ).toBeVisible();
    await expect.poll(fits).toBe(true);
    await page.setViewportSize({ width: 860, height: 700 });
    await expect.poll(sourceFits).toBe(true);
    await page.setViewportSize({ width: 340, height: 700 });
    await expect.poll(sourceFits).toBe(false);
    await expect.poll(fits).toBe(true);

    await page.setViewportSize({ width: 860, height: 700 });
    await page.goto(`${fixture}?relayed=group`);
    const group = history.getByRole("button", { name: /^Show 2 messages/ });
    await expect.poll(sourceWidth).toBe(320);
    await expect.poll(sourceFits).toBe(false);
    await group.press("Enter");
    await expect.poll(sourceFits).toBe(true);
  } finally {
    await server.close();
  }
});

function observeScrollWrites(element, afterFocus) {
  const offsets = afterFocus ? [] : [element.scrollTop];
  let recording = !afterFocus;
  const record = () => {
    if (recording) offsets.push(element.scrollTop);
  };
  const start = (event) => {
    if (event.target.dataset.messageId !== afterFocus) return;
    recording = true;
    record();
    element.removeEventListener("focusin", start);
  };
  if (afterFocus) element.addEventListener("focusin", start);
  // Scroll events coalesce; record every scrollTop and scrollTo write,
  // including two owners undoing each other's movement within the same frame.
  // Virtua's scrollBy size compensation and scrollIntoView are not recorded.
  const scrollTop = Object.getOwnPropertyDescriptor(
    Element.prototype,
    "scrollTop",
  );
  const scrollTo = element.scrollTo;
  Object.defineProperty(element, "scrollTop", {
    configurable: true,
    get() {
      return scrollTop.get.call(element);
    },
    set(value) {
      scrollTop.set.call(element, value);
      record();
    },
  });
  element.scrollTo = (...args) => {
    scrollTo.apply(element, args);
    record();
  };
  return {
    reset() {
      offsets.length = 0;
      record();
    },
    stop() {
      element.removeEventListener("focusin", start);
      delete element.scrollTop;
      delete element.scrollTo;
      return offsets;
    },
  };
}

// Drive the real CSS height transition; do not depend on CI frame throughput.
async function toggleActivity(element) {
  const readable = () => {
    const preview = element.querySelector('[class*="audiencePreview"]');
    const panel = element.querySelector('[class*="audienceBody"]');
    const paragraph = panel?.querySelector("p");
    if (preview?.getClientRects().length) return true;
    if (!paragraph?.firstChild) return false;
    const range = document.createRange();
    range.setStart(paragraph.firstChild, 0);
    range.setEnd(paragraph.firstChild, 1);
    const glyph = range.getBoundingClientRect();
    const clip = panel.firstElementChild.getBoundingClientRect();
    return (
      glyph.height > 0 &&
      glyph.top >= clip.top - 0.1 &&
      glyph.bottom <= clip.bottom + 0.1
    );
  };
  const sample = () => {
    const panel = element.querySelector('[class*="audienceBody"]');
    const box = panel?.getBoundingClientRect();
    return {
      readable: readable(),
      height: box?.height ?? 0,
      width: box?.width ?? 0,
      opacity: panel ? getComputedStyle(panel).opacity : undefined,
    };
  };
  const samples = [sample()];
  const running = () =>
    element
      .querySelector('[class*="audienceBody"]')
      ?.getAnimations()
      .find((candidate) => candidate.transitionProperty === "height");
  // Capture the real CSS transition before it advances. Sampling its
  // progress explicitly keeps loaded runners from skipping the handoff.
  // Each frame also looks for it, in case its transitionrun event was missed,
  // and a toggle that starts none fails with the panel's state instead of
  // waiting out the test.
  const transition = new Promise((resolve, reject) => {
    const deadline = performance.now() + 5_000;
    let frame;
    const done = (animation) => {
      cancelAnimationFrame(frame);
      element.removeEventListener("transitionrun", capture);
      animation.pause();
      resolve(animation);
    };
    const capture = (event) => {
      if (
        event.propertyName !== "height" ||
        !event.target.className.includes("audienceBody")
      )
        return;
      const animation = running();
      if (animation) done(animation);
    };
    const poll = () => {
      const animation = running();
      if (animation) return done(animation);
      if (performance.now() < deadline) {
        frame = requestAnimationFrame(poll);
        return;
      }
      element.removeEventListener("transitionrun", capture);
      const panel = element.querySelector('[class*="audienceBody"]');
      reject(
        new Error(
          `The toggle started no height transition: ${JSON.stringify({
            connected: element.isConnected,
            expanded: element.querySelector("button").ariaExpanded,
            panel: panel && {
              attributes: panel.getAttributeNames(),
              height: getComputedStyle(panel).height,
              transition: getComputedStyle(panel).transition,
            },
          })}`,
        ),
      );
    };
    element.addEventListener("transitionrun", capture);
    frame = requestAnimationFrame(poll);
  });
  element.querySelector("button").click();
  const animation = await transition;
  try {
    const duration = Number(animation.effect.getTiming().duration);
    for (const fraction of [0, 0.25, 0.5, 0.75, 1]) {
      animation.currentTime = duration * fraction;
      await new Promise(requestAnimationFrame);
      samples.push(sample());
    }
  } finally {
    animation.play();
  }
  await animation.finished;
  await new Promise(requestAnimationFrame);
  samples.push(sample());
  return samples;
}

// The real virtualizer must measure folded zero-height entries, preserve focus
// and reading position, and reveal a message that was previously unmounted.
test("Solo activity folds, stays expanded on append/prepend, and reveals exact visits", async ({
  page,
}) => {
  const server = await createServer({
    configFile: false,
    envFile: false,
    logLevel: "error",
    server: { host: "127.0.0.1", port: 0, strictPort: false },
  });
  await server.listen();
  try {
    await page.setViewportSize({ width: 1280, height: 500 });
    await page.goto(
      `http://127.0.0.1:${server.httpServer.address().port}/tests/fixtures/activity-groups.html`,
    );
    const history = page.locator("[data-channel-timeline]");
    const messages = history.locator('[data-audience="agents"]');
    const toggle = history
      .locator("[data-activity-group-id]")
      .getByRole("button", { name: /^(Show|Collapse) activity history:/ });
    await expect(toggle).toBeVisible();
    await expect(toggle).toContainText("Activity update 15");
    await toggle.hover();
    await expect(messages).toHaveCount(0);
    await page.screenshot({
      path: test.info().outputPath("activity-collapsed.png"),
    });
    await expect(
      history.locator('[data-message-id="activity-10"]'),
    ).toHaveCount(0);
    await toggle.focus();
    await page.keyboard.press("Enter");
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect(messages).toHaveCount(16);
    await expect(toggle).toBeFocused();
    await expect
      .poll(() => history.evaluate((e) => e.scrollHeight > e.clientHeight))
      .toBe(true);
    await page.screenshot({
      path: test.info().outputPath("activity-expanded.png"),
    });
    const first = history.locator('[data-message-id="activity-0"]');
    await expect(first).toBeVisible();
    const firstStep = messages.filter({
      has: page.locator('[data-message-id="activity-0"]'),
    });
    const stepTop = await firstStep.evaluate(
      (e) => e.getBoundingClientRect().top,
    );
    await firstStep.getByRole("button", { name: /Activity update 0/ }).click();
    await expect
      .poll(() => firstStep.evaluate((e) => e.getBoundingClientRect().top))
      .toBeCloseTo(stepTop, 0);
    await expect
      .poll(() =>
        firstStep
          .locator('[class*="audienceBody"]')
          .evaluate(
            (panel) =>
              Math.abs(
                panel.getBoundingClientRect().height - panel.scrollHeight,
              ) < 1,
          ),
      )
      .toBe(true);
    await firstStep.getByRole("button", { name: /Activity update 0/ }).click();
    await expect(firstStep.locator('[class*="audienceBody"]')).toHaveCount(0);
    await virtuaIdle(page, history);
    // Appending preserves scrollback; near-bottom readers intentionally follow.
    expect(
      await history.evaluate(
        (e) => e.scrollHeight - e.clientHeight - e.scrollTop,
      ),
    ).toBeGreaterThan(80);
    const top = await first.evaluate((e) => e.getBoundingClientRect().top);
    await page.getByRole("button", { name: "Append update" }).click();
    await expect(messages).toHaveCount(17);
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect
      .poll(() => first.evaluate((e) => e.getBoundingClientRect().top))
      .toBeCloseTo(top, 0);
    await page.getByRole("button", { name: "Prepend history" }).click();
    await expect(messages).toHaveCount(18);
    const collapseHistory = history.getByRole("button", {
      name: /^Collapse activity history:/,
    });
    await collapseHistory.scrollIntoViewIfNeeded();
    await clickRow(page, collapseHistory, history);
    await expect(messages).toHaveCount(0);
    await expect(
      history.getByRole("button", { name: /^Show activity history:/ }),
    ).toBeFocused();
    await virtuaIdle(page, history);
    // The initial mount may scroll either way. Start at exact placement,
    // synchronously with focus, before late measurements can move the row.
    const revealScroll = await history.evaluateHandle(
      observeScrollWrites,
      "activity-0",
    );
    await page.getByRole("button", { name: "Visit first update" }).click();
    await expect(first).toBeVisible();
    await expect(first).toBeFocused();
    await expect(
      history.getByRole("button", { name: /^Collapse activity history:/ }),
    ).toBeVisible();
    const step = messages.filter({
      has: page.locator('[data-message-id="activity-0"]'),
    });
    const detailsToggle = step.getByRole("button", {
      name: /Activity update 0/,
    });
    // Exact navigation focuses the row before its reveal/scroll has finished.
    // Wait for it to finish before reading the recorded writes.
    await virtuaIdle(page, history);
    const offsets = await revealScroll.evaluate((observer) => observer.stop());
    await revealScroll.dispose();
    expect(offsets.length).toBeGreaterThan(0);
    // Expanding above the target can advance its offset. A retained centered
    // virtualizer scroll must not pull it back against the exact reveal hold.
    expect(
      offsets.slice(1).some((offset, index) => offset < offsets[index] - 1),
    ).toBe(false);
    // The reveal keeps this row in place while the fold expansion is still
    // measuring, and each correction restarts Virtua's pointer hold and can
    // move the row between a click's press and release. The disclosure, not
    // hit testing, is under test here; the pointer path is exercised above.
    // Opened during the fold's transitions, the detail's own transition
    // shares their frames, which a slow runner can starve below the samples
    // asserted next. Start it once the fold has finished moving.
    await expect
      .poll(() =>
        history.evaluate((e) => e.getAnimations({ subtree: true }).length),
      )
      .toBe(0);
    const opening = await step.evaluate(toggleActivity);
    await expect(detailsToggle).toHaveAttribute("aria-expanded", "true");
    const transition = opening.slice(1, -1);
    expect(transition).toHaveLength(5);
    expect(
      new Set(transition.map((sample) => Math.round(sample.height))).size,
    ).toBeGreaterThan(2);
    expect(transition.every((sample) => sample.opacity === "1")).toBe(true);
    await expect
      .poll(() =>
        step
          .locator('[class*="audienceBody"]')
          .evaluate(
            (panel) =>
              Math.abs(
                panel.getBoundingClientRect().height - panel.scrollHeight,
              ) < 1,
          ),
      )
      .toBe(true);
    await page.screenshot({
      path: test.info().outputPath("activity-details.png"),
    });
    // Measure again as soon as the reveal verifies and installs its hold,
    // while the preceding Jump's retained request would still be live.
    await history.evaluate((element) => {
      element.scrollTop = 0;
    });
    await expect(history.locator("[data-jump-to-latest]")).toBeVisible();
    await virtuaIdle(page, history);
    const retargetScroll = await history.evaluateHandle(observeScrollWrites);
    await retargetScroll.evaluate(async (observer) => {
      const element = document.querySelector("[data-channel-timeline]");
      const button = (name) =>
        [...document.querySelectorAll("button")].find(
          (candidate) => candidate.textContent.trim() === name,
        );
      await new Promise((resolve) => {
        element.addEventListener("scroll", resolve, { once: true });
        element.querySelector("[data-jump-to-latest]").click();
      });
      await new Promise((resolve) => {
        element.addEventListener("reading-positioned", resolve, { once: true });
        button("Visit first update").click();
      });
      observer.reset();
      button("Append update").click();
    });
    await expect(messages).toHaveCount(19);
    await expect(first).toBeFocused();
    await virtuaIdle(page, history);
    const retargetOffsets = await retargetScroll.evaluate((observer) =>
      observer.stop(),
    );
    await retargetScroll.dispose();
    expect(
      retargetOffsets.every(
        (offset) => Math.abs(offset - retargetOffsets[0]) <= 1,
      ),
    ).toBe(true);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await detailsToggle.click();
    await detailsToggle.click();
    await expect(step.locator('[class*="audienceBody"]')).toHaveCSS(
      "transition-duration",
      "0s",
    );
    // Virtua can start a pointer hold between press and release after the
    // detail resize. Reduced-motion behavior does not depend on hit testing.
    await activate(
      history.getByRole("button", { name: /^Collapse activity history:/ }),
    );
    const reducedToggle = history.getByRole("button", {
      name: /^Show activity history:/,
    });
    await reducedToggle.click();
    await expect(messages.first().locator("..")).toHaveCSS(
      "transition-duration",
      "0s",
    );
    await expect(
      history
        .getByRole("button", { name: /^Collapse activity history:/ })
        .locator("svg"),
    ).toHaveCSS("transition-duration", "0s");
    for (const width of [480, 800, 1280]) {
      await page.setViewportSize({ width, height: 800 });
      await page.evaluate(() => {
        document.documentElement.dataset.colorMode = "dark";
        document.documentElement.style.fontSize = "200%";
      });
      await page.getByRole("button", { name: "Visit first update" }).click();
      if ((await detailsToggle.getAttribute("aria-expanded")) === "false")
        await detailsToggle.click();
      await expect(step.locator('[class*="audienceBody"]')).toBeVisible();
      await expect
        .poll(() =>
          history.evaluate(
            (element) => element.scrollWidth <= element.clientWidth,
          ),
        )
        .toBe(true);
      await detailsToggle.click();
    }
  } finally {
    await server.close();
  }
});

test("fractional activity heights never rebound and detail collapse keeps its width", async ({
  page,
}) => {
  const server = await createServer({
    configFile: false,
    envFile: false,
    logLevel: "error",
    server: { host: "127.0.0.1", port: 0, strictPort: false },
  });
  await server.listen();
  try {
    await page.setViewportSize({ width: 1280, height: 1200 });
    await page.goto(
      `http://127.0.0.1:${server.httpServer.address().port}/tests/fixtures/activity-groups.html`,
    );
    await page.evaluate(() => {
      document.documentElement.style.fontSize = "107%";
    });
    await expect(page.locator('[data-audience="agents"]')).toHaveCount(0);
    await page.getByRole("button", { name: /^Show activity history:/ }).click();
    await expect(page.locator('[data-audience="agents"]')).toHaveCount(16);
    const step = page
      .locator('[data-audience="agents"]')
      .filter({ has: page.locator('[data-message-id="activity-0"]') });
    const toggle = step.getByRole("button", { name: /Activity update 0/ });
    await toggle.click();
    const body = step.locator('[class*="audienceBody"]');
    await expect
      .poll(() =>
        body.evaluate(
          (e) =>
            !e.getAnimations().length && e.getBoundingClientRect().height > 80,
        ),
      )
      .toBe(true);
    const closing = await step.evaluate(toggleActivity);
    expect(
      new Set(
        closing.filter((s) => s.height > 0).map((s) => Math.round(s.height)),
      ).size,
    ).toBeGreaterThan(2);
    const widths = closing.filter((s) => s.height > 0).map((s) => s.width);
    expect(Math.max(...widths) - Math.min(...widths)).toBeLessThan(1);
    expect(closing.at(-1).height).toBe(0);
    await expect(body).toHaveCount(0);
    await expect(step.locator('[class*="audiencePreview"]')).toBeVisible();
  } finally {
    await server.close();
  }
});

test("activity details keep readable text through both handoffs and survive new updates", async ({
  page,
}) => {
  const server = await createServer({
    configFile: false,
    envFile: false,
    logLevel: "error",
    server: { host: "127.0.0.1", port: 0, strictPort: false },
  });
  await server.listen();
  try {
    await page.setViewportSize({ width: 1280, height: 1000 });
    await page.goto(
      `http://127.0.0.1:${server.httpServer.address().port}/tests/fixtures/activity-groups.html`,
    );
    await page.getByRole("button", { name: /^Show activity history:/ }).click();
    const step = page
      .locator('[data-audience="agents"]')
      .filter({ has: page.locator('[data-message-id="activity-11"]') });
    await expect(step).toBeVisible();
    for (const width of [1280, 480]) {
      await page.setViewportSize({ width, height: 1000 });
      // The page sees the new size in a later rendering update, then remeasures
      // its rows and Virtua restores the reading position. A toggle clicked
      // before then opens during that reflow; in a CI WebKit run, that opening
      // never reported the height transition sampled below. Toggle at the
      // settled width.
      await expect.poll(() => page.evaluate(() => innerWidth)).toBe(width);
      await virtuaIdle(page);
      for (const open of [true, false]) {
        const painted = await step.evaluate(toggleActivity);
        expect(painted).toHaveLength(7);
        expect(painted.every((sample) => sample.readable)).toBe(true);
        await expect(
          step.getByRole("button", { name: /Activity update 11/ }),
        ).toHaveAttribute("aria-expanded", String(open));
      }
    }
    await step.getByRole("button", { name: /Activity update 11/ }).click();
    await page.getByRole("button", { name: "Append update" }).focus();
    await page.getByRole("button", { name: "Append update" }).click();
    await expect(step).toBeVisible();
    await expect(
      step.getByRole("button", { name: /Activity update 11/ }),
    ).toHaveAttribute("aria-expanded", "true");
    await expect(step.locator('[class*="audienceBody"]')).toBeVisible();
  } finally {
    await server.close();
  }
});

appTest.describe("contained reply branches", () => {
  appTest.use({
    productionBroker: true,
    readState: true,
    historyCounts: { alpha: 1, beta: 0 },
  });

  appTest(
    "nested replies collapse with the pointer and restore keyboard focus",
    async ({ page, app }) => {
      const names = [
        "Builder",
        "Reviewer",
        "Researcher",
        "Writer",
        "Planner",
        "Tester",
        "Reader",
        "Helper",
      ];
      const keys = names.map((_, index) =>
        Uint8Array.from({ length: 32 }, (_, i) => (i === 31 ? 10 + index : 0)),
      );
      const agents = keys.map(getPublicKey);
      keys.forEach((key, index) => {
        app.serveProfile(key, { name: names[index], is_agent: true });
      });
      await page.route("**/agent-library", (route) =>
        route.fulfill({
          json: {
            definitions: [],
            identities: agents.map((pubkey, index) => ({
              pubkey,
              name: names[index],
            })),
          },
        }),
      );
      const root = app.sign({
        kind: 9,
        created_at: 1700000100,
        content: "A result with contained activity replies",
        tags: [["h", "alpha"]],
      });
      const step = (content, created_at, index = 0) =>
        finalizeEvent(
          {
            kind: 9,
            created_at,
            content,
            tags: [
              ["h", "alpha"],
              ["e", root.id, "", "reply"],
              ["audience", "agents"],
              ["p", agents[(index + 1) % agents.length]],
            ],
          },
          keys[index],
        );
      const first = step("Inspect the original source", 1700000101);
      const nested = app.sign({
        kind: 9,
        created_at: 1700000102,
        content: "Original branch replies remain available.",
        tags: [
          ["h", "alpha"],
          ["e", root.id, "", "root"],
          ["e", first.id, "", "reply"],
        ],
      });
      const history = app.histories.get("primary/alpha");
      history.splice(
        0,
        history.length,
        root,
        first,
        nested,
        ...agents
          .slice(1)
          .map((_, index) =>
            step(
              `Findings from ${names[index + 1]}`,
              1700000103 + index,
              index + 1,
            ),
          ),
      );
      await page.setViewportSize({ width: 860, height: 950 });
      await open(page, app);
      app.threadSummary(root.id, [...agents, app.viewer], 9);
      await page
        .locator(`[data-channel-timeline] [data-message-id="${root.id}"]`)
        .getByRole("button", { name: /^View thread:/ })
        .click();
      const thread = page.getByRole("complementary", {
        name: "Thread",
        exact: true,
      });
      await thread
        .getByRole("button", { name: /^Show activity history:/ })
        .click();
      const summary = thread.getByRole("button", {
        name: "View 1 reply",
        exact: true,
      });
      const reply = thread.getByText(nested.content, { exact: true });
      for (const width of [860, 1440]) {
        await page.setViewportSize({ width, height: 950 });
        await summary.click();
        await expect(reply).toBeVisible();
        await thread
          .getByRole("button", { name: "Collapse 1 reply", exact: true })
          .click();
        await expect(reply).toBeHidden();
        await expect(summary).toBeFocused();
        // Every participant adds a transcript action. Pointer collapse must
        // remain usable even when those actions need to wrap in a Side pane.
        await thread
          .getByRole("button", { name: /^Collapse activity history:/ })
          .click();
        const showHistory = thread.getByRole("button", {
          name: /^Show activity history:/,
        });
        await expect(showHistory).toBeFocused();
        await expect(summary).toBeHidden();
        await showHistory.click();
        await expect(summary).toBeVisible();
      }
    },
  );
});
