import { test, expect } from "./fixture.mjs";
import { open } from "./timeline.mjs";

test.use({
  productionBroker: true,
  readState: true,
  threadUnread: true,
  pluginFixtures: true,
  historyCounts: { alpha: 3, beta: 1 },
});

async function replyActions(page, row) {
  const trigger = row.getByRole("button", {
    name: "Open reply actions",
    exact: true,
  });
  if (await trigger.count()) {
    await trigger.click();
    return page.getByRole("dialog", { name: "Reply actions", exact: true });
  }
  await row.hover();
  return row;
}

// Browser-only boundary: real composer -> signing broker -> live nested row;
// layout/focus at different panel widths, and routed reveal through collapsed DOM.
test("nested replies send, stay open, and reveal through links at readable panel widths", async ({
  page,
  app,
}) => {
  await open(page, app);
  const root = app.histories
    .get("primary/alpha")
    .find((event) => event.content === "Thread root 0");
  await page
    .locator(`[data-channel-timeline] [data-message-id="${root.id}"]`)
    .getByRole("button", { name: /^View thread:/ })
    .click();
  const panel = page.getByRole("complementary", {
    name: "Thread",
    exact: true,
  });
  const editor = panel.getByRole("textbox", {
    name: "Reply to thread",
    exact: true,
  });
  const parent = panel
    .locator("[data-message-id]")
    .filter({ hasText: "Unread reply 0" });
  const history = panel.getByRole("region", { name: "Thread messages" });
  await expect(panel.locator('[data-depth="-1"]')).toHaveCount(0);
  await expect(
    panel.getByRole("button", { name: "Hide thread replies", exact: true }),
  ).toHaveCount(0);
  // Ordinary replies are direct siblings, not children of a collapsible panel.
  await expect(
    history.locator(":scope > ol > li").filter({
      has: page
        .locator("[data-message-id]")
        .filter({ hasText: "Unread reply 0" }),
    }),
  ).toHaveCount(1);
  const ordinaryGeometry = await parent.evaluate((node) => {
    const item = node.closest("li");
    const root = node
      .closest('[aria-label="Thread messages"]')
      .querySelector("[data-message-id]");
    return {
      rootLeft: root.getBoundingClientRect().left,
      replyLeft: node.getBoundingClientRect().left,
      connector: getComputedStyle(item, "::after").content,
    };
  });
  expect(ordinaryGeometry.replyLeft).toBe(ordinaryGeometry.rootLeft);
  expect(ordinaryGeometry.connector).toBe("none");
  await panel.screenshot({
    path: test.info().outputPath("ordinary-thread-replies.png"),
  });
  await editor.fill("Nested browser reply");
  await parent.hover();
  await parent.getByRole("button", { name: "Reply", exact: true }).click();
  await expect(editor).toHaveText("Nested browser reply");
  let rejected;
  await page.route("**/api/relay/**/publish", async (route) => {
    const event = route.request().postDataJSON();
    if (!rejected && event.content === "Nested browser reply") {
      rejected = event;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          accepted: false,
          event_id: event.id,
          message: "Fixture rejection",
        }),
      });
    } else await route.continue();
  });
  await editor.press("Enter");
  const failed = panel
    .locator("[data-message-id]")
    .filter({ hasText: "Nested browser reply" });
  await expect(
    failed.getByText("Couldn’t send this message.", { exact: true }),
  ).toBeVisible({ timeout: 15000 });
  await failed.getByRole("button", { name: "Retry", exact: true }).click();
  await expect
    .poll(
      () =>
        app.report.publications.filter(
          ({ event }) => event?.content === "Nested browser reply",
        ).length,
    )
    .toBe(1);
  const nested = app.report.publications.find(
    ({ event }) => event?.content === "Nested browser reply",
  ).event;
  // Compare signed wire fields, not the verifier’s local symbol cache.
  expect(JSON.parse(JSON.stringify(nested))).toEqual(rejected);
  expect(nested.tags.filter(([key]) => key === "e")).toEqual([
    ["e", root.id, "", "root"],
    ["e", await parent.getAttribute("data-message-id"), "", "reply"],
  ]);
  const nestedRow = panel.locator(`[data-message-id="${nested.id}"]`);
  await expect(nestedRow).toBeInViewport();
  // Nested ancestry has a quiet elbow even when the author continues.
  const connector = await nestedRow.evaluate(
    (node) => getComputedStyle(node.closest("li"), "::before").content,
  );
  expect(connector).toBe('""');

  await expect(
    panel.getByRole("button", { name: "Cancel reply target" }),
  ).toHaveCount(0);
  await (await replyActions(page, nestedRow))
    .getByRole("button", { name: "Reply", exact: true })
    .click();
  await expect(editor).toBeFocused();
  // Main's Up-to-edit shares this composer; cancel must retain the nested target
  // and the native draft history, rather than sending the draft to the root.
  await editor.fill("Unsent nested draft");
  await editor.fill("");
  await editor.press("ArrowUp");
  const editInput = panel.getByRole("textbox", {
    name: "Edit message",
    exact: true,
  });
  await expect(editInput).toBeFocused();
  await expect(editInput).toHaveJSProperty("value", "Nested browser reply");
  await expect(
    panel.getByRole("button", { name: "Cancel reply target" }),
  ).toHaveCount(0);
  await editInput.press("Escape");
  await expect(editor).toBeFocused();
  await expect(
    panel.getByRole("button", { name: "Cancel reply target" }),
  ).toBeVisible();
  await editor.press("ControlOrMeta+z");
  await expect(editor).toHaveJSProperty("value", "Unsent nested draft");
  await editor.fill("Grandchild browser reply");
  let releaseGrandchild;
  let grandchildRequested = false;
  const grandchildGate = new Promise((resolve) => {
    releaseGrandchild = resolve;
  });
  await page.route("**/api/relay/**/publish", async (route) => {
    if (route.request().postDataJSON().content === "Grandchild browser reply") {
      grandchildRequested = true;
      await grandchildGate;
      await route.continue();
    } else await route.fallback();
  });
  await editor.press("Enter");
  try {
    const pending = panel
      .locator("[data-message-id]")
      .filter({ hasText: "Grandchild browser reply" });
    await expect(pending.locator('[data-layout="thread"]')).toBeVisible();
    await expect.poll(() => grandchildRequested).toBe(true);
    await expect(
      (await replyActions(page, pending)).getByRole("button", {
        name: "Reply",
        exact: true,
      }),
    ).toBeDisabled();
    await page.keyboard.press("Escape");
    await expect(
      pending.getByRole("button", { name: "Open reply actions" }),
    ).toBeFocused();
    // Inspecting the pending row intentionally moved focus away from composing.
    await editor.focus();
  } finally {
    releaseGrandchild();
  }
  await expect
    .poll(() =>
      app.report.publications.some(
        ({ event }) => event?.content === "Grandchild browser reply",
      ),
    )
    .toBe(true);
  const grandchild = app.report.publications.find(
    ({ event }) => event?.content === "Grandchild browser reply",
  ).event;
  expect(grandchild.tags.filter(([key]) => key === "e")).toEqual([
    ["e", root.id, "", "root"],
    ["e", nested.id, "", "reply"],
  ]);
  const grandchildRow = panel.locator(`[data-message-id="${grandchild.id}"]`);
  await expect(grandchildRow).toBeInViewport();
  await expect(editor).toBeFocused();
  // Crossing into a nested branch repeats the author, even for own consecutive sends.
  await expect(grandchildRow.locator('[data-layout="thread"]')).toBeVisible();
  await expect(grandchildRow.locator("time")).toBeVisible();
  await editor.focus();
  await expect(
    panel.getByRole("button", { name: /Hide replies|Collapse this branch/ }),
  ).toHaveCount(0);
  await expect(nestedRow).toBeVisible();
  await expect(grandchildRow).toBeVisible();

  let deepest = grandchildRow;
  for (let depth = 0; depth < 6; depth++) {
    await editor.hover();
    await (await replyActions(page, deepest))
      .getByRole("button", { name: "Reply", exact: true })
      .click();
    await expect(editor).toBeFocused();
    const content = `Deep reply ${depth}`;
    await editor.fill(content);
    await editor.press("Enter");
    await expect
      .poll(() =>
        app.report.publications.some(({ event }) => event?.content === content),
      )
      .toBe(true);
    const event = app.report.publications.find(
      ({ event }) => event?.content === content,
    ).event;
    deepest = panel.locator(`[data-message-id="${event.id}"]`);
    await expect(deepest).toBeInViewport();
  }
  // Include phone widths with the persistent sidebar still visible.
  for (const width of [1492, 1280, 1024, 524, 522, 480, 390]) {
    await page.setViewportSize({ width, height: 950 });
    await deepest.scrollIntoViewIfNeeded();
    const geometry = await panel.evaluate((element) => {
      const history = element.querySelector('[aria-label="Thread messages"]');
      return { width: history.clientWidth, scroll: history.scrollWidth };
    });
    expect(geometry.scroll).toBeLessThanOrEqual(geometry.width + 1);
    await expect(
      panel.getByRole("button", { name: /Hide replies|Collapse this branch/ }),
    ).toHaveCount(0);
    const deepestBox = await deepest.boundingBox();
    expect(deepestBox.width).toBeGreaterThan(140);
    const capped = deepest.locator(
      'xpath=ancestor::*[@data-depth and @data-open="true"][1]',
    );
    const spine = await capped.evaluate((node) => {
      const message = node.firstElementChild;
      return {
        stub: getComputedStyle(message, "::after").display,
        offset: getComputedStyle(message, "::after").left,
      };
    });
    expect(spine.stub).not.toBe("none");
    expect(parseFloat(spine.offset)).toBeLessThan(0);

    for (const theme of ["light", "dark"]) {
      await page.evaluate(
        (mode) =>
          document.documentElement.setAttribute("data-color-mode", mode),
        theme,
      );
      await panel.screenshot({
        path: test.info().outputPath(`nested-${width}-${theme}.png`),
      });
    }
  }
  await page.setViewportSize({ width: 1440, height: 950 });
  await panel
    .getByRole("button", { name: "Close thread", exact: true })
    .click();
  const linked = app.append(
    "primary",
    "alpha",
    `Open <buzz://message?channel=alpha&id=${grandchild.id}>`,
  );
  const linkRow = page.locator(
    `[data-channel-timeline] [data-message-id="${linked.id}"]`,
  );
  await linkRow.getByRole("link", { name: "Alpha", exact: true }).click();
  await expect(grandchildRow).toBeInViewport();
  await expect(grandchildRow).toBeFocused();
  await expect
    .poll(() => page.evaluate(() => window.fixtureNavigation.snapshot().status))
    .toBe("opened");
  // Opened branches remain open through live arrivals and ordinary sends.
  app.reply(root.id);
  await expect(
    panel.getByText("New peer reply", { exact: true }),
  ).toBeVisible();
  await expect(grandchildRow).toBeVisible();
  await expect(parent).toBeVisible();
  // Sending to the thread must not disturb an opened nested branch.
  await editor.fill("Own ordinary thread reply");
  await editor.press("Enter");
  await expect(
    panel.getByText("Own ordinary thread reply", { exact: true }),
  ).toBeInViewport();
  // The optimistic row is visible before relay acceptance. Keep the production
  // subscription alive until publication and delivery settle, then end the test.
  await expect
    .poll(() =>
      app.report.publications.some(
        ({ event }) => event?.content === "Own ordinary thread reply",
      ),
    )
    .toBe(true);
  await expect(grandchildRow).toBeVisible();
  await expect(nestedRow).toBeVisible();
  await expect(parent).toBeVisible();
  const finalReply = app.report.publications.find(
    ({ event }) => event?.content === "Own ordinary thread reply",
  ).event;
  await expect(
    panel
      .locator(`[data-message-id="${finalReply.id}"]`)
      .getByRole("button", { name: "Reply", exact: true }),
  ).toBeEnabled();
});

