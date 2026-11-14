import { test, expect } from "./fixture.mjs";
import {
  open,
  settle,
  anchor,
  expectAnchor,
  wheel,
  virtuaIdle,
} from "./timeline.mjs";
import { openThreadLink } from "./message-actions.mjs";

test.use({ historyCounts: { alpha: 30, beta: 1 }, developmentReact: true });

// Browser-only: the virtual row can extend beyond the centered reading column.
test("reply holds ignore both gutters outside the message list", async ({
  page,
  app,
}) => {
  await page.goto(
    `${app.origin}/#buzz=${encodeURIComponent(
      JSON.stringify({
        version: 1,
        kind: "conversation",
        channelId: "alpha",
        scope: {
          viewer: app.viewer,
          communityOrigin: "https://primary.example",
        },
      }),
    )}`,
  );
  const history = page.locator('[data-channel-timeline="alpha"]');
  const last = app.histories.get("primary/alpha").at(-1);
  const row = history.locator(`[data-message-id="${last.id}"]`);
  const prose = row.locator("p").first();
  await expect(prose).toBeInViewport();
  await virtuaIdle(page, history);
  const column = await row
    .locator("[data-highlight-surface]")
    .first()
    .boundingBox();
  const viewport = await history.boundingBox();
  const text = await prose.boundingBox();
  expect(column.x - viewport.x).toBeGreaterThan(20);
  expect(viewport.x + viewport.width - column.x - column.width).toBeGreaterThan(
    20,
  );
  await page.clock.install();
  const cancel = page.getByRole("button", {
    name: "Cancel reply target",
    exact: true,
  });
  for (const x of [
    (viewport.x + column.x) / 2,
    (column.x + column.width + viewport.x + viewport.width) / 2,
  ]) {
    await page.mouse.move(x, text.y + text.height / 2);
    await page.mouse.down();
    await page.clock.runFor(150);
    await page.mouse.up();
    await expect(cancel).toHaveCount(0);
  }
  await prose.hover();
  await page.mouse.down();
  await page.clock.runFor(150);
  await expect(cancel).toBeVisible();
  await page.mouse.up();
});