test("an exact linked reply stays readable when its parent is outside loaded history", async ({
  page,
  app,
}) => {
  const root = app.histories
    .get("primary/alpha")
    .find((event) => event.content === "Thread root 0");
  // Peer-authored rows never enter this viewer's persistent outbox. The bounded
  // history contains the child and root, but not the intermediate parent.
  const child = app.append(
    "primary",
    "alpha",
    "Exact orphan reply",
    false,
    false,
    root.id,
    "a".repeat(64),
  );
  const link = app.append(
    "primary",
    "alpha",
    `Open <buzz://message?channel=alpha&id=${child.id}>`,
    false,
  );
  await open(page, app);
  await page
    .locator(`[data-channel-timeline] [data-message-id="${link.id}"]`)
    .getByRole("link", { name: "Alpha", exact: true })
    .click();
  const panel = page.getByRole("complementary", {
    name: "Thread",
    exact: true,
  });
  const orphan = panel.locator(`[data-message-id="${child.id}"]`);
  await expect(orphan).toBeFocused();
  await expect(orphan).toBeInViewport();
  await expect(
    panel.getByText("Earlier reply unavailable in loaded history.", {
      exact: true,
    }),
  ).toBeVisible();
});

test.describe("touch branch controls", () => {
  test.use({ hasTouch: true, viewport: { width: 390, height: 844 } });
  test("expands with a visible touch target and removes it once open", async ({
    page,
    app,
  }) => {
    await open(page, app);
    const root = app.histories
      .get("primary/alpha")
      .find((event) => event.content === "Thread root 0");
    const thread = page
      .locator(`[data-channel-timeline] [data-message-id="${root.id}"]`)
      .getByRole("button", { name: /^View thread:/ });
    // This case exercises touch controls inside the thread, not the virtualized feed's pointer lock.
    await thread.focus();
    await thread.press("Enter");
    const panel = page.getByRole("complementary", {
      name: "Thread",
      exact: true,
    });
    const summary = panel.getByRole("button", { name: /^View 1 reply/ });
    await expect(summary).toContainText("(1 new)");
    await summary.tap();
    await expect(summary).toHaveCount(0);
    await expect(
      panel.getByRole("button", { name: /Hide replies|Collapse this branch/ }),
    ).toHaveCount(0);
    const history = panel.getByRole("region", { name: "Thread messages" });
    const geometry = await history.evaluate((node) => ({
      width: node.clientWidth,
      scroll: node.scrollWidth,
    }));
    expect(geometry.scroll).toBeLessThanOrEqual(geometry.width + 1);
    const branch = panel.locator('[data-depth="0"][data-open="true"]').first();
    const child = branch.locator(":scope > [id] [data-message-id]").first();
    await expect(child).toBeFocused();
    await expect(child).toBeVisible();
    const actionTrigger = child.getByRole("button", {
      name: "Open reply actions",
    });
    await actionTrigger.tap();
    const actions = page.getByRole("dialog", {
      name: "Reply actions",
      exact: true,
    });
    await actions
      .getByRole("button", { name: "Add reaction", exact: true })
      .tap();
    await expect(
      page.getByRole("dialog", { name: "Emoji picker", exact: true }),
    ).toBeVisible();
    const emojiSearch = page.locator('em-emoji-picker input[type="search"]');
    await expect(emojiSearch).toBeFocused();
    await emojiSearch.press("Escape");
    await expect(
      page.getByRole("dialog", { name: "Emoji picker", exact: true }),
    ).toHaveCount(0);
    await expect(actions).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(actionTrigger).toBeFocused();
    await actionTrigger.tap();
    await actions.getByRole("button", { name: "More message actions" }).tap();
    await expect(
      page.getByRole("menuitem", { name: "Copy message", exact: true }),
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("menu")).toHaveCount(0);
    await expect(actions).toBeVisible();
    await actions.getByRole("button", { name: "Reply", exact: true }).tap();
    await expect(
      panel.getByRole("textbox", { name: "Reply to thread" }),
    ).toBeFocused();
    await expect(
      panel.getByRole("button", { name: "Cancel reply target" }),
    ).toBeVisible();
    await page.emulateMedia({ reducedMotion: "reduce" });
    const motion = await branch.locator(":scope > [id]").evaluate((node) => ({
      transition: getComputedStyle(node).transitionDuration,
      animation: getComputedStyle(node).animationDuration,
    }));
    expect(motion).toEqual({ transition: "0s", animation: "0s" });

    app.reply(root.id);
    await expect(
      panel.getByText("New peer reply", { exact: true }),
    ).toBeVisible();
    await expect(child).toBeVisible();
    await expect(summary).toHaveCount(0);
  });
});

// Real pointer hit testing and focus cannot be verified in jsdom.
for (const width of [1492, 1280, 1024, 390])
  test(`crowded capped branches expand once with readable actions at ${width}`, async ({
    page,
    app,
  }) => {
    const root = app.histories
      .get("primary/alpha")
      .find((e) => e.content === "Thread root 0");
    let parent = root.id;
    const ids = [];
    for (let i = 0; i < 13; i++) {
      parent = app.append(
        "primary",
        "alpha",
        `Crowded reply ${i}`,
        false,
        i < 9 ? i % 2 === 0 : true,
        root.id,
        parent,
      ).id;
      ids.push(parent);
    }
    const continuation = app.append(
      "primary",
      "alpha",
      "Same-parent continuation",
      false,
      true,
      root.id,
      ids.at(-2),
    );
    await open(page, app);
    await page
      .locator(`[data-channel-timeline] [data-message-id="${root.id}"]`)
      .getByRole("button", { name: /^View thread:/ })
      .click();
    const panel = page.getByRole("complementary", {
      name: "Thread",
      exact: true,
    });
    const branchFor = (id) =>
      panel.locator(`[data-message-id="${id}"]`).locator("../..");
    const expandAll = async () => {
      for (const id of ids.slice(0, -1)) {
        const branch = branchFor(id);
        if ((await branch.getAttribute("data-open")) === "false")
          await branch
            .locator(":scope > div")
            .nth(1)
            .getByRole("button")
            .press("Enter");
        await expect(
          panel.locator(`[data-message-id="${ids[ids.indexOf(id) + 1]}"]`),
        ).toBeFocused();
      }
    };
    await page.setViewportSize({ width, height: 950 });
    await expandAll();
    // Retain the existing continuation-clock contract on a real same-parent
    // sibling now that crossing a branch deliberately repeats the author.
    const continuationRow = panel.locator(
      `[data-message-id="${continuation.id}"]`,
    );
    await expect(
      continuationRow.locator('[data-layout="continuation"]'),
    ).toBeVisible();
    const clock = continuationRow.locator("time");
    await panel.getByRole("textbox", { name: "Reply to thread" }).focus();
    await panel.getByRole("heading", { name: "Thread", exact: true }).hover();
    await expect(clock).toHaveCSS("opacity", "0");
    await continuationRow.hover();
    await expect(clock).toHaveCSS("opacity", "1");
    await clock.hover();
    await expect(page.getByRole("tooltip")).toContainText(/\d{4}/);
    await continuationRow
      .getByRole("button", { name: "Open reply actions" })
      .focus();
    await panel.getByRole("heading", { name: "Thread", exact: true }).hover();
    await expect(clock).toHaveCSS("opacity", "1");
    for (const id of [...ids.slice(0, -1), continuation.id]) {
      const branch = branchFor(id);
      const row = panel.locator(`[data-message-id="${id}"]`);
      await panel.getByRole("textbox", { name: "Reply to thread" }).focus();
      await panel.getByRole("heading", { name: "Thread", exact: true }).hover();
      await row.scrollIntoViewIfNeeded();
      // Put a row at the scrollport edge: actions must remain reachable there.
      await row.evaluate((node) => {
        const history = node.closest('[aria-label="Thread messages"]');
        history.scrollTop +=
          node.getBoundingClientRect().top -
          history.getBoundingClientRect().top;
      });
      const restingHeight = (await row.boundingBox()).height;
      await row.hover();
      expect((await row.boundingBox()).height).toBe(restingHeight);
      const compact = row.getByRole("button", { name: "Open reply actions" });
      const isNested = id !== ids[0];
      await expect(compact).toHaveCount(isNested ? 1 : 0);
      const actions = isNested
        ? compact
        : row.getByRole("group", { name: "Message actions" });
      await expect(actions).toHaveCSS("opacity", "1");
      for (const button of isNested
        ? [compact]
        : await actions.getByRole("button").all()) {
        await expect(button).toBeInViewport();
        await button.click({ trial: true });
      }
      // Test rendered text fragments, not a block whose empty area may overlap.
      // Hover actions must leave this row's own message and its neighbor readable.
      await expect
        .poll(() =>
          row.evaluate((node) => {
            const tray = node
              .querySelector(
                '[aria-label="Open reply actions"], [aria-label="Message actions"]',
              )
              .getBoundingClientRect();
            const walker = document.createTreeWalker(
              node.closest('[aria-label="Thread messages"]'),
              NodeFilter.SHOW_TEXT,
            );
            for (let text = walker.nextNode(); text; text = walker.nextNode()) {
              if (
                !/^(Crowded reply|Same-parent continuation)/.test(
                  text.textContent,
                )
              )
                continue;
              const range = document.createRange();
              range.selectNodeContents(text);
              for (const rect of range.getClientRects()) {
                if (
                  tray.left < rect.right &&
                  tray.right > rect.left &&
                  tray.top < rect.bottom &&
                  tray.bottom > rect.top
                )
                  return true;
              }
            }
            return false;
          }),
        )
        .toBe(false);
      if (isNested) {
        await compact.click();
        const popup = page.getByRole("dialog", {
          name: "Reply actions",
          exact: true,
        });
        await expect(
          popup.getByRole("button", { name: "Reply", exact: true }),
        ).toBeVisible();
        for (const button of await popup.getByRole("button").all()) {
          await expect(button).toBeInViewport();
          await button.click({ trial: true });
        }
        await page.keyboard.press("Escape");
        await expect(compact).toBeFocused();
      }
      await expect(
        branch.getByRole("button", {
          name: /Hide replies|Collapse this branch/,
        }),
      ).toHaveCount(0);
    }
    await panel.getByRole("textbox", { name: "Reply to thread" }).focus();
    await panel.getByRole("heading", { name: "Thread", exact: true }).hover();
    for (const id of ids.slice(0, 1)) {
      await expect(
        panel
          .locator(`[data-message-id="${id}"]`)
          .getByRole("group", { name: "Message actions" }),
      ).toHaveCSS("opacity", "0");
    }
    await panel.screenshot({
      path: test.info().outputPath(`crowded-${width}.png`),
    });
  });