// Browser-only: reply transitions must preserve real composer/scrollport geometry.
// A DOM emulator cannot prove that the clicked message stays at its reading Y.
test("holding to reply near the bottom preserves the reading position and Escape cancels", async ({
  page,
  app,
}) => {
  await open(page, app);
  const input = page.getByRole("textbox", {
    name: "Message #Alpha",
    exact: true,
  });
  await input.fill("Keep this draft");
  const editor = await input.evaluateHandle((element) => element);
  const history = page.getByRole("region", { name: "Channel message history" });
  const last = app.histories.get("primary/alpha").at(-1);
  const message = history
    .locator(`[data-message-id="${last.id}"]`)
    .locator("p")
    .first();
  await expect(message).toBeInViewport();
  await settle(page, history);
  const before = await anchor(page);
  const motion = await history.evaluateHandle((element, before) => {
    let frame;
    const drift = [];
    const sample = () => {
      const row = element.querySelector(`[data-message-id="${before.id}"] p`);
      drift.push(
        row
          ? Math.abs(
              row.getBoundingClientRect().top -
                element.getBoundingClientRect().top -
                before.y,
            )
          : Infinity,
      );
      frame = requestAnimationFrame(sample);
    };
    sample();
    return {
      stop() {
        cancelAnimationFrame(frame);
        return drift;
      },
    };
  }, before);
  await message.hover();
  await page.mouse.down();
  await expect(
    page.getByRole("button", { name: "Cancel reply target" }),
  ).toBeVisible();
  await page.mouse.up();
  await expect(page.getByRole("textbox")).toBeFocused();
  await expect(
    page.getByRole("button", { name: "Cancel reply target" }),
  ).toBeVisible();
  expect(await editor.evaluate((element) => element.isConnected)).toBe(true);
  await expect(page.getByRole("textbox")).toHaveText("Keep this draft");
  await settle(page, history);
  await expectAnchor(page, before);
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("button", { name: "Cancel reply target" }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("textbox", { name: "Message #Alpha", exact: true }),
  ).toBeFocused();
  await settle(page, history);
  await expectAnchor(page, before);
  await expect(input).toHaveText("Keep this draft");
  // Reverse the preview motion before it finishes, as with quick repeated replies.
  for (let cycle = 0; cycle < 2; cycle++) {
    await message.hover();
    await page.mouse.down();
    await expect(
      page.getByRole("button", { name: "Cancel reply target" }),
    ).toBeVisible();
    await page.mouse.up();
    await expect(
      page.getByRole("button", { name: "Cancel reply target" }),
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(
      page.getByRole("button", { name: "Cancel reply target" }),
    ).toHaveCount(0);
  }
  await settle(page, history);
  expect(await editor.evaluate((element) => element.isConnected)).toBe(true);
  await editor.dispose();
  const drift = await motion.evaluate((tracker) => tracker.stop());
  await motion.dispose();
  expect(
    Math.max(...drift),
    "reading anchor stays still throughout the transition",
  ).toBeLessThan(4);
});

// Native selection and scroll-follow ownership require real layout in both hosts.
test.describe("provisional reply cancellation", () => {
  const pagedChannel = "22222222-2222-4222-8222-222222222222";
  test.use({
    productionBroker: true,
    readState: true,
    threadUnread: true,
    inboxThreadWindow: true,
    channelIds: ["alpha", "beta", pagedChannel],
    channelNames: { [pagedChannel]: "Window room" },
  });
  for (const surface of ["channel", "thread", "paged thread"]) {
    for (const cancellation of [
      "selection",
      "selection with pending arrivals",
      "scroll",
      "slow scroll",
      "shallow scroll",
    ]) {
      if (cancellation === "slow scroll" && surface !== "channel") continue;
      if (
        surface === "paged thread" &&
        cancellation !== "selection with pending arrivals"
      )
        continue;
      test(`${surface}: ${cancellation} cancels the preview and preserves reading intent on arrival`, async ({
        page,
        app,
      }) => {
        await open(page, app);
        const root =
          surface === "paged thread"
            ? app.inboxWindow.root
            : surface === "thread"
              ? app.histories
                  .get("primary/alpha")
                  .find((row) => row.content === "Thread root 1")
              : app.histories.get("primary/alpha").at(-1);
        let history = page.getByRole("region", {
          name: "Channel message history",
          exact: true,
        });
        let input = page
          .getByRole("article", { name: "Conversation", exact: true })
          .getByRole("textbox");
        let last = root;
        if (surface === "paged thread") {
          // More than the newest strict page; older history must remain unloaded.
          app.histories.set(`primary/${pagedChannel}`, [root]);
          app.inboxWindow.replies.length = 0;
          for (let index = 0; index < 60; index++) {
            app.inboxWindow.replies.push(
              app.append(
                "primary",
                pagedChannel,
                `Peer message ${index} with selectable prose.\n\nSecond paragraph fills the newest page.\n\nThird paragraph keeps older history out of view.`,
                false,
                false,
                root.id,
                undefined,
                [],
                root.created_at + 100 + index,
              ),
            );
          }
          last = app.inboxWindow.replies.at(-3);
          await page
            .locator(`button[data-channel-id="${pagedChannel}"]`)
            .click();
          await openThreadLink(page, app, root.id, pagedChannel);
        }
        if (surface === "thread") {
          // Enough rows for real upward scrolling; no pagination or scale claim.
          for (let index = 0; index < 24; index++) {
            const reply = app.reply(root.id, false, false);
            if (index === 20) last = reply;
          }
          await history
            .locator(`[data-message-id="${root.id}"]`)
            .getByRole("button", { name: /^View thread:/ })
            .click();
        }
        if (surface !== "channel") {
          history = page.getByRole("region", {
            name: "Thread messages",
            exact: true,
          });
          input = page
            .getByRole("complementary", { name: "Thread", exact: true })
            .getByRole("textbox");
          await expect(history).toHaveAttribute("aria-busy", "false");
        }
        if (surface === "paged thread") {
          expect(
            app.pending.filter(({ filter }) => filter.thread_window),
          ).toHaveLength(0);
          await expect(
            history.locator(
              `[data-message-id="${app.inboxWindow.replies[0].id}"]`,
            ),
          ).toHaveCount(0);
        }
        await input.fill("Keep this draft");
        const prose = history
          .locator(`[data-message-id="${last.id}"] p`)
          .first();
        await expect(prose).toBeInViewport();
        await virtuaIdle(page, history);
        const bottomGap = () =>
          history.evaluate(
            (element) =>
              element.scrollHeight - element.clientHeight - element.scrollTop,
          );
        await expect.poll(bottomGap).toBeLessThan(4);
        const points = await prose.evaluate((element) => {
          const text = element.firstChild;
          const point = (offset) => {
            const range = document.createRange();
            range.setStart(text, offset);
            range.setEnd(text, offset + 1);
            const box = range.getBoundingClientRect();
            const result = { x: box.x + 1, y: box.y + box.height / 2 };
            if (
              !element.contains(document.elementFromPoint(result.x, result.y))
            )
              throw new Error("Selection starts on exposed message prose");
            return result;
          };
          return { start: point(1), end: point(12) };
        });
        const selecting = cancellation.startsWith("selection");
        const pendingArrivals =
          cancellation === "selection with pending arrivals";
        const proseY = await prose.evaluate(
          (element) => element.getBoundingClientRect().top,
        );
        const append = (index) =>
          surface !== "channel"
            ? app.reply(root.id)
            : app.append(
                "primary",
                "alpha",
                `Peer arrival ${index}`,
                true,
                false,
              );
        await page.mouse.move(points.start.x, points.start.y);
        await page.mouse.down();
        try {
          await expect(
            page.getByRole("button", { name: "Cancel reply target" }),
          ).toBeVisible();
          await expect(input).not.toBeFocused();
          if (pendingArrivals) {
            let arrival;
            for (let index = 0; index < 3; index++) arrival = append(index);
            await expect(
              history.locator(`[data-message-id="${arrival.id}"]`),
            ).toBeAttached();
            await settle(page, history);
          }
          if (selecting)
            await page.mouse.move(points.end.x, points.end.y, { steps: 8 });
          else {
            // A preview's reflow scrollend must not stand in for wheel completion.
            await settle(page, history);
            await expect(
              page.getByRole("button", { name: "Cancel reply target" }),
            ).toBeVisible();
            if (cancellation === "slow scroll") {
              await wheel(page, -20, history);
              await expect.poll(bottomGap).toBeGreaterThan(0);
              await wheel(page, -330, history);
            } else
              await wheel(
                page,
                cancellation === "shallow scroll" ? -20 : -350,
                history,
              );
          }
        } finally {
          await page.mouse.up();
        }
        if (selecting) {
          await expect
            .poll(() =>
              prose.evaluate((element) => {
                const selection = document.getSelection();
                return (
                  !!selection?.toString() &&
                  element.contains(selection.anchorNode) &&
                  element.contains(selection.focusNode)
                );
              }),
            )
            .toBe(true);
        } else if (cancellation === "shallow scroll") {
          // wheel() observes native scrollend before settling layout. Channels
          // resume their existing <80px follow policy; threads retain the
          // upward reading intent until downward input or Jump to latest.
          await expect.poll(bottomGap).toBeGreaterThan(0);
          await expect.poll(bottomGap).toBeLessThan(80);
        } else {
          await expect.poll(bottomGap).toBeGreaterThan(250);
        }
        await expect(
          page.getByRole("button", { name: "Cancel reply target" }),
        ).toHaveCount(0);
        await expect(input).toHaveText("Keep this draft");
        await expect(input).not.toBeFocused();
        await settle(page, history);
        if (pendingArrivals) {
          expect(
            Math.abs(
              (await prose.evaluate(
                (element) => element.getBoundingClientRect().top,
              )) - proseY,
            ),
            "native selection keeps the held prose in place",
          ).toBeLessThan(4);
        }
        const before = await history.evaluate((element) => {
          const top = element.getBoundingClientRect().top;
          const row = [...element.querySelectorAll("[data-message-id]")].find(
            (row) => row.getBoundingClientRect().top >= top,
          );
          return {
            id: row.dataset.messageId,
            y: row.getBoundingClientRect().top - top,
          };
        });
        let latest;
        for (let index = 0; index < 3; index++) latest = append(index + 3);
        const arrival = history.locator(`[data-message-id="${latest.id}"]`);
        if (
          (selecting && !pendingArrivals) ||
          (cancellation === "shallow scroll" && surface === "channel")
        ) {
          await expect(arrival).toBeInViewport();
          await settle(page, history);
          await expect.poll(bottomGap).toBeLessThan(4);
          await expect(
            page.getByRole("button", { name: /^\d+ new messages?$/ }),
          ).toHaveCount(0);
        } else {
          // A rendered arrival closes delivery before checking no jump. Strict
          // windows retain their existing uncounted Jump to latest control.
          await expect(arrival).toBeAttached();
          await expect(
            page.getByRole("button", {
              name:
                surface === "paged thread"
                  ? "Jump to latest"
                  : pendingArrivals
                    ? "6 new messages"
                    : "3 new messages",
              exact: true,
            }),
          ).toBeVisible();
          await settle(page, history);
          await expect(arrival).not.toBeInViewport();
          await expect
            .poll(() =>
              history.evaluate((element, before) => {
                const row = element.querySelector(
                  `[data-message-id="${before.id}"]`,
                );
                return row
                  ? Math.abs(
                      row.getBoundingClientRect().top -
                        element.getBoundingClientRect().top -
                        before.y,
                    )
                  : Infinity;
              }, before),
            )
            .toBeLessThan(4);
        }
      });
    }
  }
});
